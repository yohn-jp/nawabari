import { createHash } from "node:crypto";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { validateAuxiliaryStateDeclaration, type AuxiliaryStateDeclaration } from "./auxiliary-state-projection.js";
import {
  assertCanonicalClaimResource,
  canonicalClaimId,
  claimModeGrantsAccess,
  RESOURCE_CLAIM_SCHEMA_VERSION,
  resourceMatchesClaim,
  type ResourceClaim,
  type ResourceClaimMode,
} from "../resource-claims.js";
import { isSessionId } from "../session-id.js";
import { EFFECTIVE_WORKING_SET_KIND, EFFECTIVE_WORKING_SET_VERSION, type RepositoryIdentity } from "../working-set.js";

/** Stable identity for the operation-level filesystem policy contract. */
export const EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID = "nawabari.effective-filesystem-policy.v1" as const;
export const EFFECTIVE_FILESYSTEM_POLICY_SCHEMA_VERSION = 1 as const;
export const FILESYSTEM_POLICY_SERIALIZATION_KEY = "filesystem-policy" as const;

export const EFFECTIVE_FILESYSTEM_OPERATIONS = Object.freeze([
  "READONLY",
  "WRITE",
  "CREATE",
  "DELETE",
  "RENAME",
] as const);
export type EffectiveFilesystemOperation = (typeof EFFECTIVE_FILESYSTEM_OPERATIONS)[number];
export type EffectiveFilesystemDomain = "repository" | "runtime" | "package" | "infrastructure";
export type FilesystemPolicyBoundaryStatus = "applied" | "unapplied-legacy" | "unknown";
export type FilesystemDecisionStatus = "allow" | "deny" | "unresolved";

export function isEffectiveFilesystemOperation(value: unknown): value is EffectiveFilesystemOperation {
  return typeof value === "string" && EFFECTIVE_FILESYSTEM_OPERATIONS.includes(value as EffectiveFilesystemOperation);
}

const SCOPE_KEYS = ["readOnly", "write", "create", "delete", "rename", "deny", "immutable"] as const;
type ScopeKey = (typeof SCOPE_KEYS)[number];
const MAX_SELECTORS = 4_096;
const MAX_CLAIMS = 4_096;
const MAX_TEXT = 2_048;

type UnknownRecord = Record<string, unknown>;

export type FilesystemPolicySelector = Readonly<{
  readonly path: string;
  readonly domain?: EffectiveFilesystemDomain;
}>;

export type EffectiveFilesystemScope = Readonly<{
  readonly readOnly: readonly FilesystemPolicySelector[];
  readonly write: readonly FilesystemPolicySelector[];
  readonly create: readonly FilesystemPolicySelector[];
  readonly delete: readonly FilesystemPolicySelector[];
  readonly rename: readonly FilesystemPolicySelector[];
  readonly deny: readonly FilesystemPolicySelector[];
  readonly immutable: readonly FilesystemPolicySelector[];
}>;

/** A bounded factual input for a single producer authority. */
export type FilesystemPolicyBoundary = Readonly<{
  readonly status?: FilesystemPolicyBoundaryStatus;
  readonly identity?: string;
  readonly digest?: string;
  readonly revision?: number | string | null;
  readonly epoch?: number | string | null;
  readonly scope?: unknown;
}>;

export type FilesystemBackendRequirement = Readonly<{
  readonly operation: EffectiveFilesystemOperation;
  readonly path: string;
  readonly destination?: string;
  readonly domain?: EffectiveFilesystemDomain;
  readonly status?: FilesystemPolicyBoundaryStatus;
}>;

export type EffectiveFilesystemPolicyInputs = Readonly<{
  /** Worktree Runtime Profile filesystem baseline. */
  readonly profile?: unknown;
  readonly worktree_profile?: unknown;
  readonly worktreeProfile?: unknown;
  /** Effective Working Set; a scope object is accepted only as factual input. */
  readonly working_set?: unknown;
  readonly workingSet?: unknown;
  /** Resource-coordination claims and their observed registry generation. */
  readonly claims?: readonly ResourceClaim[] | unknown;
  readonly resource_claims?: readonly ResourceClaim[] | unknown;
  readonly claim_set_generation?: number | null;
  readonly claimSetGeneration?: number | null;
  /** Explicit repository-local auxiliary state declarations. */
  readonly auxiliary_state?: readonly AuxiliaryStateDeclaration[] | unknown;
  readonly auxiliaryState?: readonly AuxiliaryStateDeclaration[] | unknown;
  /** Runtime epoch is intentionally explicit; host observation is not performed here. */
  readonly runtime_epoch?: number | string | null;
  readonly runtimeEpoch?: number | string | null;
  readonly runtime_status?: FilesystemPolicyBoundaryStatus;
  readonly runtime?: { readonly epoch?: number | string | null; readonly status?: FilesystemPolicyBoundaryStatus };
  /** Backend CREATE/DELETE/rename requirements are a separate authority. */
  readonly backend_requirements?: readonly FilesystemBackendRequirement[] | unknown;
  readonly backendRequirements?: readonly FilesystemBackendRequirement[] | unknown;
  readonly repository?: RepositoryIdentity;
  readonly base?: unknown;
  readonly worktree_path?: string;
  readonly worktreePath?: string;
}>;

type CompiledBoundary = Readonly<{
  readonly status: FilesystemPolicyBoundaryStatus;
  readonly identity: string | null;
  readonly digest: string | null;
  readonly revision: number | string | null;
  readonly epoch: number | string | null;
  readonly scope: EffectiveFilesystemScope;
}>;

type CompiledClaimAuthority = Readonly<{
  readonly status: FilesystemPolicyBoundaryStatus;
  readonly generation: number | null;
  readonly claims: readonly ResourceClaim[];
}>;

type CompiledBackendAuthority = Readonly<{
  readonly status: FilesystemPolicyBoundaryStatus;
  readonly requirements: readonly FilesystemBackendRequirement[];
}>;

export type EffectiveFilesystemPolicy = Readonly<{
  readonly contract_id: typeof EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID;
  readonly schema_version: typeof EFFECTIVE_FILESYSTEM_POLICY_SCHEMA_VERSION;
  readonly serialization_key: typeof FILESYSTEM_POLICY_SERIALIZATION_KEY;
  readonly digest: string;
  readonly profile: CompiledBoundary;
  readonly working_set: CompiledBoundary;
  readonly claims: CompiledClaimAuthority;
  readonly backend: CompiledBackendAuthority;
  readonly auxiliary: CompiledBoundary;
  readonly provenance: Readonly<{
    readonly profile_digest: string | null;
    readonly working_set_revision: number | string | null;
    readonly claim_set_generation: number | null;
    readonly runtime_epoch: number | string | null;
  }>;
  readonly legacy_boundaries: readonly string[];
}>;

export type EffectivePathAccessFacts = Readonly<{
  readonly policy: EffectiveFilesystemPolicy;
  readonly operation: EffectiveFilesystemOperation;
  readonly path: string;
  readonly destination?: string;
  readonly domain?: EffectiveFilesystemDomain;
}>;

export type EffectivePathAccessReason = Readonly<{
  readonly authority: string;
  readonly status: "allowed" | "denied" | "unresolved" | "legacy";
  readonly reason: string;
}>;

export type EffectivePathAccessDecision = Readonly<{
  readonly operation: EffectiveFilesystemOperation;
  readonly path: string;
  readonly destination?: string;
  readonly domain: EffectiveFilesystemDomain;
  readonly allowed: boolean;
  readonly status: FilesystemDecisionStatus;
  readonly decision: FilesystemDecisionStatus;
  readonly reason: string;
  readonly reasons: readonly EffectivePathAccessReason[];
  readonly legacy_boundaries: readonly string[];
  readonly provenance: EffectiveFilesystemPolicy["provenance"];
}>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isRecord(value)) {
    const result: UnknownRecord = {};
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
    new DomainError("RUNTIME_PROJECTION_INVALID", `Filesystem policy field '${field}' is invalid: ${reason}.`, {
      field,
    }),
  );
}

function text(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || value.includes("\u0000")) {
    return invalid(field, "expected bounded non-empty text");
  }
  return success(value.normalize("NFC"));
}

function positiveInteger(value: unknown, field: string): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(field, "expected a positive integer");
  return success(value as number);
}

function identityKey(value: unknown, field: string): DomainResult<string> {
  const parsed = text(value, field);
  if (!parsed.ok) return parsed;
  return success(parsed.value);
}

function domain(value: unknown, field: string): DomainResult<EffectiveFilesystemDomain> {
  if (value === undefined) return success("repository");
  if (value === "repository" || value === "runtime" || value === "package" || value === "infrastructure") {
    return success(value);
  }
  return invalid(field, "unsupported projection domain");
}

function normalizePath(value: unknown, field: string, selectedDomain: EffectiveFilesystemDomain): DomainResult<string> {
  const parsed = text(value, field);
  if (!parsed.ok) return parsed;
  const normalized = parsed.value.replaceAll("\\", "/");
  const absolute = normalized.startsWith("/");
  if (/^[A-Za-z]:/u.test(normalized)) return invalid(field, "drive-qualified paths are not canonical namespace paths");
  if (selectedDomain === "repository") {
    const relative = normalized.replace(/^\.\//u, "");
    if (
      relative.length === 0 ||
      relative.startsWith("/") ||
      relative.includes("//") ||
      relative.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return invalid(field, "expected a normalized repository-relative selector");
    }
    return success(relative);
  }
  const segments = normalized.split("/").slice(1);
  if (!absolute || normalized.includes("//") || segments.some((part) => part === "" || part === "." || part === "..")) {
    return invalid(field, "expected a normalized absolute projection path");
  }
  return success(normalized);
}

function selector(
  value: unknown,
  field: string,
  fallbackDomain: EffectiveFilesystemDomain,
): DomainResult<FilesystemPolicySelector> {
  if (typeof value === "string") {
    const pathValue = normalizePath(value, field, fallbackDomain);
    if (!pathValue.ok) return pathValue;
    return success(Object.freeze({ path: pathValue.value, domain: fallbackDomain }));
  }
  if (!isRecord(value)) return invalid(field, "expected a selector string or object");
  const selectedDomain = domain(value.domain, `${field}.domain`);
  if (!selectedDomain.ok) return selectedDomain;
  const pathValue = normalizePath(value.path, `${field}.path`, selectedDomain.value);
  if (!pathValue.ok) return pathValue;
  return success(Object.freeze({ path: pathValue.value, domain: selectedDomain.value }));
}

function emptyScope(): EffectiveFilesystemScope {
  return Object.freeze({
    readOnly: Object.freeze([]),
    write: Object.freeze([]),
    create: Object.freeze([]),
    delete: Object.freeze([]),
    rename: Object.freeze([]),
    deny: Object.freeze([]),
    immutable: Object.freeze([]),
  });
}

function scopeFromValue(
  value: unknown,
  field: string,
  fallbackDomain: EffectiveFilesystemDomain = "repository",
): DomainResult<EffectiveFilesystemScope> {
  if (!isRecord(value)) return invalid(field, "expected a scope object");
  const result = {} as Record<ScopeKey, readonly FilesystemPolicySelector[]>;
  for (const key of SCOPE_KEYS) {
    const rawInput = readAliasedValue(value, `${field}.${key}`, key === "rename" ? ["rename", "renames"] : [key]);
    if (!rawInput.ok) return rawInput;
    const raw = rawInput.value ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_SELECTORS)
      return invalid(`${field}.${key}`, "expected a bounded array");
    const parsed: FilesystemPolicySelector[] = [];
    for (const [index, entry] of raw.entries()) {
      const item = selector(entry, `${field}.${key}[${index}]`, fallbackDomain);
      if (!item.ok) return item;
      parsed.push(item.value);
    }
    parsed.sort((left, right) => compare(`${left.domain}:${left.path}`, `${right.domain}:${right.path}`));
    result[key] = Object.freeze(parsed);
  }
  return success(Object.freeze(result));
}

function scopeFromBoundary(value: unknown, field: string): DomainResult<EffectiveFilesystemScope> {
  if (value === undefined) return success(emptyScope());
  if (!isRecord(value)) return invalid(field, "expected a boundary object");
  const nested = readAliasedValue(value, `${field}.scope`, ["scope", "filesystem", "paths"]);
  if (!nested.ok) return nested;
  return scopeFromValue(nested.value === undefined ? value : nested.value, `${field}.scope`, "repository");
}

function boundaryStatus(
  value: unknown,
  field: string,
  defaultStatus: FilesystemPolicyBoundaryStatus,
): DomainResult<FilesystemPolicyBoundaryStatus> {
  if (value === undefined) return success(defaultStatus);
  if (value === "applied" || value === "unapplied-legacy" || value === "unknown") return success(value);
  return invalid(field, "unsupported boundary status");
}

function compileBoundary(
  value: unknown,
  field: string,
  defaultStatus: FilesystemPolicyBoundaryStatus = "unapplied-legacy",
): DomainResult<CompiledBoundary> {
  if (value === undefined || value === null) {
    return success(
      Object.freeze({
        status: "unapplied-legacy",
        identity: null,
        digest: null,
        revision: null,
        epoch: null,
        scope: emptyScope(),
      }),
    );
  }
  if (!isRecord(value)) return invalid(field, "expected a boundary object");
  const status = boundaryStatus(value.status, `${field}.status`, defaultStatus);
  if (!status.ok) return status;
  const scopeValue = scopeFromBoundary(value, field);
  if (!scopeValue.ok) return scopeValue;
  const identityValue =
    value.identity === undefined ? success<string | null>(null) : identityKey(value.identity, `${field}.identity`);
  if (!identityValue.ok) return identityValue;
  const digestValue = readAliasedValue(value, `${field}.digest`, ["digest", "profile_digest", "profileDigest"]);
  if (!digestValue.ok) return digestValue;
  const digest =
    digestValue.value === undefined ? success<string | null>(null) : identityKey(digestValue.value, `${field}.digest`);
  if (!digest.ok) return digest;
  let revisionValue: number | string | null = null;
  if (value.revision !== undefined && value.revision !== null) {
    if (typeof value.revision === "string") revisionValue = value.revision;
    else if (Number.isSafeInteger(value.revision) && (value.revision as number) >= 1)
      revisionValue = value.revision as number;
    else return invalid(`${field}.revision`, "expected a positive revision");
  }
  let epochValue: number | string | null = null;
  if (value.epoch !== undefined && value.epoch !== null) {
    if (typeof value.epoch === "string") epochValue = value.epoch;
    else if (Number.isSafeInteger(value.epoch) && (value.epoch as number) >= 1) epochValue = value.epoch as number;
    else return invalid(`${field}.epoch`, "expected a positive epoch");
  }
  if (status.value === "applied" && digest.value === null && field === "profile")
    return invalid(`${field}.digest`, "applied profile requires a digest");
  if (status.value === "unknown")
    return success(
      Object.freeze({
        status: status.value,
        identity: identityValue.value,
        digest: digest.value,
        revision: revisionValue,
        epoch: epochValue,
        scope: emptyScope(),
      }),
    );
  return success(
    Object.freeze({
      status: status.value,
      identity: identityValue.value,
      digest: digest.value,
      revision: revisionValue,
      epoch: epochValue,
      scope: scopeValue.value,
    }),
  );
}

function claimsArray(value: unknown, field: string): DomainResult<readonly ResourceClaim[]> {
  if (value === undefined || value === null) return success(Object.freeze([]));
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) return invalid(field, "expected a bounded claim array");
  const result: ResourceClaim[] = [];
  for (const [index, claim] of value.entries()) {
    if (!isRecord(claim)) return invalid(`${field}[${index}]`, "expected a claim object");
    if (claim.schemaVersion !== RESOURCE_CLAIM_SCHEMA_VERSION)
      return invalid(`${field}[${index}].schemaVersion`, "unsupported claim schema");
    if (
      typeof claim.claimId !== "string" ||
      typeof claim.sessionId !== "string" ||
      typeof claim.repositoryId !== "string" ||
      typeof claim.worktreePath !== "string" ||
      typeof claim.resource !== "string" ||
      typeof claim.mode !== "string"
    )
      return invalid(`${field}[${index}]`, "canonical claim identity fields are required");
    if (claim.mode !== "read" && claim.mode !== "write" && claim.mode !== "exclusive-write")
      return invalid(`${field}[${index}].mode`, "unsupported claim mode");
    if (!isSessionId(claim.sessionId)) return invalid(`${field}[${index}].sessionId`, "invalid session identity");
    const repositoryId = text(claim.repositoryId, `${field}[${index}].repositoryId`);
    if (!repositoryId.ok) return repositoryId;
    if (
      !path.isAbsolute(claim.worktreePath) ||
      path.normalize(claim.worktreePath) !== claim.worktreePath ||
      claim.worktreePath.includes("\u0000")
    )
      return invalid(`${field}[${index}].worktreePath`, "expected an absolute normalized worktree identity");
    try {
      assertCanonicalClaimResource(claim.resource);
    } catch {
      return invalid(`${field}[${index}].resource`, "claim resource is not canonical");
    }
    if (canonicalClaimId(claim.sessionId, claim.resource, claim.mode) !== claim.claimId)
      return invalid(`${field}[${index}].claimId`, "claim id does not match canonical identity");
    const createdAt = canonicalClaimTimestamp(claim.createdAt, `${field}[${index}].createdAt`);
    if (!createdAt.ok) return createdAt;
    const updatedAt = canonicalClaimTimestamp(claim.updatedAt, `${field}[${index}].updatedAt`);
    if (!updatedAt.ok) return updatedAt;
    result.push(
      Object.freeze({
        schemaVersion: RESOURCE_CLAIM_SCHEMA_VERSION,
        claimId: claim.claimId,
        sessionId: claim.sessionId,
        repositoryId: repositoryId.value,
        worktreePath: claim.worktreePath,
        resource: claim.resource,
        mode: claim.mode,
        createdAt: createdAt.value,
        updatedAt: updatedAt.value,
      }),
    );
  }
  result.sort((left, right) =>
    compare(`${left.resource}:${left.mode}:${left.claimId}`, `${right.resource}:${right.mode}:${right.claimId}`),
  );
  return success(Object.freeze(result));
}

function claimGeneration(value: unknown, field: string): DomainResult<number | null> {
  if (value === undefined || value === null) return success(null);
  return positiveInteger(value, field);
}

function canonicalClaimTimestamp(value: unknown, field: string): DomainResult<string> {
  const parsed = text(value, field);
  if (!parsed.ok) return parsed;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parsed.value) ||
    Number.isNaN(Date.parse(parsed.value)) ||
    new Date(parsed.value).toISOString() !== parsed.value
  ) {
    return invalid(field, "expected a canonical UTC timestamp");
  }
  return parsed;
}

function workingSetBoundary(value: unknown): DomainResult<CompiledBoundary> {
  if (value === undefined || value === null) return compileBoundary(undefined, "working_set");
  if (!isRecord(value)) return invalid("working_set", "expected an Effective Working Set or scope object");
  const parsedStatus = boundaryStatus(value.status, "working_set.status", "applied");
  if (!parsedStatus.ok) return parsedStatus;
  if (parsedStatus.value === "unknown")
    return success(
      Object.freeze({
        status: "unknown",
        identity: typeof value.id === "string" ? value.id : null,
        digest: null,
        revision: null,
        epoch: null,
        scope: emptyScope(),
      }),
    );
  if (parsedStatus.value === "unapplied-legacy")
    return success(
      Object.freeze({
        status: "unapplied-legacy",
        identity: null,
        digest: null,
        revision: null,
        epoch: null,
        scope: emptyScope(),
      }),
    );
  if (value.version !== EFFECTIVE_WORKING_SET_VERSION || value.kind !== EFFECTIVE_WORKING_SET_KIND)
    return invalid("working_set", "applied working set requires the canonical contract identity");
  if (typeof value.id !== "string" || value.id.length === 0)
    return invalid("working_set.id", "applied working set requires an identity");
  const repository = repositoryIdentity(value.repository, "working_set.repository");
  if (!repository.ok) return repository;
  const base = baseIdentity(value.base, "working_set.base");
  if (!base.ok) return base;
  const scopeValue = value.scope ?? value;
  const scope = scopeFromValue(scopeValue, "working_set.scope");
  if (!scope.ok) return scope;
  let revision: number | string | null = null;
  if (value.revision !== undefined && value.revision !== null) {
    if (typeof value.revision === "string") revision = value.revision;
    else if (Number.isSafeInteger(value.revision) && (value.revision as number) >= 1)
      revision = value.revision as number;
    else return invalid("working_set.revision", "expected a positive revision");
  }
  if (revision === null) return invalid("working_set.revision", "applied working set requires a revision");
  return success(
    Object.freeze({
      status: parsedStatus.value,
      identity: value.id,
      digest: null,
      revision,
      epoch: null,
      scope: scope.value,
    }),
  );
}

function auxiliaryBoundary(value: unknown): DomainResult<CompiledBoundary> {
  if (value === undefined || value === null) return compileBoundary(undefined, "auxiliary");
  const sourceValue = isRecord(value)
    ? readAliasedValue(value, "auxiliary_state.declarations", ["declarations", "items"])
    : success(value);
  if (!sourceValue.ok) return sourceValue;
  const source = sourceValue.value;
  const parsedStatus = boundaryStatus(isRecord(value) ? value.status : undefined, "auxiliary_state.status", "applied");
  if (!parsedStatus.ok) return parsedStatus;
  if (source === undefined || source === null) {
    if (parsedStatus.value === "unknown" || parsedStatus.value === "unapplied-legacy")
      return success(
        Object.freeze({
          status: parsedStatus.value,
          identity: null,
          digest: null,
          revision: null,
          epoch: null,
          scope: emptyScope(),
        }),
      );
    return invalid("auxiliary_state", "applied auxiliary state requires declarations");
  }
  if (!Array.isArray(source) || source.length > MAX_SELECTORS)
    return invalid("auxiliary_state", "expected a bounded declaration array");
  const readOnly: FilesystemPolicySelector[] = [];
  for (const [index, item] of source.entries()) {
    const declaration = validateAuxiliaryStateDeclaration(item);
    if (!declaration.ok) return invalid(`auxiliary_state[${index}]`, declaration.error.message);
    const target = selector(declaration.value.target.path, `auxiliary_state[${index}].target.path`, "repository");
    if (!target.ok) return target;
    readOnly.push(target.value);
  }
  if (parsedStatus.value !== "applied")
    return success(
      Object.freeze({
        status: parsedStatus.value,
        identity: null,
        digest: null,
        revision: null,
        epoch: null,
        scope: emptyScope(),
      }),
    );
  return success(
    Object.freeze({
      status: parsedStatus.value,
      identity: null,
      digest: null,
      revision: null,
      epoch: null,
      scope: Object.freeze({
        ...emptyScope(),
        readOnly: Object.freeze(
          readOnly
            .sort((left, right) => compare(`${left.domain}:${left.path}`, `${right.domain}:${right.path}`))
            .filter(
              (entry, index, entries) =>
                index === 0 ||
                `${entry.domain}:${entry.path}` !== `${entries[index - 1]?.domain}:${entries[index - 1]?.path}`,
            ),
        ),
      }),
    }),
  );
}

function backendBoundary(value: unknown): DomainResult<CompiledBackendAuthority> {
  if (value === undefined || value === null)
    return success(Object.freeze({ status: "unapplied-legacy", requirements: Object.freeze([]) }));
  const sourceInput = isRecord(value)
    ? readAliasedValue(value, "backend_requirements.requirements", ["requirements", "items"])
    : success(value);
  if (!sourceInput.ok) return sourceInput;
  const source = sourceInput.value;
  const parsedStatus = boundaryStatus(
    isRecord(value) ? value.status : undefined,
    "backend_requirements.status",
    "applied",
  );
  if (!parsedStatus.ok) return parsedStatus;
  if (parsedStatus.value === "unknown")
    return success(Object.freeze({ status: "unknown", requirements: Object.freeze([]) }));
  if (!Array.isArray(source) || source.length > MAX_SELECTORS)
    return invalid("backend_requirements", "expected a bounded requirement array");
  const requirements: FilesystemBackendRequirement[] = [];
  for (const [index, item] of source.entries()) {
    if (!isRecord(item)) return invalid(`backend_requirements[${index}]`, "expected an object");
    const operation = item.operation;
    if (!EFFECTIVE_FILESYSTEM_OPERATIONS.includes(operation as EffectiveFilesystemOperation))
      return invalid(`backend_requirements[${index}].operation`, "unsupported operation");
    const selectedDomain = domain(item.domain, `backend_requirements[${index}].domain`);
    if (!selectedDomain.ok) return selectedDomain;
    const pathValue = normalizePath(item.path, `backend_requirements[${index}].path`, selectedDomain.value);
    if (!pathValue.ok) return pathValue;
    const destination =
      item.destination === undefined
        ? undefined
        : normalizePath(item.destination, `backend_requirements[${index}].destination`, selectedDomain.value);
    if (destination !== undefined && !destination.ok) return destination;
    if (operation === "RENAME" && destination === undefined)
      return invalid(`backend_requirements[${index}].destination`, "rename requires a destination");
    const status = boundaryStatus(item.status, `backend_requirements[${index}].status`, "applied");
    if (!status.ok) return status;
    requirements.push(
      Object.freeze({
        operation: operation as EffectiveFilesystemOperation,
        path: pathValue.value,
        ...(destination === undefined ? {} : { destination: destination.value }),
        domain: selectedDomain.value,
        status: status.value,
      }),
    );
  }
  requirements.sort((left, right) =>
    compare(
      `${left.operation}:${left.domain}:${left.path}:${left.destination ?? ""}`,
      `${right.operation}:${right.domain}:${right.path}:${right.destination ?? ""}`,
    ),
  );
  const unknown = requirements.some((item) => item.status === "unknown");
  return success(
    Object.freeze({ status: unknown ? "unknown" : parsedStatus.value, requirements: Object.freeze(requirements) }),
  );
}

function readAliasedValue(inputs: UnknownRecord, field: string, keys: readonly string[]): DomainResult<unknown> {
  const supplied = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(inputs, key) && inputs[key] !== undefined)
    .map((key) => ({ key, value: inputs[key] }));
  if (supplied.length === 0) return success(undefined);
  const canonical = stableJson(supplied[0]?.value);
  if (supplied.some((entry) => stableJson(entry.value) !== canonical)) {
    return invalid(field, `conflicting aliases '${supplied.map((entry) => entry.key).join("', '")}'`);
  }
  return success(supplied[0]?.value);
}

function runtimeEpoch(inputs: UnknownRecord): DomainResult<number | string | null> {
  if (inputs.runtime !== undefined && !isRecord(inputs.runtime))
    return invalid("runtime", "expected a runtime authority object");
  const runtime = isRecord(inputs.runtime) ? inputs.runtime : undefined;
  const topLevel = readAliasedValue(inputs, "runtime_epoch", ["runtime_epoch", "runtimeEpoch"]);
  if (!topLevel.ok) return topLevel;
  const values = [topLevel.value, runtime?.epoch].filter((value): value is unknown => value !== undefined);
  if (values.length > 1 && values.some((value) => stableJson(value) !== stableJson(values[0]))) {
    return invalid("runtime_epoch", "conflicting runtime epoch authorities");
  }
  const value = values[0] ?? null;
  if (value === undefined || value === null) return success(null);
  if (typeof value === "number") return positiveInteger(value, "runtime_epoch");
  return text(value, "runtime_epoch");
}

function runtimeStatus(inputs: UnknownRecord): DomainResult<FilesystemPolicyBoundaryStatus> {
  if (inputs.runtime !== undefined && !isRecord(inputs.runtime))
    return invalid("runtime", "expected a runtime authority object");
  const runtime = isRecord(inputs.runtime) ? inputs.runtime : undefined;
  const values = [inputs.runtime_status, runtime?.status].filter((value): value is unknown => value !== undefined);
  if (values.length > 1 && values.some((value) => stableJson(value) !== stableJson(values[0]))) {
    return invalid("runtime_status", "conflicting runtime status authorities");
  }
  return boundaryStatus(values[0], "runtime_status", "applied");
}

type FilesystemRepositoryIdentity = Readonly<{
  readonly repositoryHost: string;
  readonly repositoryId: string;
}>;

function repositoryIdentity(value: unknown, field: string): DomainResult<FilesystemRepositoryIdentity> {
  if (!isRecord(value)) return invalid(field, "expected a repository identity object");
  const host = text(value.repositoryHost, `${field}.repositoryHost`);
  if (!host.ok) return host;
  const id = text(value.repositoryId, `${field}.repositoryId`);
  if (!id.ok) return id;
  return success(Object.freeze({ repositoryHost: host.value, repositoryId: id.value }));
}

function currentRepository(inputs: UnknownRecord): DomainResult<FilesystemRepositoryIdentity | null> {
  if (inputs.repository === undefined) return success(null);
  return repositoryIdentity(inputs.repository, "repository");
}

type FilesystemBaseIdentity = Readonly<{
  readonly branch: string;
  readonly revision: string;
  readonly freshness?: string;
}>;

function baseIdentity(value: unknown, field: string): DomainResult<FilesystemBaseIdentity> {
  if (!isRecord(value)) return invalid(field, "expected a base identity object");
  const branch = text(value.branch, `${field}.branch`);
  if (!branch.ok) return branch;
  const revision = text(value.revision, `${field}.revision`);
  if (!revision.ok) return revision;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revision.value))
    return invalid(`${field}.revision`, "expected an immutable hexadecimal revision");
  if (value.freshness !== undefined) {
    const freshness = text(value.freshness, `${field}.freshness`);
    if (!freshness.ok) return freshness;
    return success(
      Object.freeze({ branch: branch.value, revision: revision.value.toLowerCase(), freshness: freshness.value }),
    );
  }
  return success(Object.freeze({ branch: branch.value, revision: revision.value.toLowerCase() }));
}

function currentBase(inputs: UnknownRecord): DomainResult<FilesystemBaseIdentity | null> {
  if (inputs.base === undefined) return success(null);
  return baseIdentity(inputs.base, "base");
}

function currentWorktree(inputs: UnknownRecord): DomainResult<string | null> {
  const selected = readAliasedValue(inputs, "worktree_path", ["worktree_path", "worktreePath"]);
  if (!selected.ok) return selected;
  if (selected.value === undefined) return success(null);
  if (
    typeof selected.value !== "string" ||
    !path.isAbsolute(selected.value) ||
    path.normalize(selected.value) !== selected.value ||
    selected.value.includes("\u0000")
  ) {
    return invalid("worktree_path", "expected an absolute normalized worktree identity");
  }
  return success(selected.value);
}

function sameRepository(left: FilesystemRepositoryIdentity, right: FilesystemRepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function selectorMatches(
  item: FilesystemPolicySelector,
  pathValue: string,
  selectedDomain: EffectiveFilesystemDomain,
): boolean {
  if ((item.domain ?? "repository") !== selectedDomain) return false;
  let expression = "^";
  for (let index = 0; index < item.path.length; index += 1) {
    const character = item.path[index] as string;
    if (character === "*" && item.path[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(pathValue);
}

function scopeEntries(
  scope: EffectiveFilesystemScope,
  operation: EffectiveFilesystemOperation,
): readonly FilesystemPolicySelector[] {
  if (operation === "READONLY") return scope.readOnly;
  if (operation === "WRITE") return scope.write;
  if (operation === "CREATE") return scope.create;
  if (operation === "DELETE") return scope.delete;
  return scope.rename;
}

function scopeAllows(
  scope: EffectiveFilesystemScope,
  operation: EffectiveFilesystemOperation,
  pathValue: string,
  selectedDomain: EffectiveFilesystemDomain,
): boolean {
  return scopeEntries(scope, operation).some((item) => selectorMatches(item, pathValue, selectedDomain));
}

function scopeDenies(
  scope: EffectiveFilesystemScope,
  pathValue: string,
  selectedDomain: EffectiveFilesystemDomain,
): boolean {
  return scope.deny.some((item) => selectorMatches(item, pathValue, selectedDomain));
}

function scopeIsImmutable(
  scope: EffectiveFilesystemScope,
  pathValue: string,
  selectedDomain: EffectiveFilesystemDomain,
): boolean {
  return scope.immutable.some((item) => selectorMatches(item, pathValue, selectedDomain));
}

function operationClaimMode(operation: EffectiveFilesystemOperation): ResourceClaimMode {
  return operation === "READONLY" ? "read" : "write";
}

function policyDigest(policy: Omit<EffectiveFilesystemPolicy, "digest">): string {
  return createHash("sha256").update(stableJson(policy)).digest("hex");
}

function compileInputs(input: unknown): DomainResult<EffectiveFilesystemPolicy> {
  if (!isRecord(input)) return invalid("inputs", "expected an object");
  const currentRepo = currentRepository(input);
  if (!currentRepo.ok) return currentRepo;
  const currentBaseValue = currentBase(input);
  if (!currentBaseValue.ok) return currentBaseValue;
  const currentWt = currentWorktree(input);
  if (!currentWt.ok) return currentWt;
  const profileInput = readAliasedValue(input, "profile", ["profile", "worktree_profile", "worktreeProfile"]);
  if (!profileInput.ok) return profileInput;
  const profile = compileBoundary(profileInput.value, "profile");
  if (!profile.ok) return profile;
  const workingSetInput = readAliasedValue(input, "working_set", ["working_set", "workingSet"]);
  if (!workingSetInput.ok) return workingSetInput;
  const workingSet = workingSetBoundary(workingSetInput.value);
  if (!workingSet.ok) return workingSet;
  if (workingSet.value.status === "applied") {
    if (currentRepo.value === null)
      return invalid("repository", "applied working set requires the current repository identity");
    if (currentWt.value === null)
      return invalid("worktree_path", "applied working set requires the current worktree identity");
    if (!isRecord(workingSetInput.value)) return invalid("working_set", "applied working set identity is missing");
    const workingSetRepo = repositoryIdentity(workingSetInput.value.repository, "working_set.repository");
    if (!workingSetRepo.ok) return workingSetRepo;
    if (!sameRepository(currentRepo.value, workingSetRepo.value))
      return invalid("working_set.repository", "working set belongs to a different repository");
    if (currentBaseValue.value === null)
      return invalid("base", "applied working set requires the current base identity");
    const workingSetBase = baseIdentity(workingSetInput.value.base, "working_set.base");
    if (!workingSetBase.ok) return workingSetBase;
    if (
      workingSetBase.value.branch !== currentBaseValue.value.branch ||
      workingSetBase.value.revision !== currentBaseValue.value.revision
    )
      return invalid("working_set.base", "working set belongs to a different base branch or revision");
    const workingSetWorktree = readAliasedValue(workingSetInput.value, "working_set.worktree_path", [
      "worktree_path",
      "worktreePath",
    ]);
    if (!workingSetWorktree.ok) return workingSetWorktree;
    if (workingSetWorktree.value !== undefined && workingSetWorktree.value !== currentWt.value)
      return invalid("working_set.worktree_path", "working set belongs to a different worktree");
  }
  const claimSourceInput = readAliasedValue(input, "claims", ["claims", "resource_claims"]);
  if (!claimSourceInput.ok) return claimSourceInput;
  const claimSource = claimSourceInput.value;
  const claimRecord = isRecord(claimSource) ? claimSource : undefined;
  const claimValueInput =
    claimRecord === undefined ? success(claimSource) : readAliasedValue(claimRecord, "claims", ["claims", "items"]);
  if (!claimValueInput.ok) return claimValueInput;
  const claimValue = claimValueInput.value;
  const claims = claimsArray(claimValue, "claims");
  if (!claims.ok) return claims;
  const claimStatusResult = boundaryStatus(
    claimRecord?.status,
    "claims.status",
    claimSource === undefined ? "unapplied-legacy" : "applied",
  );
  if (!claimStatusResult.ok) return claimStatusResult;
  const generationInput = readAliasedValue(input, "claim_set_generation", [
    "claim_set_generation",
    "claimSetGeneration",
  ]);
  if (!generationInput.ok) return generationInput;
  const wrapperGenerationInput =
    claimRecord === undefined
      ? success(undefined)
      : readAliasedValue(claimRecord, "claims.generation", [
          "generation",
          "claim_set_generation",
          "claimSetGeneration",
        ]);
  if (!wrapperGenerationInput.ok) return wrapperGenerationInput;
  const generationValues = [generationInput.value, wrapperGenerationInput.value].filter(
    (value): value is unknown => value !== undefined,
  );
  if (
    generationValues.length > 1 &&
    generationValues.some((value) => stableJson(value) !== stableJson(generationValues[0]))
  ) {
    return invalid("claim_set_generation", "conflicting claim generation authorities");
  }
  const generation = claimGeneration(generationValues[0], "claim_set_generation");
  if (!generation.ok) return generation;
  const runtime = runtimeEpoch(input);
  if (!runtime.ok) return runtime;
  const runtimeStatusResult = runtimeStatus(input);
  if (!runtimeStatusResult.ok) return runtimeStatusResult;
  const runtimeStatusValue = runtimeStatusResult.value;
  const claimStatus = claimStatusResult.value;
  if (claimStatus === "applied" && generation.value === null)
    return invalid("claim_set_generation", "applied claims require a generation");
  if (claimStatus === "applied") {
    if (currentRepo.value === null)
      return invalid("repository", "applied claims require the current repository identity");
    if (currentWt.value === null)
      return invalid("worktree_path", "applied claims require the current worktree identity");
    for (const [index, claim] of claims.value.entries()) {
      if (claim.repositoryId !== currentRepo.value.repositoryId)
        return invalid(`claims[${index}].repositoryId`, "claim belongs to a different repository");
      if (claim.worktreePath !== currentWt.value)
        return invalid(`claims[${index}].worktreePath`, "claim belongs to a different worktree");
    }
  }
  const claimAuthority: CompiledClaimAuthority = Object.freeze({
    status: claimStatus,
    generation: generation.value,
    claims: claims.value,
  });
  const auxiliaryInput = readAliasedValue(input, "auxiliary_state", ["auxiliary_state", "auxiliaryState"]);
  if (!auxiliaryInput.ok) return auxiliaryInput;
  const auxiliary = auxiliaryBoundary(auxiliaryInput.value);
  if (!auxiliary.ok) return auxiliary;
  const backendInput = readAliasedValue(input, "backend_requirements", ["backend_requirements", "backendRequirements"]);
  if (!backendInput.ok) return backendInput;
  const backend = backendBoundary(backendInput.value);
  if (!backend.ok) return backend;
  const runtimeBoundary: CompiledBoundary = Object.freeze({
    ...profile.value,
    status: runtimeStatusValue === "unknown" ? "unknown" : profile.value.status,
    scope: runtimeStatusValue === "unknown" ? emptyScope() : profile.value.scope,
    epoch: runtime.value,
  });
  const provenance = Object.freeze({
    profile_digest: profile.value.digest,
    working_set_revision: workingSet.value.revision,
    claim_set_generation: generation.value,
    runtime_epoch: runtime.value,
  });
  const withoutDigest: Omit<EffectiveFilesystemPolicy, "digest"> = {
    contract_id: EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID,
    schema_version: EFFECTIVE_FILESYSTEM_POLICY_SCHEMA_VERSION,
    serialization_key: FILESYSTEM_POLICY_SERIALIZATION_KEY,
    profile: runtimeBoundary,
    working_set: workingSet.value,
    claims: claimAuthority,
    backend: backend.value,
    auxiliary: auxiliary.value,
    provenance,
    legacy_boundaries: Object.freeze([
      ...(profile.value.status === "unapplied-legacy" ? ["profile"] : []),
      ...(workingSet.value.status === "unapplied-legacy" ? ["working_set"] : []),
      ...(claimAuthority.status === "unapplied-legacy" ? ["claims"] : []),
      ...(backend.value.status === "unapplied-legacy" ? ["backend"] : []),
      ...(auxiliary.value.status === "unapplied-legacy" ? ["auxiliary"] : []),
    ]),
  };
  return success(Object.freeze({ ...withoutDigest, digest: policyDigest(withoutDigest) }));
}

/** Compile only supplied producer facts; no filesystem or host observation is performed. */
export function compileEffectiveFilesystemPolicy(
  inputs: EffectiveFilesystemPolicyInputs | unknown,
): DomainResult<EffectiveFilesystemPolicy> {
  return compileInputs(inputs);
}

function pathValue(value: unknown, field: string, selectedDomain: EffectiveFilesystemDomain): DomainResult<string> {
  return normalizePath(value, field, selectedDomain);
}

function decision(
  facts: EffectivePathAccessFacts,
  status: FilesystemDecisionStatus,
  reason: string,
  reasons: readonly EffectivePathAccessReason[],
  selectedDomain: EffectiveFilesystemDomain,
): EffectivePathAccessDecision {
  return Object.freeze({
    operation: facts.operation,
    path: facts.path,
    ...(facts.destination === undefined ? {} : { destination: facts.destination }),
    domain: selectedDomain,
    allowed: status === "allow",
    status,
    decision: status,
    reason,
    reasons: Object.freeze([...reasons]),
    legacy_boundaries: facts.policy.legacy_boundaries,
    provenance: facts.policy.provenance,
  });
}

function authorityDecision(
  boundary: CompiledBoundary,
  authority: string,
  operation: EffectiveFilesystemOperation,
  pathValue: string,
  selectedDomain: EffectiveFilesystemDomain,
): EffectivePathAccessReason {
  if (boundary.status === "unknown")
    return Object.freeze({ authority, status: "unresolved", reason: "authority observation is incomplete" });
  if (boundary.status === "unapplied-legacy")
    return Object.freeze({ authority, status: "legacy", reason: "legacy boundary was not applied" });
  if (scopeDenies(boundary.scope, pathValue, selectedDomain))
    return Object.freeze({ authority, status: "denied", reason: "explicit deny matches" });
  if (operation !== "READONLY" && scopeIsImmutable(boundary.scope, pathValue, selectedDomain))
    return Object.freeze({ authority, status: "denied", reason: "immutable area rejects mutation" });
  if (!scopeAllows(boundary.scope, operation, pathValue, selectedDomain))
    return Object.freeze({ authority, status: "denied", reason: "path is outside the operation scope" });
  return Object.freeze({ authority, status: "allowed", reason: "operation scope matches" });
}

/** Decide one operation independently; WRITE never implies READONLY. */
export function decideEffectivePathAccess(facts: EffectivePathAccessFacts): EffectivePathAccessDecision {
  const selectedDomainValue = domain(facts.domain, "domain");
  if (!selectedDomainValue.ok)
    return decision(
      facts,
      "deny",
      selectedDomainValue.error.message,
      [{ authority: "input", status: "denied", reason: selectedDomainValue.error.message }],
      "repository",
    );
  const selectedDomain = selectedDomainValue.value;
  if (!isEffectiveFilesystemOperation(facts.operation))
    return decision(
      facts,
      "deny",
      "unsupported filesystem operation",
      [{ authority: "input", status: "denied", reason: "unsupported filesystem operation" }],
      selectedDomain,
    );
  if (facts.operation === "RENAME" && facts.destination === undefined)
    return decision(
      facts,
      "deny",
      "rename requires a destination",
      [{ authority: "input", status: "denied", reason: "rename requires a destination" }],
      selectedDomain,
    );
  const normalized = pathValue(facts.path, "path", selectedDomain);
  if (!normalized.ok)
    return decision(
      { ...facts, path: String(facts.path) },
      "deny",
      normalized.error.message,
      [{ authority: "input", status: "denied", reason: normalized.error.message }],
      selectedDomain,
    );
  const destination =
    facts.destination === undefined ? undefined : pathValue(facts.destination, "destination", selectedDomain);
  if (destination !== undefined && !destination.ok)
    return decision(
      { ...facts, path: normalized.value, destination: String(facts.destination) },
      "deny",
      destination.error.message,
      [{ authority: "input", status: "denied", reason: destination.error.message }],
      selectedDomain,
    );
  const canonicalFacts = {
    ...facts,
    path: normalized.value,
    ...(destination === undefined ? {} : { destination: destination.value }),
  };
  const reasons: EffectivePathAccessReason[] = [];
  const paths = [normalized.value, ...(destination !== undefined && destination.ok ? [destination.value] : [])];

  for (const currentPath of paths) {
    for (const [authority, boundary] of [
      ["profile", facts.policy.profile],
      ["working_set", facts.policy.working_set],
      ["auxiliary", facts.policy.auxiliary],
    ] as const) {
      if (selectedDomain !== "repository" && authority !== "profile") {
        reasons.push({
          authority,
          status: "legacy",
          reason: "repository-content authority does not apply to this domain",
        });
        continue;
      }
      const outcome = authorityDecision(boundary, authority, facts.operation, currentPath, selectedDomain);
      reasons.push(outcome);
      if (outcome.status === "unresolved")
        return decision(canonicalFacts, "unresolved", outcome.reason, reasons, selectedDomain);
      if (outcome.status === "denied") return decision(canonicalFacts, "deny", outcome.reason, reasons, selectedDomain);
    }
  }

  const backend = facts.policy.backend;
  if (backend.status === "unknown")
    return decision(
      canonicalFacts,
      "unresolved",
      "backend authority observation is incomplete",
      [...reasons, { authority: "backend", status: "unresolved", reason: "authority observation is incomplete" }],
      selectedDomain,
    );
  if (backend.status === "applied") {
    const operationRequirements = backend.requirements.filter(
      (requirement) => requirement.operation === facts.operation && requirement.domain === selectedDomain,
    );
    if (operationRequirements.length === 0) {
      reasons.push({
        authority: "backend",
        status: "legacy",
        reason: "no backend requirement was declared for this operation",
      });
    } else {
      const matched =
        facts.operation === "RENAME"
          ? operationRequirements.some(
              (requirement) =>
                requirement.status !== "unknown" &&
                requirement.path === canonicalFacts.path &&
                requirement.destination === canonicalFacts.destination,
            )
          : paths.every((currentPath) =>
              operationRequirements.some(
                (requirement) => requirement.status !== "unknown" && requirement.path === currentPath,
              ),
            );
      const unknown = operationRequirements.some(
        (requirement) =>
          requirement.status === "unknown" &&
          (facts.operation === "RENAME" ? requirement.path === canonicalFacts.path : paths.includes(requirement.path)),
      );
      if (unknown)
        return decision(
          canonicalFacts,
          "unresolved",
          "backend requirement is unknown",
          [...reasons, { authority: "backend", status: "unresolved", reason: "requirement observation is incomplete" }],
          selectedDomain,
        );
      if (!matched)
        return decision(
          canonicalFacts,
          "deny",
          "path is outside backend requirements",
          [...reasons, { authority: "backend", status: "denied", reason: "no matching backend requirement" }],
          selectedDomain,
        );
      reasons.push({ authority: "backend", status: "allowed", reason: "backend requirement matches" });
    }
  } else reasons.push({ authority: "backend", status: "legacy", reason: "legacy boundary was not applied" });

  if (selectedDomain !== "repository") {
    reasons.push({ authority: "claims", status: "legacy", reason: "resource claims apply only to repository content" });
  } else if (facts.policy.claims.status === "unknown")
    return decision(
      canonicalFacts,
      "unresolved",
      "claim authority observation is incomplete",
      [...reasons, { authority: "claims", status: "unresolved", reason: "authority observation is incomplete" }],
      selectedDomain,
    );
  else if (facts.policy.claims.status === "applied") {
    const required = operationClaimMode(facts.operation);
    for (const currentPath of paths) {
      const matching = facts.policy.claims.claims.filter((claim) => resourceMatchesClaim(claim, currentPath));
      if (!matching.some((claim) => claimModeGrantsAccess(claim.mode, required))) {
        return decision(
          canonicalFacts,
          "deny",
          "resource claim does not grant the required operation",
          [...reasons, { authority: "claims", status: "denied", reason: `required ${required} claim is absent` }],
          selectedDomain,
        );
      }
    }
    reasons.push({ authority: "claims", status: "allowed", reason: `required ${required} claim matches` });
  } else reasons.push({ authority: "claims", status: "legacy", reason: "legacy boundary was not applied" });

  return decision(canonicalFacts, "allow", "all effective authorities allow the operation", reasons, selectedDomain);
}

/** Validate a compiled policy and return its canonical form. */
export function validateEffectiveFilesystemPolicy(input: unknown): DomainResult<EffectiveFilesystemPolicy> {
  if (!isRecord(input)) return invalid("policy", "expected an object");
  if (
    input.contract_id !== EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID ||
    input.schema_version !== EFFECTIVE_FILESYSTEM_POLICY_SCHEMA_VERSION
  )
    return invalid("policy", "unsupported contract or schema version");
  if (
    input.serialization_key !== FILESYSTEM_POLICY_SERIALIZATION_KEY ||
    !isRecord(input.profile) ||
    !isRecord(input.working_set) ||
    !isRecord(input.claims) ||
    !isRecord(input.backend) ||
    !isRecord(input.auxiliary) ||
    !isRecord(input.provenance) ||
    !Array.isArray(input.legacy_boundaries) ||
    typeof input.digest !== "string"
  ) {
    return invalid("policy", "compiled policy shape is incomplete");
  }
  const { digest: _digest, ...withoutDigest } = input;
  const expected = policyDigest(withoutDigest as Omit<EffectiveFilesystemPolicy, "digest">);
  if (input.digest !== expected) return invalid("policy.digest", "does not match canonical policy identity");
  return success(input as unknown as EffectiveFilesystemPolicy);
}

/** Serialize only a validated policy; serialization never consults host state. */
export function serializeEffectiveFilesystemPolicy(input: unknown): DomainResult<string> {
  const policy = validateEffectiveFilesystemPolicy(input);
  return policy.ok ? success(stableJson(policy.value)) : failure(policy.error);
}

export const serializeFilesystemPolicy = serializeEffectiveFilesystemPolicy;
export const projectEffectiveFilesystemPolicy = compileEffectiveFilesystemPolicy;
