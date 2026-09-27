import fs from "node:fs";
import { Worker, isMainThread, parentPort, threadId, workerData } from "node:worker_threads";
import type { Worker as WorkerHandle } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SESSION_ACTION_IDS } from "./domain/session-actions.js";
import {
  DomainError,
  EXIT_CODES,
  failure,
  success,
  type DomainResult,
  type JsonObject,
  type JsonValue,
} from "./domain/errors.js";
import type { SessionBackend, SessionContext } from "./domain/session.js";
import type { GitCommandRunner } from "./git.js";
import {
  listControlRepositories,
  openRepositoryLocator,
  readRepositoryLocators,
  repositoryKey,
  type RepositoryLocator,
} from "./control-repositories.js";
import { repositoryScreenModelFromRuntimeSnapshot } from "./ui/repository-terminal.js";
import {
  parseSessionDiscardPreview,
  type SessionActionConfirmation,
  type SessionActionId,
  type SessionActionToken,
} from "./ui/session-actions.js";
import { createLocalSessionBackend } from "./domain/session-backend.js";
import { RepositoryLock } from "./registry/lock.js";

export const MAX_CONTROL_REQUEST_BYTES = 256 * 1024;
const MAX_SESSION_ID_CODE_POINTS = 256;
const MAX_OPERATION_ID_CODE_POINTS = 256;
const WORKER_COUNT = 2;
const MAX_QUEUED_REQUESTS = 4;
const WORKER_STARTUP_TIMEOUT_MS = 10_000;
const WORKER_ROLE = "nawabari-control-request";

export type ControlReply = { readonly status: number; readonly body: JsonObject };

export type ControlRequestAction = {
  readonly action_id: SessionActionId;
  readonly token: SessionActionToken;
  readonly confirmation: SessionActionConfirmation;
};

export type ControlApiRequest = {
  readonly method: string;
  readonly segments: readonly string[];
  readonly contentType?: string;
  readonly body?: unknown;
  readonly bodyFailure?: "too-large" | "invalid-json";
};

export type ControlRequestBody = {
  readonly body?: unknown;
  readonly bodyFailure?: "too-large" | "invalid-json";
};

export type CanonicalLockObservation = {
  readonly phase: "acquire-start" | "acquire-finish";
  readonly lockPath: string;
  readonly requestId: number;
  readonly workerThreadId: number;
};

type ActionRequest = ControlRequestAction;

type WorkItem = {
  readonly id: number;
  readonly request: ControlApiRequest;
  readonly catalogPath: string;
};

type WorkerMessage =
  | { readonly type: "ready" }
  | { readonly type: "need-body"; readonly requestId: number }
  | {
      readonly type: "lock";
      readonly phase: CanonicalLockObservation["phase"];
      readonly lockPath: string;
      readonly requestId: number;
      readonly workerThreadId: number;
    }
  | { readonly type: "complete"; readonly requestId: number; readonly reply: ControlReply }
  | { readonly type: "failed"; readonly requestId: number; readonly message: string };

type WorkerInput =
  | { readonly type: "execute"; readonly item: WorkItem }
  | { readonly type: "body-result"; readonly requestId: number; readonly result: ControlRequestBody };

type QueuedWork = WorkItem & {
  readonly resolve: (reply: ControlReply) => void;
  readonly reject: (error: unknown) => void;
  readonly readBody?: () => Promise<ControlRequestBody>;
};

type WorkerSlot = {
  readonly worker: WorkerHandle;
  ready: boolean;
  readonly readyPromise: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: unknown) => void;
  active?: QueuedWork;
  dead: boolean;
};

export function transportError(
  status: number,
  code: DomainError["code"],
  message: string,
  details?: JsonObject,
): ControlReply {
  return { status, body: { ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } } };
}

/** Transport-only status mapping; the domain error body is preserved verbatim. */
export function controlStatusForError(error: DomainError): number {
  if (error.code === "SESSION_NOT_FOUND") return 404;
  if (error.code === "INVALID_SESSION_ID" || error.exitCode === EXIT_CODES.usage) return 400;
  if (error.code === "INTERNAL_ERROR") return 500;
  if (error.exitCode === EXIT_CODES.unavailable) return 503;
  return 409;
}

function domainReply<T>(result: DomainResult<T>, project: (value: T) => JsonObject): ControlReply {
  if (result.ok) return { status: 200, body: { ok: true, ...project(result.value) } };
  return transportError(
    controlStatusForError(result.error),
    result.error.code,
    result.error.message,
    result.error.details ?? undefined,
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum && !/\p{Cc}/u.test(value);
}

/** Accept only the existing typed action contract; no free-form command input exists. */
export function parseControlActionRequest(input: unknown): DomainResult<ActionRequest> {
  const invalid = (field: string, reason: string) =>
    failure(new DomainError("INVALID_ARGUMENT", `Invalid action request field '${field}': ${reason}.`, { field }));
  if (!isPlainObject(input)) return invalid("body", "expected an object");
  for (const key of Object.keys(input)) {
    if (key !== "action_id" && key !== "token" && key !== "confirmation") return invalid(key, "unknown field");
  }
  if (typeof input.action_id !== "string" || !SESSION_ACTION_IDS.some((actionId) => actionId === input.action_id)) {
    return invalid("action_id", "expected a typed lifecycle action ID");
  }
  if (!isPlainObject(input.token)) return invalid("token", "expected the current action token object");
  const confirmationInput = input.confirmation ?? { confirmed: false };
  if (!isPlainObject(confirmationInput) || typeof confirmationInput.confirmed !== "boolean") {
    return invalid("confirmation", "expected { confirmed: boolean }");
  }
  for (const key of Object.keys(confirmationInput)) {
    if (key !== "confirmed" && key !== "operation_id" && key !== "preview") {
      return invalid(`confirmation.${key}`, "unknown field");
    }
  }
  let confirmation: SessionActionConfirmation = { confirmed: false };
  if (confirmationInput.confirmed) {
    const operationId = confirmationInput.operation_id;
    if (operationId !== undefined && !boundedText(operationId, MAX_OPERATION_ID_CODE_POINTS)) {
      return invalid("confirmation.operation_id", "expected bounded text");
    }
    let preview;
    if (confirmationInput.preview !== undefined) {
      const parsed = parseSessionDiscardPreview(confirmationInput.preview);
      if (!parsed.ok) return parsed;
      preview = parsed.value;
    }
    confirmation = {
      confirmed: true,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
      ...(preview === undefined ? {} : { preview }),
    };
  } else if (confirmationInput.operation_id !== undefined || confirmationInput.preview !== undefined) {
    return invalid("confirmation", "operation_id and preview require confirmed: true");
  }
  return success({
    action_id: input.action_id as SessionActionId,
    token: input.token as unknown as SessionActionToken,
    confirmation,
  });
}

function resolveRepository(
  key: string,
  catalogPath: string,
  git?: GitCommandRunner,
): DomainResult<{ locator: RepositoryLocator; context: SessionContext }> {
  const locators = readRepositoryLocators(catalogPath);
  if (!locators.ok) return locators;
  const locator = locators.value.find((entry) => repositoryKey(entry.repository_id) === key);
  const opened =
    locator === undefined
      ? failure(new DomainError("NOT_GIT_REPOSITORY", "Unknown locally known repository.", { repository_key: key }))
      : openRepositoryLocator(locator, git);
  if (!opened.ok || locator === undefined) return opened as DomainResult<never>;
  return success({ locator, context: { cwd: opened.value.cwd } });
}

const repositoryIdentity = (locator: RepositoryLocator): JsonObject => ({
  repository_key: repositoryKey(locator.repository_id),
  repository_id: locator.repository_id,
  worktree_path: locator.worktree_path,
});

/** Execute one authenticated repository API request through the supplied canonical backend. */
export async function executeControlApiRequest(
  request: ControlApiRequest,
  options: { readonly backend: SessionBackend; readonly catalogPath: string; readonly git?: GitCommandRunner },
  readBody?: () => Promise<ControlRequestBody>,
): Promise<ControlReply> {
  const { method, segments } = request;
  const [, , resource, key, child, sessionId, leaf, ...extra] = segments;
  if (resource !== "repositories" || extra.length > 0) {
    return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
  }
  if (key === undefined) {
    if (method !== "GET") return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");
    return domainReply(listControlRepositories(options.catalogPath, options.git), (repositories) => ({
      repositories: repositories as unknown as JsonValue,
    }));
  }
  const repository = resolveRepository(key, options.catalogPath, options.git);
  if (!repository.ok) {
    return repository.error.code === "NOT_GIT_REPOSITORY"
      ? transportError(404, repository.error.code, repository.error.message, repository.error.details ?? undefined)
      : domainReply(repository, () => ({}));
  }
  const { locator, context } = repository.value;
  if (child === "snapshot" && sessionId === undefined) {
    if (method !== "GET") return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");
    if (options.backend.repositoryRuntimeSnapshot === undefined) {
      return transportError(503, "BACKEND_UNAVAILABLE", "Repository runtime snapshot capability is not available.");
    }
    const snapshot = await options.backend.repositoryRuntimeSnapshot(context);
    if (!snapshot.ok) return domainReply(snapshot, () => ({}));
    const view = repositoryScreenModelFromRuntimeSnapshot(snapshot.value);
    return domainReply(view, (model) => ({
      repository: repositoryIdentity(locator),
      snapshot: snapshot.value as unknown as JsonObject,
      view: model as unknown as JsonObject,
    }));
  }
  if (child !== "sessions" || sessionId === undefined || !boundedText(sessionId, MAX_SESSION_ID_CODE_POINTS)) {
    return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
  }
  if (leaf !== undefined && leaf !== "actions") return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
  const expectedMethod = leaf === "actions" ? "POST" : "GET";
  if (method !== expectedMethod) return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");

  let actionRequest: ActionRequest | undefined;
  if (leaf === "actions") {
    if (request.contentType !== "application/json") {
      return transportError(415, "INVALID_ARGUMENT", "Mutation requests accept application/json only.");
    }
    const requestBody =
      request.body !== undefined || request.bodyFailure !== undefined || readBody === undefined
        ? request
        : await readBody();
    if (requestBody.bodyFailure === "too-large") {
      return transportError(413, "INVALID_ARGUMENT", "Request body exceeds the bounded size.", {
        maximum_bytes: MAX_CONTROL_REQUEST_BYTES,
      });
    }
    if (requestBody.bodyFailure === "invalid-json") {
      return transportError(400, "INVALID_ARGUMENT", "Request body is not valid JSON.");
    }
    const parsed = parseControlActionRequest(requestBody.body);
    if (!parsed.ok) return domainReply(parsed, () => ({}));
    actionRequest = parsed.value;
  }

  // One dispatcher per request, as in the CLI: nothing is replayed from
  // server memory and every action revalidates current authority.
  const dispatcher = options.backend.sessionActions?.(context);
  if (dispatcher === undefined) {
    return transportError(503, "BACKEND_UNAVAILABLE", "Typed session action capability is not available.");
  }
  const session = await options.backend.getSession(context, sessionId);
  if (!session.ok) return domainReply(session, () => ({}));
  const identity = {
    session_id: session.value.session_id,
    repository: session.value.repository,
    worktree: session.value.worktree,
  };
  if (actionRequest === undefined) {
    const actionSnapshot = await dispatcher.readSessionActionSnapshot(identity);
    return {
      status: 200,
      body: {
        ok: true,
        repository: repositoryIdentity(locator),
        session: session.value as unknown as JsonObject,
        action_snapshot: actionSnapshot.ok ? (actionSnapshot.value as unknown as JsonObject) : null,
        ...(actionSnapshot.ok
          ? {}
          : { action_snapshot_error: { code: actionSnapshot.error.code, message: actionSnapshot.error.message } }),
      },
    };
  }
  const result = await dispatcher.dispatchSessionAction(
    actionRequest.action_id,
    identity,
    actionRequest.token,
    actionRequest.confirmation,
  );
  return domainReply(result, (value) => ({
    repository: repositoryIdentity(locator),
    result: value as unknown as JsonObject,
  }));
}

function workerEntryUrl(): URL {
  const currentUrl = new URL(import.meta.url);
  const currentPath = fileURLToPath(currentUrl);
  if (currentPath.endsWith(".ts")) return currentUrl;
  const sourcePath = currentPath.replace(/\.js$/u, ".ts");
  return fs.existsSync(sourcePath) ? pathToFileURL(sourcePath) : currentUrl;
}

function workerExecArgv(entryUrl: URL): string[] {
  return fileURLToPath(entryUrl).endsWith(".ts") ? ["--import", fileURLToPath(import.meta.resolve("tsx/esm"))] : [];
}

/** Fixed-size request isolation for synchronous repository Git/lock work. */
export class ControlRequestPool {
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: QueuedWork[] = [];
  private nextId = 1;
  private outstanding = 0;
  private accepting = true;
  private stoppingWorkers = false;
  private closePromise: Promise<void> | undefined;
  private readyPromise: Promise<void> | undefined;
  private drainWaiters: (() => void)[] = [];

  public constructor(
    private readonly options: {
      readonly onLockAcquire?: (observation: CanonicalLockObservation) => void;
    } = {},
  ) {}

  public ready(): Promise<void> {
    this.readyPromise ??= this.startWorkers();
    return this.readyPromise;
  }

  /** `undefined` means the bounded active-plus-queued capacity is exhausted. */
  public dispatch(
    request: ControlApiRequest,
    catalogPath: string,
    readBody?: () => Promise<ControlRequestBody>,
  ): Promise<ControlReply> | undefined {
    if (
      !this.accepting ||
      this.slots.every((slot) => slot.dead) ||
      this.outstanding >= WORKER_COUNT + MAX_QUEUED_REQUESTS
    ) {
      return undefined;
    }
    const id = this.nextId++;
    this.outstanding += 1;
    return new Promise<ControlReply>((resolve, reject) => {
      this.queue.push({ id, request, catalogPath, resolve, reject, ...(readBody === undefined ? {} : { readBody }) });
      this.schedule();
    });
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.accepting = false;
    this.closePromise = new Promise<void>((resolve) => {
      const finish = async () => {
        this.stoppingWorkers = true;
        await Promise.all(this.slots.map((slot) => slot.worker.terminate().then(() => undefined)));
        resolve();
      };
      if (this.outstanding === 0) void finish();
      else this.drainWaiters.push(() => void finish());
    });
    return this.closePromise;
  }

  private async startWorkers(): Promise<void> {
    try {
      for (let index = 0; index < WORKER_COUNT; index += 1) this.slots.push(this.createSlot());
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all(this.slots.map((slot) => slot.readyPromise)).then(() => undefined),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Control Server request worker startup timed out.")),
              WORKER_STARTUP_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    } catch (error: unknown) {
      await this.close();
      throw error;
    }
  }

  private createSlot(): WorkerSlot {
    const entryUrl = workerEntryUrl();
    const worker = new Worker(entryUrl, {
      workerData: { role: WORKER_ROLE, observeLockAcquires: this.options.onLockAcquire !== undefined },
      execArgv: workerExecArgv(entryUrl),
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const slot: WorkerSlot = { worker, ready: false, readyPromise, resolveReady, rejectReady, dead: false };
    worker.on("message", (message: WorkerMessage) => this.onMessage(slot, message));
    worker.on("error", (error: unknown) => this.failSlot(slot, error));
    worker.on("exit", (code) => {
      if (!this.stoppingWorkers && !slot.dead) {
        this.failSlot(slot, new Error(`Control Server request worker exited (${code}).`));
      } else {
        slot.dead = true;
      }
    });
    return slot;
  }

  private onMessage(slot: WorkerSlot, message: WorkerMessage): void {
    if (message.type === "ready") {
      slot.ready = true;
      slot.resolveReady();
      return;
    }
    if (message.type === "lock") {
      this.options.onLockAcquire?.(message);
      return;
    }
    const active = slot.active;
    if (active === undefined || active.id !== message.requestId) return;
    if (message.type === "need-body") {
      if (active.readBody === undefined) {
        slot.worker.postMessage({ type: "body-result", requestId: active.id, result: { bodyFailure: "invalid-json" } });
        return;
      }
      void active.readBody().then(
        (result) => {
          try {
            slot.worker.postMessage({ type: "body-result", requestId: active.id, result });
          } catch (error: unknown) {
            this.failSlot(slot, error);
          }
        },
        () => {
          try {
            slot.worker.postMessage({
              type: "body-result",
              requestId: active.id,
              result: { bodyFailure: "invalid-json" },
            });
          } catch (error: unknown) {
            this.failSlot(slot, error);
          }
        },
      );
      return;
    }
    slot.active = undefined;
    if (message.type === "complete") active.resolve(message.reply);
    else if (message.type === "failed") active.reject(new Error(message.message));
    this.finishWork();
    this.schedule();
  }

  private failSlot(slot: WorkerSlot, error: unknown): void {
    if (slot.dead) return;
    slot.dead = true;
    if (!slot.ready) slot.rejectReady(error);
    if (slot.active !== undefined) {
      slot.active.resolve(
        transportError(503, "BACKEND_UNAVAILABLE", "The isolated Control Server request worker is unavailable."),
      );
      slot.active = undefined;
      this.finishWork();
    }
    if (this.slots.every((candidate) => candidate.dead)) {
      for (const queued of this.queue.splice(0)) {
        queued.resolve(
          transportError(503, "BACKEND_UNAVAILABLE", "The isolated Control Server request workers are unavailable."),
        );
        this.finishWork();
      }
    }
    this.schedule();
  }

  private finishWork(): void {
    this.outstanding -= 1;
    if (this.outstanding === 0) {
      for (const resolve of this.drainWaiters.splice(0)) resolve();
    }
  }

  private schedule(): void {
    for (const slot of this.slots) {
      if (!slot.ready || slot.dead || slot.active !== undefined) continue;
      const item = this.queue.shift();
      if (item === undefined) return;
      slot.active = item;
      const input: WorkerInput = {
        type: "execute",
        item: { id: item.id, request: item.request, catalogPath: item.catalogPath },
      };
      try {
        slot.worker.postMessage(input);
      } catch (error: unknown) {
        this.failSlot(slot, error);
      }
    }
  }
}

function observeCanonicalLockAcquires(): void {
  const acquireSync = RepositoryLock.prototype.acquireSync;
  RepositoryLock.prototype.acquireSync = function (this: RepositoryLock) {
    const requestId = activeRequestId;
    const lockPath = this.lockPath;
    if (requestId !== undefined) {
      parentPort?.postMessage({ type: "lock", phase: "acquire-start", lockPath, requestId, workerThreadId: threadId });
    }
    try {
      return acquireSync.call(this);
    } finally {
      if (requestId !== undefined) {
        parentPort?.postMessage({
          type: "lock",
          phase: "acquire-finish",
          lockPath,
          requestId,
          workerThreadId: threadId,
        });
      }
    }
  };
}

let activeRequestId: number | undefined;

if (!isMainThread && isPlainObject(workerData) && workerData.role === WORKER_ROLE && parentPort !== null) {
  if (workerData.observeLockAcquires === true) observeCanonicalLockAcquires();
  const backend = createLocalSessionBackend();
  const bodyWaiters = new Map<number, (result: ControlRequestBody) => void>();
  parentPort.postMessage({ type: "ready" });
  parentPort.on("message", (message: WorkerInput) => {
    if (message.type === "body-result") {
      bodyWaiters.get(message.requestId)?.(message.result);
      bodyWaiters.delete(message.requestId);
      return;
    }
    activeRequestId = message.item.id;
    void executeControlApiRequest(
      message.item.request,
      {
        backend,
        catalogPath: message.item.catalogPath,
      },
      () =>
        new Promise<ControlRequestBody>((resolve) => {
          bodyWaiters.set(message.item.id, resolve);
          parentPort?.postMessage({ type: "need-body", requestId: message.item.id });
        }),
    )
      .then((reply) => parentPort?.postMessage({ type: "complete", requestId: message.item.id, reply }))
      .catch((error: unknown) =>
        parentPort?.postMessage({
          type: "failed",
          requestId: message.item.id,
          message: error instanceof Error ? error.message : "Unexpected Control Server worker failure.",
        }),
      )
      .finally(() => {
        activeRequestId = undefined;
        bodyWaiters.delete(message.item.id);
      });
  });
}
