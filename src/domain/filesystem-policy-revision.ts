import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { isSessionId } from "../session-id.js";

/** Versioned execution-fence contract for a protected filesystem policy. */
export const FILESYSTEM_POLICY_TOKEN_CONTRACT_ID = "nawabari.filesystem-policy-token.v1" as const;
export const FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION = 1 as const;
export const FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY = "filesystem-policy-token" as const;

/** Persisted surfaces that carry the same fence identity during integration. */
export const FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEYS = Object.freeze([
  "registry",
  "domain-session",
  "sandbox",
] as const);

export type FilesystemPolicyTokenSerializationSurface = (typeof FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEYS)[number];

/**
 * A snapshot of every producer generation that can change the authority used
 * by a protected execution.  The token is factual data only; it never reads
 * the registry, runtime, working set, profile, or host filesystem itself.
 */
export type FilesystemPolicyToken = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_TOKEN_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION;
  readonly serialization_key: typeof FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY;
  /** Registry state revision observed with the other fence components. */
  readonly registry_revision: number;
  /** Session runtime epoch captured for this execution. */
  readonly session_runtime_epoch: number | string;
  /** Resource-claim generation observed before launch. */
  readonly claim_set_generation: number;
  /** Effective Working Set revision used by this execution. */
  readonly working_set_revision: number;
  /** Digest of the pinned runtime-profile filesystem authority. */
  readonly profile_digest: string;
  /** Optional session binding retained when the caller has one. */
  readonly session_id?: string;
}>;

export type FilesystemPolicyTokenInput = Readonly<{
  readonly registry_revision: number;
  readonly session_runtime_epoch: number | string;
  readonly claim_set_generation: number;
  readonly working_set_revision: number;
  readonly profile_digest: string;
  readonly session_id?: string;
}>;

const MAX_TEXT = 256;
const SHA256 = /^[0-9a-f]{64}$/iu;
type TokenRecord = Record<string, unknown>;

function isRecord(value: unknown): value is TokenRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isRecord(value)) {
    const result: TokenRecord = {};
    for (const key of Object.keys(value).sort(compare)) result[key] = stableClone(value[key]);
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Filesystem policy token field '${field}' is invalid: ${reason}.`, {
      field,
    }),
  );
}

function stale(field: string, actual: unknown, expected: unknown): DomainResult<never> {
  return failure(
    new DomainError("STALE_REGISTRY", `Filesystem policy execution fence is stale at '${field}'.`, {
      field,
      actual: typeof actual === "string" || typeof actual === "number" ? actual : String(actual),
      expected: typeof expected === "string" || typeof expected === "number" ? expected : String(expected),
    }),
  );
}

function boundedText(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || value.includes("\u0000")) {
    return invalid(field, "expected bounded non-empty text");
  }
  return success(value.normalize("NFC"));
}

function nonNegativeInteger(value: unknown, field: string): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalid(field, "expected a non-negative safe integer");
  }
  return success(value as number);
}

function positiveInteger(value: unknown, field: string): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return invalid(field, "expected a positive safe integer");
  }
  return success(value as number);
}

function epoch(value: unknown, field: string): DomainResult<number | string> {
  if (typeof value === "number") return nonNegativeInteger(value, field);
  return boundedText(value, field);
}

function profileDigest(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field);
  if (!text.ok) return text;
  if (!SHA256.test(text.value)) return invalid(field, "expected a SHA-256 digest");
  return success(text.value.toLowerCase());
}

function sessionId(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field);
  if (!text.ok) return text;
  if (!isSessionId(text.value)) return invalid(field, "expected a canonical UUIDv7 session identity");
  return success(text.value);
}

function validateTokenShape(value: unknown, field: string): DomainResult<FilesystemPolicyToken> {
  if (!isRecord(value)) return invalid(field, "expected an object");
  if (value.contract_id !== FILESYSTEM_POLICY_TOKEN_CONTRACT_ID)
    return invalid(`${field}.contract_id`, "unsupported contract");
  if (value.schema_version !== FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION)
    return invalid(`${field}.schema_version`, "unsupported schema version");
  if (value.serialization_key !== FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY)
    return invalid(`${field}.serialization_key`, "unsupported serialization key");

  const registryRevision = nonNegativeInteger(value.registry_revision, `${field}.registry_revision`);
  if (!registryRevision.ok) return registryRevision;
  const runtimeEpoch = epoch(value.session_runtime_epoch, `${field}.session_runtime_epoch`);
  if (!runtimeEpoch.ok) return runtimeEpoch;
  const claimGeneration = nonNegativeInteger(value.claim_set_generation, `${field}.claim_set_generation`);
  if (!claimGeneration.ok) return claimGeneration;
  const workingSetRevision = positiveInteger(value.working_set_revision, `${field}.working_set_revision`);
  if (!workingSetRevision.ok) return workingSetRevision;
  const digest = profileDigest(value.profile_digest, `${field}.profile_digest`);
  if (!digest.ok) return digest;
  const identity =
    value.session_id === undefined
      ? success<string | undefined>(undefined)
      : sessionId(value.session_id, `${field}.session_id`);
  if (!identity.ok) return identity;

  return success(
    Object.freeze({
      contract_id: FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
      schema_version: FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
      serialization_key: FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
      registry_revision: registryRevision.value,
      session_runtime_epoch: runtimeEpoch.value,
      claim_set_generation: claimGeneration.value,
      working_set_revision: workingSetRevision.value,
      profile_digest: digest.value,
      ...(identity.value === undefined ? {} : { session_id: identity.value }),
    }),
  );
}

/**
 * Build one immutable execution fence from already-observed producer facts.
 * This function does not observe or mutate any producer authority.
 */
export function createFilesystemPolicyToken(
  input: FilesystemPolicyTokenInput | unknown,
): DomainResult<FilesystemPolicyToken> {
  if (!isRecord(input)) return invalid("input", "expected an object");
  return validateTokenShape(
    {
      contract_id: FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
      schema_version: FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
      serialization_key: FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
      registry_revision: input.registry_revision,
      session_runtime_epoch: input.session_runtime_epoch,
      claim_set_generation: input.claim_set_generation,
      working_set_revision: input.working_set_revision,
      profile_digest: input.profile_digest,
      ...(input.session_id === undefined ? {} : { session_id: input.session_id }),
    },
    "token",
  );
}

function compareTokenFields(
  actual: FilesystemPolicyToken,
  expected: FilesystemPolicyToken,
): DomainResult<FilesystemPolicyToken> {
  for (const field of [
    "registry_revision",
    "session_runtime_epoch",
    "claim_set_generation",
    "working_set_revision",
    "profile_digest",
    "session_id",
  ] as const) {
    const actualValue = actual[field];
    const expectedValue = expected[field];
    if (stableJson(actualValue) !== stableJson(expectedValue)) return stale(field, actualValue, expectedValue);
  }
  return success(actual);
}

/**
 * Validate a token and, when supplied, compare it with the freshly observed
 * expected fence.  Any generation mismatch is a hard stale result: callers
 * must not relaunch under the old effective authority.
 */
export function validateFilesystemPolicyToken(
  actual: unknown,
  expected?: unknown,
): DomainResult<FilesystemPolicyToken> {
  const actualToken = validateTokenShape(actual, "actual");
  if (!actualToken.ok) return actualToken;
  if (expected === undefined) return actualToken;
  const expectedToken = validateTokenShape(expected, "expected");
  if (!expectedToken.ok) return expectedToken;
  return compareTokenFields(actualToken.value, expectedToken.value);
}

/** Return true only when both tokens are valid and every fence component matches. */
export function isFilesystemPolicyTokenCurrent(actual: unknown, expected: unknown): boolean {
  return validateFilesystemPolicyToken(actual, expected).ok;
}

/**
 * Serialize a validated token without consulting host state.  The canonical
 * key order is stable even when the input object was assembled differently.
 */
export function serializeFilesystemPolicyToken(input: unknown): DomainResult<string> {
  const token = validateFilesystemPolicyToken(input);
  return token.ok ? success(stableJson(token.value)) : failure(token.error);
}

/** The fields that must be equal before a protected process may start. */
export const FILESYSTEM_POLICY_TOKEN_FENCE_FIELDS = Object.freeze([
  "registry_revision",
  "session_runtime_epoch",
  "claim_set_generation",
  "working_set_revision",
  "profile_digest",
  "session_id",
] as const);
