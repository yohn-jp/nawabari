import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
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
import { resolveCliCommandDefinition } from "./cli-command-registry.js";
import {
  listControlRepositories,
  openRepositoryLocator,
  readRepositoryLocators,
  repositoryKey,
  type RepositoryLocator,
} from "./control-repositories.js";
import { renderControlWebDocument } from "./control-web.js";
import {
  acquireControlServerLease,
  defaultControlServerOperationalDirectory,
  type ControlServerLease,
} from "./control-server-lease.js";
import { repositoryScreenModelFromRuntimeSnapshot } from "./ui/repository-terminal.js";
import {
  parseSessionDiscardPreview,
  type SessionActionConfirmation,
  type SessionActionId,
  type SessionActionToken,
} from "./ui/session-actions.js";

/**
 * Machine-local Control Server: a transport/presentation adapter over the
 * existing per-repository backends. It owns only ephemeral listener/token
 * state; every read re-projects canonical state and every mutation goes
 * through the repository's own SessionActionDispatcher.
 */
export const CONTROL_SERVER_SCHEMA = "control-server.v1" as const;
export const CONTROL_SERVER_HOST = "127.0.0.1" as const;
export const DEFAULT_CONTROL_SERVER_PORT = 47_471 as const;
export const CONTROL_TOKEN_HEADER = "x-nawabari-control-token" as const;
export const MAX_CONTROL_REQUEST_BYTES = 256 * 1024;
const MAX_SESSION_ID_CODE_POINTS = 256;
const MAX_OPERATION_ID_CODE_POINTS = 256;

export type ControlServerOptions = {
  /** 0 selects an ephemeral port; the CLI only accepts 1..65535. */
  readonly port: number;
  readonly backend: SessionBackend;
  readonly catalogPath: string;
  readonly git?: GitCommandRunner;
  /** Internal test seam; production uses a stable per-user operational path. */
  readonly operationalDirectory?: string;
};

export type ControlServer = {
  readonly port: number;
  readonly url: string;
  /** Host-only, owner-readable bootstrap artifact for the trusted operator. */
  readonly credentialFile: string;
  close(): Promise<void>;
};

type Reply = { readonly status: number; readonly body: JsonObject };

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
});

function actionIds(): readonly string[] {
  return (
    resolveCliCommandDefinition("session action")?.options.find((option) => option.name === "--action")?.values ?? []
  );
}

function transportError(status: number, code: DomainError["code"], message: string, details?: JsonObject): Reply {
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

function domainReply<T>(result: DomainResult<T>, project: (value: T) => JsonObject): Reply {
  if (result.ok) return { status: 200, body: { ok: true, ...project(result.value) } };
  return transportError(
    controlStatusForError(result.error),
    result.error.code,
    result.error.message,
    result.error.details ?? undefined,
  );
}

function sameSecret(expected: string, supplied: string | string[] | undefined): boolean {
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type HostCredentialArtifact = { readonly directory: string; readonly file: string };

/**
 * Use the per-user runtime directory when the OS provides one. The fallback
 * is the host temporary directory, which protected sessions replace with a
 * private tmpfs instead of mounting from the host.
 */
function hostCredentialDirectory(): string {
  if (process.platform === "linux" && typeof process.getuid === "function") {
    const runtime = `/run/user/${process.getuid()}`;
    try {
      const stat = fs.lstatSync(runtime);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0) {
        return runtime;
      }
    } catch {
      // Fall back to host /tmp, which is replaced by a private tmpfs in the
      // protected runtime and is therefore outside its filesystem view.
    }
    return "/tmp";
  }
  return os.tmpdir();
}

function createHostCredentialArtifact(token: string): HostCredentialArtifact {
  const directory = fs.mkdtempSync(path.join(hostCredentialDirectory(), "nawabari-control-"));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "credential");
    const descriptor = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(descriptor, `${token}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(file, 0o600);
    return { directory, file };
  } catch (error: unknown) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= maximum && !/\p{Cc}/u.test(value);
}

type ActionRequest = {
  readonly action_id: SessionActionId;
  readonly token: SessionActionToken;
  readonly confirmation: SessionActionConfirmation;
};

/** Accept only the existing typed action contract; no free-form command input exists. */
export function parseControlActionRequest(input: unknown): DomainResult<ActionRequest> {
  const invalid = (field: string, reason: string) =>
    failure(new DomainError("INVALID_ARGUMENT", `Invalid action request field '${field}': ${reason}.`, { field }));
  if (!isPlainObject(input)) return invalid("body", "expected an object");
  for (const key of Object.keys(input)) {
    if (key !== "action_id" && key !== "token" && key !== "confirmation") return invalid(key, "unknown field");
  }
  if (typeof input.action_id !== "string" || !actionIds().includes(input.action_id)) {
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

class RequestBodyTooLarge extends Error {}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CONTROL_REQUEST_BYTES) throw new RequestBodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_CONTROL_REQUEST_BYTES) throw new RequestBodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startControlServer(options: ControlServerOptions): Promise<DomainResult<ControlServer>> {
  let lease: ControlServerLease;
  try {
    lease = await acquireControlServerLease({
      directory: options.operationalDirectory ?? defaultControlServerOperationalDirectory(),
    });
  } catch (error: unknown) {
    return failure(
      error instanceof DomainError
        ? error
        : new DomainError("BACKEND_UNAVAILABLE", "The Control Server singleton lease could not be acquired."),
    );
  }

  const token = randomBytes(32).toString("hex");
  let port = options.port;
  const allowedHosts = () => new Set([`${CONTROL_SERVER_HOST}:${port}`, `localhost:${port}`]);

  const resolveRepository = (key: string): DomainResult<{ locator: RepositoryLocator; context: SessionContext }> => {
    const locators = readRepositoryLocators(options.catalogPath);
    if (!locators.ok) return locators;
    const locator = locators.value.find((entry) => repositoryKey(entry.repository_id) === key);
    const opened =
      locator === undefined
        ? failure(new DomainError("NOT_GIT_REPOSITORY", "Unknown locally known repository.", { repository_key: key }))
        : openRepositoryLocator(locator, options.git);
    if (!opened.ok || locator === undefined) return opened as DomainResult<never>;
    return success({ locator, context: { cwd: opened.value.cwd } });
  };

  const repositoryIdentity = (locator: RepositoryLocator): JsonObject => ({
    repository_key: repositoryKey(locator.repository_id),
    repository_id: locator.repository_id,
    worktree_path: locator.worktree_path,
  });

  async function route(request: http.IncomingMessage, segments: readonly string[]): Promise<Reply> {
    const method = request.method ?? "GET";
    const [, , resource, key, child, sessionId, leaf, ...extra] = segments;
    if (resource === "health" && key === undefined) {
      if (method !== "GET") return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");
      return {
        status: 200,
        body: { ok: true, schema: CONTROL_SERVER_SCHEMA, status: "ok", host: CONTROL_SERVER_HOST, port },
      };
    }
    if (resource !== "repositories" || extra.length > 0) {
      return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
    }
    if (key === undefined) {
      if (method !== "GET") return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");
      return domainReply(listControlRepositories(options.catalogPath, options.git), (repositories) => ({
        repositories: repositories as unknown as JsonValue,
      }));
    }
    const repository = resolveRepository(key);
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
    if (leaf !== undefined && leaf !== "actions")
      return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
    const expectedMethod = leaf === "actions" ? "POST" : "GET";
    if (method !== expectedMethod) return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");

    let actionRequest: ActionRequest | undefined;
    if (leaf === "actions") {
      const contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== "application/json") {
        return transportError(415, "INVALID_ARGUMENT", "Mutation requests accept application/json only.");
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error: unknown) {
        return error instanceof RequestBodyTooLarge
          ? transportError(413, "INVALID_ARGUMENT", "Request body exceeds the bounded size.", {
              maximum_bytes: MAX_CONTROL_REQUEST_BYTES,
            })
          : transportError(400, "INVALID_ARGUMENT", "Request body is not valid JSON.");
      }
      const parsed = parseControlActionRequest(body);
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

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const send = (reply: Reply) => {
      response.writeHead(reply.status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(reply.body)}\n`);
    };
    const host = request.headers.host;
    if (host === undefined || !allowedHosts().has(host)) {
      send(transportError(403, "OPERATION_REJECTED", "Unexpected Host header."));
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      send(transportError(403, "OPERATION_REJECTED", "Cross-origin requests are rejected."));
      return;
    }
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/") {
      if (request.method !== "GET") {
        send(transportError(405, "INVALID_ARGUMENT", "Method not allowed."));
        return;
      }
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(renderControlWebDocument({ nonce }));
      return;
    }
    let segments: string[];
    try {
      segments = pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      send(transportError(400, "INVALID_ARGUMENT", "Malformed request path."));
      return;
    }
    if (segments[0] !== "api" || segments[1] !== "v1") {
      send(transportError(404, "INVALID_ARGUMENT", "Unknown resource."));
      return;
    }
    const supplied = request.headers[CONTROL_TOKEN_HEADER];
    if (supplied === undefined) {
      send(transportError(401, "OPERATION_REJECTED", "The local control token header is required."));
      return;
    }
    if (!sameSecret(token, supplied)) {
      send(transportError(403, "OPERATION_REJECTED", "The local control token is invalid."));
      return;
    }
    send(await route(request, segments));
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
      response.end(
        `${JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected internal error occurred." } })}\n`,
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const listening = await new Promise<DomainResult<void>>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(
        failure(
          new DomainError(
            "OPERATION_REJECTED",
            error.code === "EADDRINUSE"
              ? `The control server port ${options.port} on ${CONTROL_SERVER_HOST} is already in use.`
              : `The control server could not listen on ${CONTROL_SERVER_HOST}:${options.port}.`,
            {
              reason: error.code === "EADDRINUSE" ? "address-in-use" : "listen-failed",
              host: CONTROL_SERVER_HOST,
              port: options.port,
            },
          ),
        ),
      );
    });
    server.listen({ host: CONTROL_SERVER_HOST, port: options.port, exclusive: true }, () =>
      resolve(success(undefined)),
    );
  });
  if (!listening.ok) {
    await lease.release();
    return listening;
  }
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : options.port;

  let credential: HostCredentialArtifact;
  try {
    credential = createHostCredentialArtifact(token);
  } catch {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await lease.release();
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The host-only Control credential file could not be created."),
    );
  }

  try {
    await lease.publishEndpoint(port);
  } catch {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    fs.rmSync(credential.directory, { recursive: true, force: true });
    await lease.release();
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The Control Server endpoint locator could not be published."),
    );
  }

  let closePromise: Promise<void> | undefined;

  return success({
    port,
    url: `http://${CONTROL_SERVER_HOST}:${port}/`,
    credentialFile: credential.file,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          let cleanupError: unknown;
          try {
            fs.rmSync(credential.directory, { recursive: true, force: true });
          } catch (error: unknown) {
            cleanupError = error;
          }
          void lease.release().then(
            () => (cleanupError === undefined ? resolve() : reject(cleanupError)),
            (leaseError: unknown) => reject(cleanupError ?? leaseError),
          );
        });
        server.closeAllConnections();
      });
      return closePromise;
    },
  });
}
