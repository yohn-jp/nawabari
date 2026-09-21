import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import { WORKTREE_FILE_OPERATION_HELPER } from "./worktree-file-operation-helper.js";

export { WORKTREE_FILE_OPERATION_HELPER } from "./worktree-file-operation-helper.js";

export const WORKTREE_FILE_OPERATION_SCHEMA_VERSION = 1 as const;
export const WORKTREE_FILE_OPERATION_CONTRACT_ID = "nawabari.worktree-file-operation.v1" as const;
export const FILE_OPERATION_STATE_UNCERTAIN = "FILE_OPERATION_STATE_UNCERTAIN" as const;
export const WORKTREE_FILE_OPERATION_MAX_PATH_LENGTH = 4_096 as const;
export const WORKTREE_FILE_OPERATION_MAX_SELECTOR_COUNT = 2_048 as const;
export const WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export const WORKTREE_FILE_OPERATIONS = ["CREATE", "DELETE", "RENAME"] as const;
export type WorktreeFileOperationName = (typeof WORKTREE_FILE_OPERATIONS)[number];
export type WorktreeFileOperationClaimMode = "write" | "exclusive-write";

export type WorktreeFileIdentity = Readonly<{
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly digest: string;
}>;

export type WorktreeFileOperationScope = Readonly<{
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
}>;

export type WorktreeFileOperationClaim = Readonly<{
  readonly resource: string;
  readonly mode: WorktreeFileOperationClaimMode;
}>;

export type WorktreeFileOperationPayload = Readonly<{
  readonly encoding: "base64";
  readonly data: string;
}>;

/**
 * The transport-neutral request owned by this producer.  The registry and
 * domain-session adapters serialize this same value under their own keys;
 * neither adapter is allowed to infer a weaker operation from WRITE.
 */
export type WorktreeFileOperation = Readonly<{
  readonly contract_id: typeof WORKTREE_FILE_OPERATION_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_FILE_OPERATION_SCHEMA_VERSION;
  readonly session_id: string;
  readonly operation_id: string;
  readonly operation: WorktreeFileOperationName;
  readonly worktree_root: string;
  readonly path: string;
  readonly to_path?: string;
  /** null is the explicit absent expectation used by CREATE/destination. */
  readonly expected_digest: string | null;
  readonly expected_identity?: WorktreeFileIdentity;
  readonly requested_generation: number;
  readonly scope: WorktreeFileOperationScope;
  readonly claims: readonly WorktreeFileOperationClaim[];
  readonly payload_ref?: WorktreeFileOperationPayload;
}>;

export type PreparedWorktreeFileOperation = Readonly<{
  readonly request: WorktreeFileOperation;
  readonly canonical_worktree_root: string;
  readonly helper_packet: Readonly<Record<string, unknown>>;
}>;

export type WorktreeFileOperationPostcondition = Readonly<{
  readonly kind: "rebuild-execution-view";
  readonly reason: "physical-operation-applied";
  readonly generation: number;
}>;

export type WorktreeFileOperationResult = Readonly<{
  readonly contract_id: typeof WORKTREE_FILE_OPERATION_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_FILE_OPERATION_SCHEMA_VERSION;
  readonly operation_id: string;
  readonly operation: WorktreeFileOperationName;
  readonly state: "applied";
  readonly previous_generation: number;
  readonly next_generation: number;
  readonly identity: WorktreeFileIdentity;
  readonly postcondition: WorktreeFileOperationPostcondition;
}>;

export type SerializedWorktreeFileOperation = Readonly<{
  readonly registry: Readonly<{
    readonly contract_id: typeof WORKTREE_FILE_OPERATION_CONTRACT_ID;
    readonly schema_version: typeof WORKTREE_FILE_OPERATION_SCHEMA_VERSION;
    readonly operation_id: string;
    readonly operation: WorktreeFileOperationName;
    readonly worktree_root: string;
    readonly path: string;
    readonly to_path?: string;
    readonly expected_digest: string | null;
    readonly expected_identity?: WorktreeFileIdentity;
    readonly scope: WorktreeFileOperationScope;
    readonly claims: readonly WorktreeFileOperationClaim[];
    readonly payload_ref?: WorktreeFileOperationPayload;
  }>;
  readonly "domain-session": Readonly<{
    readonly session_id: string;
    readonly requested_generation: number;
  }>;
}>;

export type WorktreeFileOperationExecutionOptions = Readonly<{
  /** Test seam for the fixed helper protocol; production uses the fixed spawn below. */
  readonly run_helper?: (packet: string) => string;
  readonly timeout_ms?: number;
}>;

type RecordValue = Record<string, unknown>;
type HelperIdentity = Readonly<{
  readonly dev: string;
  readonly ino: string;
  readonly size: number;
  readonly digest: string;
}>;
type HelperResponse = Readonly<{
  readonly ok: boolean;
  readonly identity?: HelperIdentity;
  readonly code?: string;
  readonly message?: string;
  readonly uncertain?: boolean;
}>;

const SAFE_ID = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_DIGEST = /^[0-9a-f]{64}$/iu;
const SAFE_SELECTOR_CHARACTER = /^[^\u0000-\u001f\u007f]+$/u;
const MAX_ID_LENGTH = 256;

function objectValue(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : null;
}

function details(values: Record<string, string | number | boolean>): JsonObject {
  return values;
}

function invalid(field: string, message: string, value?: unknown): DomainResult<never> {
  const rendered = typeof value === "string" ? value : value === undefined ? undefined : String(value);
  return failure(
    new DomainError(
      "INVALID_ARGUMENT",
      `Worktree file operation field '${field}' is invalid: ${message}.`,
      details({ field, ...(rendered === undefined ? {} : { value: rendered }) }),
    ),
  );
}

function rejected(message: string, extra: Record<string, string | number | boolean> = {}): DomainResult<never> {
  return failure(new DomainError("OPERATION_REJECTED", message, details(extra)));
}

function boundedText(value: unknown, field: string, maximum = MAX_ID_LENGTH): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !SAFE_ID.test(value)) {
    return invalid(field, `expected non-empty text of at most ${maximum} characters`);
  }
  return success(value.normalize("NFC"));
}

function operation(value: unknown): DomainResult<WorktreeFileOperationName> {
  if (typeof value !== "string" || !(WORKTREE_FILE_OPERATIONS as readonly string[]).includes(value)) {
    return invalid("operation", "expected CREATE, DELETE, or RENAME");
  }
  return success(value as WorktreeFileOperationName);
}

function positiveGeneration(value: unknown): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    return invalid("requested_generation", "expected a positive integer");
  return success(value as number);
}

function canonicalRelativePath(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field, WORKTREE_FILE_OPERATION_MAX_PATH_LENGTH);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return invalid(field, "expected an exact repository-relative path", normalized);
  }
  if (normalized.includes("*")) return invalid(field, "wildcards are not valid in an exact operation path", normalized);
  return success(normalized);
}

function selector(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field, WORKTREE_FILE_OPERATION_MAX_PATH_LENGTH);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !SAFE_SELECTOR_CHARACTER.test(normalized)
  ) {
    return invalid(field, "expected a repository-relative bounded selector", normalized);
  }
  return success(normalized);
}

function selectorList(value: unknown, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > WORKTREE_FILE_OPERATION_MAX_SELECTOR_COUNT) {
    return invalid(field, `expected at most ${WORKTREE_FILE_OPERATION_MAX_SELECTOR_COUNT} selectors`);
  }
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = selector(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  if (new Set(values).size !== values.length) return invalid(field, "contains duplicate selectors");
  return success(Object.freeze(values.slice().sort()));
}

function scope(value: unknown): DomainResult<WorktreeFileOperationScope> {
  const record = objectValue(value);
  if (record === null) return invalid("scope", "expected an object");
  const create = selectorList(record.create, "scope.create");
  if (!create.ok) return create;
  const remove = selectorList(record.delete, "scope.delete");
  if (!remove.ok) return remove;
  const deny = selectorList(record.deny, "scope.deny");
  if (!deny.ok) return deny;
  return success(Object.freeze({ create: create.value, delete: remove.value, deny: deny.value }));
}

function identity(value: unknown, field: string): DomainResult<WorktreeFileIdentity> {
  const record = objectValue(value);
  if (record === null) return invalid(field, "expected an object");
  const dev = boundedText(record.dev, `${field}.dev`, 128);
  if (!dev.ok) return dev;
  const ino = boundedText(record.ino, `${field}.ino`, 128);
  if (!ino.ok) return ino;
  if (!/^[0-9]+$/u.test(dev.value) || !/^[0-9]+$/u.test(ino.value))
    return invalid(field, "dev and ino must be decimal strings");
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0)
    return invalid(`${field}.size`, "expected a non-negative safe integer");
  const digest = boundedText(record.digest, `${field}.digest`, 64);
  if (!digest.ok || !SAFE_DIGEST.test(digest.value)) return invalid(`${field}.digest`, "expected a SHA-256 digest");
  return success(
    Object.freeze({ dev: dev.value, ino: ino.value, size: record.size as number, digest: digest.value.toLowerCase() }),
  );
}

function claims(value: unknown): DomainResult<readonly WorktreeFileOperationClaim[]> {
  if (!Array.isArray(value) || value.length > WORKTREE_FILE_OPERATION_MAX_SELECTOR_COUNT)
    return invalid("claims", "expected a bounded array");
  const result: WorktreeFileOperationClaim[] = [];
  for (const [index, item] of value.entries()) {
    const record = objectValue(item);
    if (record === null) return invalid(`claims[${index}]`, "expected an object");
    const resource = selector(record.resource, `claims[${index}].resource`);
    if (!resource.ok) return resource;
    if (record.mode !== "write" && record.mode !== "exclusive-write")
      return invalid(`claims[${index}].mode`, "expected write or exclusive-write");
    result.push(Object.freeze({ resource: resource.value, mode: record.mode }));
  }
  return success(Object.freeze(result));
}

function payload(value: unknown): DomainResult<WorktreeFileOperationPayload | undefined> {
  if (value === undefined) return success(undefined);
  const record = objectValue(value);
  if (record === null || record.encoding !== "base64" || typeof record.data !== "string")
    return invalid("payload_ref", "expected a base64 payload reference");
  if (
    record.data.length > Math.ceil((WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(record.data)
  ) {
    return invalid("payload_ref.data", "expected bounded canonical base64");
  }
  const decoded = Buffer.from(record.data, "base64");
  if (decoded.length > WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES)
    return invalid("payload_ref.data", "payload exceeds the bounded limit");
  return success(Object.freeze({ encoding: "base64", data: record.data }));
}

function parseRoot(value: unknown): DomainResult<string> {
  const text = boundedText(value, "worktree_root", 4_096);
  if (!text.ok) return text;
  if (!path.isAbsolute(text.value)) return invalid("worktree_root", "expected an absolute path");
  try {
    const canonical = fs.realpathSync.native(text.value);
    if (canonical !== path.resolve(text.value) || !fs.statSync(canonical).isDirectory())
      return invalid("worktree_root", "expected a canonical directory");
    return success(canonical);
  } catch {
    return invalid("worktree_root", "directory cannot be observed");
  }
}

function parseOperation(input: unknown): DomainResult<WorktreeFileOperation> {
  const value = objectValue(input);
  if (value === null) return invalid("operation", "expected an object");
  if (value.contract_id !== WORKTREE_FILE_OPERATION_CONTRACT_ID) return invalid("contract_id", "unsupported contract");
  if (value.schema_version !== WORKTREE_FILE_OPERATION_SCHEMA_VERSION)
    return invalid("schema_version", "unsupported schema version");
  const sessionId = boundedText(value.session_id, "session_id");
  if (!sessionId.ok) return sessionId;
  const operationId = boundedText(value.operation_id, "operation_id");
  if (!operationId.ok) return operationId;
  const operationValue = operation(value.operation);
  if (!operationValue.ok) return operationValue;
  const root = parseRoot(value.worktree_root);
  if (!root.ok) return root;
  const target = canonicalRelativePath(value.path, "path");
  if (!target.ok) return target;
  const toPathValue = value.to_path === undefined ? undefined : canonicalRelativePath(value.to_path, "to_path");
  if (toPathValue !== undefined && !toPathValue.ok) return toPathValue;
  if (operationValue.value === "RENAME" && toPathValue === undefined) return invalid("to_path", "required for RENAME");
  if (operationValue.value !== "RENAME" && toPathValue !== undefined)
    return invalid("to_path", "only valid for RENAME");
  if (toPathValue !== undefined && toPathValue.value === target.value)
    return invalid("to_path", "must differ from path");
  if (typeof value.expected_digest !== "string" && value.expected_digest !== null)
    return invalid("expected_digest", "expected a SHA-256 digest or null");
  if (typeof value.expected_digest === "string" && !SAFE_DIGEST.test(value.expected_digest))
    return invalid("expected_digest", "expected a SHA-256 digest");
  const expectedIdentity =
    value.expected_identity === undefined ? undefined : identity(value.expected_identity, "expected_identity");
  if (expectedIdentity !== undefined && !expectedIdentity.ok) return expectedIdentity;
  if (operationValue.value === "CREATE" && (value.expected_digest !== null || expectedIdentity !== undefined))
    return invalid("expected_digest", "CREATE requires an explicit absent expectation");
  if (
    (operationValue.value === "DELETE" || operationValue.value === "RENAME") &&
    value.expected_digest === null &&
    expectedIdentity === undefined
  )
    return invalid("expected_digest", "DELETE and RENAME require an expected identity");
  const generation = positiveGeneration(value.requested_generation);
  if (!generation.ok) return generation;
  const scopeValue = scope(value.scope);
  if (!scopeValue.ok) return scopeValue;
  const claimsValue = claims(value.claims);
  if (!claimsValue.ok) return claimsValue;
  const payloadValue = payload(value.payload_ref);
  if (!payloadValue.ok) return payloadValue;
  if (operationValue.value === "CREATE" && payloadValue.value === undefined)
    return invalid("payload_ref", "CREATE requires a bounded payload reference, including an empty base64 payload");
  return success(
    Object.freeze({
      contract_id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
      session_id: sessionId.value,
      operation_id: operationId.value,
      operation: operationValue.value,
      worktree_root: root.value,
      path: target.value,
      ...(toPathValue === undefined ? {} : { to_path: toPathValue.value }),
      expected_digest: value.expected_digest,
      ...(expectedIdentity === undefined ? {} : { expected_identity: expectedIdentity.value }),
      requested_generation: generation.value,
      scope: scopeValue.value,
      claims: claimsValue.value,
      ...(payloadValue.value === undefined ? {} : { payload_ref: payloadValue.value }),
    }),
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function selectorRegex(value: string): RegExp {
  let source = "^";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] as string;
    if (character === "*" && value[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += escapeRegex(character);
  }
  return new RegExp(`${source}$`, "u");
}

function matchesAny(selectors: readonly string[], target: string): boolean {
  return selectors.some((entry) => selectorRegex(entry).test(target));
}

function operationScopeAllows(request: WorktreeFileOperation, target: string, kind: "create" | "delete"): boolean {
  if (matchesAny(request.scope.deny, target)) return false;
  return matchesAny(request.scope[kind], target);
}

function claimAllows(request: WorktreeFileOperation, target: string): boolean {
  return request.claims.some((claim) =>
    claim.mode === "write" || claim.mode === "exclusive-write" ? matchesAny([claim.resource], target) : false,
  );
}

function expectedPacket(request: WorktreeFileOperation): Record<string, unknown> {
  return {
    ...(request.expected_digest === null ? {} : { digest: request.expected_digest }),
    ...(request.expected_identity === undefined ? {} : request.expected_identity),
  };
}

function buildHelperPacket(request: WorktreeFileOperation): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operation: request.operation,
    operation_id: request.operation_id,
    root: request.worktree_root,
    path: request.path,
    ...(request.to_path === undefined ? {} : { to_path: request.to_path }),
    ...(request.operation === "CREATE" ? { payload_base64: request.payload_ref?.data ?? "" } : {}),
    ...(request.operation === "CREATE" ? {} : { expected: expectedPacket(request) }),
  });
}

/** Validate and freeze one transport-neutral operation request. */
export function validateWorktreeFileOperation(input: unknown): DomainResult<WorktreeFileOperation> {
  const parsed = parseOperation(input);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (request.operation === "CREATE") {
    if (!operationScopeAllows(request, request.path, "create") || !claimAllows(request, request.path))
      return rejected("CREATE is outside the effective create scope or claim");
  } else if (request.operation === "DELETE") {
    if (!operationScopeAllows(request, request.path, "delete") || !claimAllows(request, request.path))
      return rejected("DELETE is outside the effective delete scope or claim");
  } else {
    if (
      request.to_path === undefined ||
      !operationScopeAllows(request, request.path, "delete") ||
      !operationScopeAllows(request, request.to_path, "create") ||
      !claimAllows(request, request.path) ||
      !claimAllows(request, request.to_path)
    )
      return rejected("RENAME requires delete and create authority at both endpoints");
  }
  return success(request);
}

/** Prepare a validated request and materialize its fixed helper packet. */
export function prepareWorktreeFileOperation(input: unknown): DomainResult<PreparedWorktreeFileOperation> {
  const request = validateWorktreeFileOperation(input);
  if (!request.ok) return request;
  return success(
    Object.freeze({
      request: request.value,
      canonical_worktree_root: request.value.worktree_root,
      helper_packet: buildHelperPacket(request.value),
    }),
  );
}

function helperResponse(value: unknown): DomainResult<HelperResponse> {
  const record = objectValue(value);
  if (record === null || typeof record.ok !== "boolean")
    return invalid("helper_response", "expected a bounded helper response");
  if (record.ok) {
    const parsedIdentity = identity(record.identity, "helper_response.identity");
    if (!parsedIdentity.ok) return parsedIdentity;
    return success(Object.freeze({ ok: true, identity: parsedIdentity.value }));
  }
  return success(
    Object.freeze({
      ok: false,
      code: typeof record.code === "string" ? record.code : "HELPER_REJECTED",
      message: typeof record.message === "string" ? record.message : "The fixed helper rejected the operation.",
      uncertain: record.uncertain === true,
    }),
  );
}

function spawnFixedHelper(packet: string, timeout: number): string {
  const result: SpawnSyncReturns<string> = spawnSync("python3", ["-I", "-c", WORKTREE_FILE_OPERATION_HELPER], {
    cwd: process.cwd(),
    env: {},
    input: packet,
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error("fixed file-operation helper timed out");
  return result.stdout;
}

/** Execute exactly one prepared operation through the fixed Linux helper. */
export function executeWorktreeFileOperation(
  preparedOperation: PreparedWorktreeFileOperation,
  options: WorktreeFileOperationExecutionOptions = {},
): DomainResult<WorktreeFileOperationResult> {
  const timeout = options.timeout_ms ?? 10_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    return invalid("timeout_ms", "expected a bounded positive timeout");
  let serialized: string;
  try {
    serialized =
      options.run_helper === undefined
        ? spawnFixedHelper(JSON.stringify(preparedOperation.helper_packet), timeout)
        : options.run_helper(JSON.stringify(preparedOperation.helper_packet));
  } catch (error: unknown) {
    return failure(
      new DomainError(
        "OPERATION_REJECTED",
        "The fixed file-operation helper could not be started.",
        details({ operation_id: preparedOperation.request.operation_id, reason: String(error) }),
      ),
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return failure(
      new DomainError(
        "OPERATION_REJECTED",
        "The fixed file-operation helper returned invalid evidence.",
        details({ operation_id: preparedOperation.request.operation_id }),
      ),
    );
  }
  const response = helperResponse(raw);
  if (!response.ok) return response;
  if (!response.value.ok) {
    const operationCode = response.value.uncertain
      ? FILE_OPERATION_STATE_UNCERTAIN
      : (response.value.code ?? "OPERATION_REJECTED");
    return failure(
      new DomainError(
        "OPERATION_REJECTED",
        response.value.message ?? "The file operation was rejected.",
        details({
          operation_id: preparedOperation.request.operation_id,
          operation_code: operationCode,
          state_uncertain: response.value.uncertain === true,
        }),
      ),
    );
  }
  const identityValue = response.value.identity;
  if (identityValue === undefined)
    return failure(
      new DomainError(
        "OPERATION_REJECTED",
        "The fixed helper omitted identity evidence.",
        details({
          operation_id: preparedOperation.request.operation_id,
          operation_code: FILE_OPERATION_STATE_UNCERTAIN,
          state_uncertain: true,
        }),
      ),
    );
  const nextGeneration = preparedOperation.request.requested_generation + 1;
  return success(
    Object.freeze({
      contract_id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
      operation_id: preparedOperation.request.operation_id,
      operation: preparedOperation.request.operation,
      state: "applied",
      previous_generation: preparedOperation.request.requested_generation,
      next_generation: nextGeneration,
      identity: identityValue,
      postcondition: Object.freeze({
        kind: "rebuild-execution-view",
        reason: "physical-operation-applied",
        generation: nextGeneration,
      }),
    }),
  );
}

/** Complete the bounded producer operation without exposing shell execution. */
export function mutateWorktreeFile(
  input: unknown,
  options: WorktreeFileOperationExecutionOptions = {},
): DomainResult<WorktreeFileOperationResult> {
  const prepared = prepareWorktreeFileOperation(input);
  if (!prepared.ok) return prepared;
  return executeWorktreeFileOperation(prepared.value, options);
}

/** Serialize the operation using the two persisted authority namespaces. */
export function serializeWorktreeFileOperation(operationValue: WorktreeFileOperation): SerializedWorktreeFileOperation {
  const registry = {
    contract_id: operationValue.contract_id,
    schema_version: operationValue.schema_version,
    operation_id: operationValue.operation_id,
    operation: operationValue.operation,
    worktree_root: operationValue.worktree_root,
    path: operationValue.path,
    ...(operationValue.to_path === undefined ? {} : { to_path: operationValue.to_path }),
    expected_digest: operationValue.expected_digest,
    ...(operationValue.expected_identity === undefined ? {} : { expected_identity: operationValue.expected_identity }),
    scope: operationValue.scope,
    claims: operationValue.claims,
    ...(operationValue.payload_ref === undefined ? {} : { payload_ref: operationValue.payload_ref }),
  };
  return Object.freeze({
    registry: Object.freeze(registry),
    "domain-session": Object.freeze({
      session_id: operationValue.session_id,
      requested_generation: operationValue.requested_generation,
    }),
  });
}

/** Deserialize only the canonical registry/domain-session envelope. */
export function deserializeWorktreeFileOperation(input: unknown): DomainResult<WorktreeFileOperation> {
  const value = objectValue(input);
  if (value === null) return invalid("serialization", "expected an object");
  const registry = objectValue(value.registry);
  const session = objectValue(value["domain-session"]);
  if (registry === null || session === null)
    return invalid("serialization", "expected registry and domain-session objects");
  return validateWorktreeFileOperation({
    ...registry,
    session_id: session.session_id,
    requested_generation: session.requested_generation,
  });
}
