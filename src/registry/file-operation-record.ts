import { createHash } from "node:crypto";

/**
 * The file-operation producer is intentionally independent of the registry
 * transport.  Integration owns writing this state as the `file_operations`
 * member of the existing registry document; this module owns the facts and
 * transitions represented by that member.
 */
export const FILE_OPERATION_SCHEMA_VERSION = 1 as const;
export const FILE_OPERATION_REGISTRY_SCHEMA_VERSION = 1 as const;
export const FILE_OPERATION_REQUIRED_FEATURE = "file-operations.v1" as const;

export const FILE_OPERATION_STAGES = ["prepared", "apply-recorded", "completed", "unresolved"] as const;
export type FileOperationStage = (typeof FILE_OPERATION_STAGES)[number];

export const FILE_OPERATION_KINDS = ["create", "delete", "rename"] as const;
export type FileOperationKind = (typeof FILE_OPERATION_KINDS)[number];

/** Keep the registry bounded without ever evicting an operation whose result is not proven. */
export const MAX_FILE_OPERATION_RECORDS = 1_024 as const;

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u;

export type FileOperationErrorCode =
  | "FILE_OPERATION_INVALID"
  | "FILE_OPERATION_ID_CONFLICT"
  | "FILE_OPERATION_INVALID_TRANSITION"
  | "FILE_OPERATION_LIMIT"
  | "FILE_OPERATION_AUTHORITY_DENIED"
  | "FILE_OPERATION_UNSUPPORTED_SCHEMA"
  | "FILE_OPERATION_CORRUPT";

export class FileOperationError extends Error {
  public readonly code: FileOperationErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: FileOperationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileOperationError";
    this.code = code;
    this.details = details;
  }
}

export function isFileOperationError(error: unknown): error is FileOperationError {
  return error instanceof FileOperationError;
}

/**
 * Identity is deliberately transport-neutral.  A protected executor may use
 * an inode tuple, a content digest, or a future versioned identity object.
 * The value is nevertheless restricted to JSON so its comparison is exact
 * and its digest is deterministic.
 */
export type FileIdentity = string | number | boolean | null | readonly unknown[] | Readonly<Record<string, unknown>>;

export interface FileOperationRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly operation: FileOperationKind | Uppercase<FileOperationKind>;
  /** Source is null for CREATE; destination is null for DELETE. */
  readonly source: string | null;
  readonly destination: string | null;
  /** Expected identity of the object being created or moved, or deleted before removal. */
  readonly expectedIdentity: FileIdentity | null;
  readonly payloadDigest: string | null;
  /** Capability proof supplied by the already-authorized operation boundary. */
  readonly authorityToken: string;
  /** Monotonic session fence captured by the operation authorizer. */
  readonly fenceEpoch: number;
}

export interface FileOperationPathObservation {
  readonly present: boolean;
  readonly identity?: FileIdentity | null;
  readonly payloadDigest?: string | null;
  /** Optional pre-apply fact. It is required when the receipt carries a preimage identity. */
  readonly before?: FileOperationPathFact | null;
}

export interface FileOperationPathFact {
  readonly present: boolean;
  readonly identity?: FileIdentity | null;
  readonly payloadDigest?: string | null;
}

/**
 * Before/after observations are required for mutation operations.  They let
 * reconciliation compare the expected preimage as well as the resulting
 * effect; an after-state alone can never prove that an operation ran once.
 */
export interface FileOperationObservation {
  readonly operationId?: string;
  readonly authorityToken: string;
  readonly fenceEpoch: number;
  readonly source: FileOperationPathObservation | null;
  readonly destination: FileOperationPathObservation | null;
  /** The executor explicitly observed the requested effect. */
  readonly effectObserved: boolean;
  /** The executor explicitly observed completion of its own apply boundary. */
  readonly executionCompleted: boolean;
  readonly failure?: string | null;
}

export interface FileOperationRecord {
  readonly schemaVersion: typeof FILE_OPERATION_SCHEMA_VERSION;
  readonly operationId: string;
  readonly sessionId: string;
  readonly requestDigest: string;
  readonly operation: FileOperationKind;
  readonly source: string | null;
  readonly destination: string | null;
  readonly expectedIdentity: FileIdentity | null;
  readonly payloadDigest: string | null;
  readonly authorityToken: string;
  readonly fenceEpoch: number;
  readonly stage: FileOperationStage;
  readonly applyAttempts: number;
  readonly effectObserved: boolean;
  readonly executionCompleted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Mutable draft shape used by a registry mutation boundary. */
export interface FileOperationRegistryState {
  /** Present for a standalone nested projection; omitted when embedded in the root registry draft. */
  readonly schemaVersion?: typeof FILE_OPERATION_REGISTRY_SCHEMA_VERSION;
  readonly fileOperations: FileOperationRecord[];
}

export interface PersistedFileOperationRecord {
  readonly schema_version: typeof FILE_OPERATION_SCHEMA_VERSION;
  readonly operation_id: string;
  readonly session_id: string;
  readonly request_digest: string;
  readonly operation: FileOperationKind;
  readonly source: string | null;
  readonly destination: string | null;
  readonly expected_identity: FileIdentity | null;
  readonly payload_digest: string | null;
  readonly authority_token: string;
  readonly fence_epoch: number;
  readonly stage: FileOperationStage;
  readonly apply_attempts: number;
  readonly effect_observed: boolean;
  readonly execution_completed: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersistedFileOperationRegistry {
  readonly schema_version: typeof FILE_OPERATION_REGISTRY_SCHEMA_VERSION;
  readonly file_operations: readonly PersistedFileOperationRecord[];
}

export interface FileOperationReservation {
  readonly record: FileOperationRecord;
  readonly idempotent: boolean;
}

export interface FileOperationReconciliation {
  readonly record: FileOperationRecord;
  readonly effectMatches: boolean;
  readonly completionProven: boolean;
  readonly disposition: "completed" | "unresolved";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, details: Readonly<Record<string, unknown>> = {}): never {
  throw new FileOperationError("FILE_OPERATION_INVALID", message, details);
}

function assertString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\u0000")) {
    fail(`${field} must be a non-empty string without NUL`, { field });
  }
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${field} must be a canonical UTC timestamp`, { field });
  }
}

function assertFenceEpoch(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${field} must be a non-negative safe integer`, { field });
  }
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || !DIGEST_PATTERN.test(value)) {
    fail(`${field} must be a non-empty digest token`, { field });
  }
}

function normalizeText(value: string, field: string): string {
  assertString(value, field);
  const normalized = value.normalize("NFC");
  if (normalized.length === 0) {
    fail(`${field} must not normalize to an empty string`, { field });
  }
  return normalized;
}

function canonicalJson(value: unknown, path = "$", seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`Non-finite number is not serializable at ${path}`, { path });
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    fail(`Value is not JSON serializable at ${path}`, { path });
  }
  if (seen.has(value)) {
    fail(`Cyclic value is not serializable at ${path}`, { path });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalJson(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, `${path}.${key}`, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function cloneJsonValue<T extends FileIdentity>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function freezeJsonValue(value: FileIdentity): FileIdentity {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => freezeJsonValue(entry as FileIdentity)));
  }
  if (isRecord(value)) {
    const result: Record<string, FileIdentity> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = freezeJsonValue(entry as FileIdentity);
    }
    return Object.freeze(result);
  }
  return value;
}

function assertJsonValue(value: unknown, field: string): asserts value is FileIdentity {
  try {
    canonicalJson(value, field);
  } catch (error) {
    if (error instanceof FileOperationError) throw error;
    throw new FileOperationError(
      "FILE_OPERATION_INVALID",
      `${field} must be JSON serializable`,
      { field },
      { cause: error },
    );
  }
}

function normalizeKind(value: unknown): FileOperationKind {
  if (typeof value !== "string") {
    fail("operation must be CREATE, DELETE, or RENAME");
  }
  const normalized = value.toLowerCase();
  if (!(FILE_OPERATION_KINDS as readonly string[]).includes(normalized)) {
    fail("operation must be CREATE, DELETE, or RENAME", { operation: value });
  }
  return normalized as FileOperationKind;
}

function normalizePath(value: string | null, field: string): string | null {
  if (value === null) return null;
  return normalizeText(value, field);
}

function requestDigest(request: {
  sessionId: string;
  operation: FileOperationKind;
  source: string | null;
  destination: string | null;
  expectedIdentity: FileIdentity | null;
  payloadDigest: string | null;
  authorityToken: string;
  fenceEpoch: number;
}): string {
  const normalized = {
    authorityToken: request.authorityToken,
    destination: request.destination,
    expectedIdentity: request.expectedIdentity,
    fenceEpoch: request.fenceEpoch,
    operation: request.operation,
    payloadDigest: request.payloadDigest,
    sessionId: request.sessionId,
    source: request.source,
  };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

/** Exported for integration/tests that need to prove the operation-id binding. */
export function fileOperationRequestDigest(request: FileOperationRequest): string {
  const normalized = normalizeRequest(request);
  return requestDigest(normalized);
}

interface NormalizedRequest {
  readonly operationId: string;
  readonly sessionId: string;
  readonly operation: FileOperationKind;
  readonly source: string | null;
  readonly destination: string | null;
  readonly expectedIdentity: FileIdentity | null;
  readonly payloadDigest: string | null;
  readonly authorityToken: string;
  readonly fenceEpoch: number;
}

function normalizeRequest(request: FileOperationRequest): NormalizedRequest {
  if (!isRecord(request)) fail("file-operation request must be an object");
  const operationId = normalizeText(request.operationId, "operationId");
  const sessionId = normalizeText(request.sessionId, "sessionId");
  const operation = normalizeKind(request.operation);
  const source = normalizePath(request.source, "source");
  const destination = normalizePath(request.destination, "destination");
  if (operation === "create" && (source !== null || destination === null)) {
    fail("CREATE requires a null source and a destination", { operation });
  }
  if (operation === "delete" && (source === null || destination !== null)) {
    fail("DELETE requires a source and a null destination", { operation });
  }
  if (operation === "rename" && (source === null || destination === null || source === destination)) {
    fail("RENAME requires distinct source and destination paths", { operation });
  }

  const expectedIdentity = request.expectedIdentity;
  if (expectedIdentity !== null) {
    assertJsonValue(expectedIdentity, "expectedIdentity");
  }
  const payloadDigest = request.payloadDigest;
  if (payloadDigest !== null) assertDigest(payloadDigest, "payloadDigest");
  const authorityToken = normalizeText(request.authorityToken, "authorityToken");
  assertFenceEpoch(request.fenceEpoch, "fenceEpoch");
  return {
    operationId,
    sessionId,
    operation,
    source,
    destination,
    expectedIdentity: expectedIdentity === null ? null : freezeJsonValue(cloneJsonValue(expectedIdentity)),
    payloadDigest: payloadDigest === null ? null : normalizeText(payloadDigest, "payloadDigest"),
    authorityToken,
    fenceEpoch: request.fenceEpoch,
  };
}

function recordFromRequest(request: NormalizedRequest, now: string): FileOperationRecord {
  assertTimestamp(now, "now");
  return Object.freeze({
    schemaVersion: FILE_OPERATION_SCHEMA_VERSION,
    operationId: request.operationId,
    sessionId: request.sessionId,
    requestDigest: requestDigest(request),
    operation: request.operation,
    source: request.source,
    destination: request.destination,
    expectedIdentity: request.expectedIdentity,
    payloadDigest: request.payloadDigest,
    authorityToken: request.authorityToken,
    fenceEpoch: request.fenceEpoch,
    stage: "prepared",
    applyAttempts: 0,
    effectObserved: false,
    executionCompleted: false,
    createdAt: now,
    updatedAt: now,
  });
}

function replaceRecord(state: FileOperationRegistryState, replacement: FileOperationRecord): void {
  const index = state.fileOperations.findIndex((record) => record.operationId === replacement.operationId);
  if (index === -1) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "File-operation record disappeared during mutation", {
      operationId: replacement.operationId,
    });
  }
  state.fileOperations[index] = replacement;
}

function assertStage(value: unknown): asserts value is FileOperationStage {
  if (typeof value !== "string" || !(FILE_OPERATION_STAGES as readonly string[]).includes(value)) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Unknown file-operation stage", { stage: value });
  }
}

function assertRecord(record: FileOperationRecord): void {
  if (!isRecord(record) || record.schemaVersion !== FILE_OPERATION_SCHEMA_VERSION) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Unsupported file-operation record schema");
  }
  assertString(record.operationId, "operationId");
  assertString(record.sessionId, "sessionId");
  assertDigest(record.requestDigest, "requestDigest");
  const normalized = normalizeRequest({
    operationId: record.operationId,
    sessionId: record.sessionId,
    operation: record.operation,
    source: record.source,
    destination: record.destination,
    expectedIdentity: record.expectedIdentity,
    payloadDigest: record.payloadDigest,
    authorityToken: record.authorityToken,
    fenceEpoch: record.fenceEpoch,
  });
  if (requestDigest(normalized) !== record.requestDigest) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "File-operation request digest does not match its receipt", {
      operationId: record.operationId,
    });
  }
  assertStage(record.stage);
  assertString(record.authorityToken, "authorityToken");
  assertFenceEpoch(record.fenceEpoch, "fenceEpoch");
  if (!Number.isSafeInteger(record.applyAttempts) || record.applyAttempts < 0) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Invalid apply-attempt count", {
      operationId: record.operationId,
    });
  }
  if (typeof record.effectObserved !== "boolean" || typeof record.executionCompleted !== "boolean") {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Invalid file-operation observation flags", {
      operationId: record.operationId,
    });
  }
  assertTimestamp(record.createdAt, "createdAt");
  assertTimestamp(record.updatedAt, "updatedAt");
  if (record.expectedIdentity !== null) assertJsonValue(record.expectedIdentity, "expectedIdentity");
  if (record.payloadDigest !== null) assertDigest(record.payloadDigest, "payloadDigest");
}

function assertState(state: FileOperationRegistryState): void {
  if (
    !isRecord(state) ||
    (state.schemaVersion !== undefined && state.schemaVersion !== FILE_OPERATION_REGISTRY_SCHEMA_VERSION)
  ) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Unsupported file-operation registry schema");
  }
  if (!Array.isArray(state.fileOperations)) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "fileOperations must be an array");
  }
  if (state.fileOperations.length > MAX_FILE_OPERATION_RECORDS) {
    throw new FileOperationError("FILE_OPERATION_LIMIT", "File-operation registry exceeds its bounded record limit", {
      limit: MAX_FILE_OPERATION_RECORDS,
    });
  }
  const ids = new Set<string>();
  for (const record of state.fileOperations) {
    assertRecord(record);
    if (ids.has(record.operationId)) {
      throw new FileOperationError("FILE_OPERATION_CORRUPT", "Duplicate operation_id in file-operation registry", {
        operationId: record.operationId,
      });
    }
    ids.add(record.operationId);
    if (record.stage === "completed" && !record.executionCompleted) {
      throw new FileOperationError("FILE_OPERATION_CORRUPT", "Completed receipt lacks execution proof", {
        operationId: record.operationId,
      });
    }
  }
}

export function createFileOperationRegistryState(): FileOperationRegistryState {
  return { schemaVersion: FILE_OPERATION_REGISTRY_SCHEMA_VERSION, fileOperations: [] };
}

export function validateFileOperationRegistryState(state: FileOperationRegistryState): void {
  assertState(state);
}

function compactCompletedHistory(state: FileOperationRegistryState): void {
  if (state.fileOperations.length < MAX_FILE_OPERATION_RECORDS) return;
  const removable = state.fileOperations
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.stage === "completed")
    .sort((left, right) => {
      const byTime = left.record.updatedAt.localeCompare(right.record.updatedAt);
      return byTime !== 0 ? byTime : left.record.operationId.localeCompare(right.record.operationId);
    });
  const candidate = removable[0];
  if (candidate === undefined) {
    throw new FileOperationError(
      "FILE_OPERATION_LIMIT",
      "File-operation registry is full and contains no proven completed receipt eligible for compaction",
      { limit: MAX_FILE_OPERATION_RECORDS },
    );
  }
  state.fileOperations.splice(candidate.index, 1);
}

/**
 * Durable reservation.  The caller must persist the returned state before it
 * starts physical I/O.  Repeating the exact request is idempotent; an
 * operation_id collision with a different normalized digest is rejected
 * without changing state.
 */
export function reserveFileOperation(
  state: FileOperationRegistryState,
  request: FileOperationRequest,
  now = new Date().toISOString(),
): FileOperationRecord {
  assertState(state);
  const normalized = normalizeRequest(request);
  const digest = requestDigest(normalized);
  const existing = state.fileOperations.find((record) => record.operationId === normalized.operationId);
  if (existing !== undefined) {
    if (existing.sessionId !== normalized.sessionId || existing.requestDigest !== digest) {
      throw new FileOperationError("FILE_OPERATION_ID_CONFLICT", "operation_id is already bound to another request", {
        operationId: normalized.operationId,
        sessionId: normalized.sessionId,
      });
    }
    return existing;
  }
  compactCompletedHistory(state);
  const record = recordFromRequest(normalized, now);
  state.fileOperations.push(record);
  return record;
}

function updatedRecord(
  record: FileOperationRecord,
  patch: Partial<FileOperationRecord>,
  now: string,
): FileOperationRecord {
  assertTimestamp(now, "now");
  return Object.freeze({ ...record, ...patch, updatedAt: now });
}

/**
 * Mark the apply boundary durable before invoking the executor.  Repeating
 * this call for the same receipt is a no-op, so a caller never receives a
 * second permission to apply the same physical mutation.
 */
export function recordFileOperationApplyAttempt(
  state: FileOperationRegistryState,
  operationId: string,
  authorityToken?: string,
  now = new Date().toISOString(),
): FileOperationRecord {
  assertState(state);
  const normalizedOperationId = normalizeText(operationId, "operationId");
  const record = state.fileOperations.find((candidate) => candidate.operationId === normalizedOperationId);
  if (record === undefined) {
    throw new FileOperationError("FILE_OPERATION_INVALID", "Unknown operation_id", {
      operationId: normalizedOperationId,
    });
  }
  if (typeof authorityToken !== "string" || authorityToken.length === 0) {
    throw new FileOperationError(
      "FILE_OPERATION_AUTHORITY_DENIED",
      "Apply attempt requires the receipt authority token",
      {
        operationId: normalizedOperationId,
      },
    );
  }
  if (authorityToken !== record.authorityToken) {
    throw new FileOperationError(
      "FILE_OPERATION_AUTHORITY_DENIED",
      "Apply attempt authority token does not match receipt",
      {
        operationId: normalizedOperationId,
      },
    );
  }
  if (record.stage === "completed" || record.stage === "unresolved") {
    return record;
  }
  if (record.stage !== "prepared" && record.stage !== "apply-recorded") {
    throw new FileOperationError(
      "FILE_OPERATION_INVALID_TRANSITION",
      "Receipt cannot enter apply-recorded from its current stage",
      {
        operationId: normalizedOperationId,
        stage: record.stage,
      },
    );
  }
  if (record.stage === "apply-recorded") return record;
  const next = updatedRecord(
    record,
    {
      stage: "apply-recorded",
      applyAttempts: record.applyAttempts + 1,
    },
    now,
  );
  replaceRecord(state, next);
  return next;
}

function pathMatchesExpected(
  observation: FileOperationPathObservation | null,
  expectedPresent: boolean,
  expectedIdentity: FileIdentity | null,
  expectedPayloadDigest: string | null,
): boolean {
  if (observation === null || observation.present !== expectedPresent) return false;
  if (expectedPresent && expectedIdentity !== null) {
    if (observation.identity === undefined || observation.identity === null) return false;
    if (canonicalJson(observation.identity) !== canonicalJson(expectedIdentity)) return false;
  }
  if (expectedPresent && expectedPayloadDigest !== null && observation.payloadDigest !== expectedPayloadDigest) {
    return false;
  }
  if (!expectedPresent && observation.identity !== undefined && observation.identity !== null) return false;
  if (!expectedPresent && observation.payloadDigest !== undefined && observation.payloadDigest !== null) return false;
  return true;
}

function beforeMatchesExpected(
  observation: FileOperationPathObservation | null,
  expectedPresent: boolean,
  expectedIdentity: FileIdentity | null,
  expectedPayloadDigest: string | null,
): boolean {
  if (observation?.before === undefined) return false;
  if (expectedPresent && expectedIdentity === null) return false;
  if (observation.before === null)
    return !expectedPresent && expectedIdentity === null && expectedPayloadDigest === null;
  return pathFactMatchesExpected(observation.before, expectedPresent, expectedIdentity, expectedPayloadDigest);
}

function pathFactMatchesExpected(
  observation: FileOperationPathFact,
  expectedPresent: boolean,
  expectedIdentity: FileIdentity | null,
  expectedPayloadDigest: string | null,
): boolean {
  if (observation.present !== expectedPresent) return false;
  if (expectedPresent && expectedIdentity !== null) {
    if (observation.identity === undefined || observation.identity === null) return false;
    if (canonicalJson(observation.identity) !== canonicalJson(expectedIdentity)) return false;
  }
  if (expectedPresent && expectedPayloadDigest !== null && observation.payloadDigest !== expectedPayloadDigest) {
    return false;
  }
  if (!expectedPresent && observation.identity !== undefined && observation.identity !== null) return false;
  if (!expectedPresent && observation.payloadDigest !== undefined && observation.payloadDigest !== null) return false;
  return true;
}

/** Compare the explicit before/after facts without inferring execution completion. */
export function fileOperationEffectMatches(
  record: FileOperationRecord,
  observation: FileOperationObservation,
): boolean {
  assertRecord(record);
  if (observation.operationId !== undefined && observation.operationId !== record.operationId) return false;
  const source = observation.source;
  const destination = observation.destination;
  if (record.operation === "create") {
    return (
      source === null &&
      destination !== null &&
      pathMatchesExpected(destination, true, record.expectedIdentity, record.payloadDigest)
    );
  }
  if (record.operation === "delete") {
    return (
      source !== null &&
      destination === null &&
      pathMatchesExpected(source, false, null, null) &&
      beforeMatchesExpected(source, true, record.expectedIdentity, null)
    );
  }
  return (
    source !== null &&
    destination !== null &&
    pathMatchesExpected(source, false, null, null) &&
    beforeMatchesExpected(source, true, record.expectedIdentity, null) &&
    (destination.before === undefined ||
      destination.before === null ||
      pathFactMatchesExpected(destination.before, false, null, null)) &&
    pathMatchesExpected(destination, true, record.expectedIdentity, record.payloadDigest)
  );
}

/**
 * Reconcile an apply-recorded receipt against an executor observation.  A
 * matching effect without an explicit completion observation remains
 * unresolved by design: bytes/absence prove an effect was seen, not who
 * completed it or whether the apply response was delivered.
 */
export function reconcileFileOperationReceipt(
  record: FileOperationRecord,
  observation: FileOperationObservation,
  now = new Date().toISOString(),
): FileOperationReconciliation {
  assertRecord(record);
  if (!isRecord(observation)) {
    throw new FileOperationError("FILE_OPERATION_INVALID", "File-operation observation must be an object");
  }
  if (typeof observation.effectObserved !== "boolean" || typeof observation.executionCompleted !== "boolean") {
    throw new FileOperationError("FILE_OPERATION_INVALID", "Observation effect and completion flags must be booleans", {
      operationId: record.operationId,
    });
  }
  assertString(observation.authorityToken, "observation.authorityToken");
  assertFenceEpoch(observation.fenceEpoch, "observation.fenceEpoch");
  if (observation.authorityToken !== record.authorityToken || observation.fenceEpoch !== record.fenceEpoch) {
    throw new FileOperationError("FILE_OPERATION_AUTHORITY_DENIED", "Observation is not bound to this receipt fence", {
      operationId: record.operationId,
    });
  }
  if (observation.operationId !== undefined && observation.operationId !== record.operationId) {
    throw new FileOperationError("FILE_OPERATION_INVALID", "Observation operation_id does not match receipt", {
      operationId: record.operationId,
    });
  }
  if (record.stage === "completed" || record.stage === "unresolved") {
    return {
      record,
      effectMatches: record.effectObserved,
      completionProven: record.executionCompleted,
      disposition: record.stage,
    };
  }
  if (record.stage !== "apply-recorded") {
    throw new FileOperationError(
      "FILE_OPERATION_INVALID_TRANSITION",
      "Only apply-recorded receipts may be reconciled",
      {
        operationId: record.operationId,
        stage: record.stage,
      },
    );
  }
  const effectMatches = observation.effectObserved && fileOperationEffectMatches(record, observation);
  const completionProven = effectMatches && observation.executionCompleted;
  const next = updatedRecord(
    record,
    {
      stage: completionProven ? "completed" : "unresolved",
      effectObserved: effectMatches,
      executionCompleted: completionProven,
    },
    now,
  );
  return {
    record: next,
    effectMatches,
    completionProven,
    disposition: completionProven ? "completed" : "unresolved",
  };
}

function serializeRecord(record: FileOperationRecord): PersistedFileOperationRecord {
  assertRecord(record);
  return {
    schema_version: FILE_OPERATION_SCHEMA_VERSION,
    operation_id: record.operationId,
    session_id: record.sessionId,
    request_digest: record.requestDigest,
    operation: record.operation,
    source: record.source,
    destination: record.destination,
    expected_identity: record.expectedIdentity,
    payload_digest: record.payloadDigest,
    authority_token: record.authorityToken,
    fence_epoch: record.fenceEpoch,
    stage: record.stage,
    apply_attempts: record.applyAttempts,
    effect_observed: record.effectObserved,
    execution_completed: record.executionCompleted,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function serializeFileOperationRegistry(state: FileOperationRegistryState): PersistedFileOperationRegistry {
  assertState(state);
  return {
    schema_version: FILE_OPERATION_REGISTRY_SCHEMA_VERSION,
    file_operations: state.fileOperations.map(serializeRecord),
  };
}

function parseRecord(value: unknown): FileOperationRecord {
  if (!isRecord(value)) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "Persisted file-operation record is not an object");
  }
  if (value.schema_version !== FILE_OPERATION_SCHEMA_VERSION) {
    throw new FileOperationError("FILE_OPERATION_UNSUPPORTED_SCHEMA", "Unknown file-operation record version", {
      version: value.schema_version,
    });
  }
  const record = Object.freeze({
    schemaVersion: value.schema_version,
    operationId: value.operation_id,
    sessionId: value.session_id,
    requestDigest: value.request_digest,
    operation: value.operation,
    source: value.source,
    destination: value.destination,
    expectedIdentity: value.expected_identity,
    payloadDigest: value.payload_digest,
    authorityToken: value.authority_token,
    fenceEpoch: value.fence_epoch,
    stage: value.stage,
    applyAttempts: value.apply_attempts,
    effectObserved: value.effect_observed,
    executionCompleted: value.execution_completed,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }) as unknown as FileOperationRecord;
  assertRecord(record);
  return record;
}

export function parseFileOperationRegistry(value: unknown): FileOperationRegistryState {
  if (!isRecord(value) || value.schema_version !== FILE_OPERATION_REGISTRY_SCHEMA_VERSION) {
    throw new FileOperationError("FILE_OPERATION_UNSUPPORTED_SCHEMA", "Unknown file-operation registry version", {
      version: isRecord(value) ? value.schema_version : undefined,
    });
  }
  if (!Array.isArray(value.file_operations)) {
    throw new FileOperationError("FILE_OPERATION_CORRUPT", "file_operations must be an array");
  }
  const state: FileOperationRegistryState = {
    schemaVersion: FILE_OPERATION_REGISTRY_SCHEMA_VERSION,
    fileOperations: value.file_operations.map(parseRecord),
  };
  assertState(state);
  return state;
}
