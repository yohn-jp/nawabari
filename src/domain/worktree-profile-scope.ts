import { createHash } from "node:crypto";

import {
  FILESYSTEM_POLICY_OPERATIONS,
  FILESYSTEM_POLICY_SERIALIZATION_KEY,
  PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID,
  PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION,
  decideEffectivePathAccess,
  profileRuntimeBoundaryToken,
  type FilesystemPolicyDecision,
  type FilesystemPolicyOperation,
  type ProfileFilesystemBoundary,
} from "./filesystem-policy-decision.js";
import { DomainError, failure, success, type DomainResult } from "./errors.js";
import {
  validateWorkingSetRuntimeProjection,
  type WorkingSetRuntimeProjection,
} from "./working-set-runtime-projection.js";
import {
  validateWorktreeRuntimeProfile,
  type ResolvedWorktreeRuntimeProfile,
  type WorktreeRuntimeFilesystemCeiling,
} from "./worktree-runtime-profile.js";
import type { ResourceClaim } from "../resource-claims.js";

export { FILESYSTEM_POLICY_SERIALIZATION_KEY };

export const PROFILE_RUNTIME_SCOPE_CONTRACT_ID = "nawabari.profile-runtime-scope.v1" as const;
export const PROFILE_RUNTIME_SCOPE_SCHEMA_VERSION = 1 as const;

export type ProfileRuntimeScopeStatus = "ready" | "unsupported";
export type ProfileRuntimeScopePathRequest = Readonly<{
  readonly path: string;
  readonly operation: FilesystemPolicyOperation;
}>;

/** Finite path facts are supplied by the caller; this module never scans a host filesystem. */
export type ProfilePathEvidence = Readonly<{
  readonly paths: readonly string[];
  readonly requests?: readonly ProfileRuntimeScopePathRequest[];
}>;

/** External artifacts are observations, not authorization documents created by this module. */
export type ProfileSessionEvidence = Readonly<{
  readonly workingSet?: unknown;
  readonly claims?: unknown;
  readonly claimsRequired?: boolean;
  readonly externalArtifact?: boolean;
  readonly repositoryId?: string;
}>;

export type ProfileRuntimeScopeResolution = Readonly<{
  readonly contract_id: typeof PROFILE_RUNTIME_SCOPE_CONTRACT_ID;
  readonly schema_version: typeof PROFILE_RUNTIME_SCOPE_SCHEMA_VERSION;
  readonly status: ProfileRuntimeScopeStatus;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly scope: Readonly<{
    readonly readOnly: readonly string[];
    readonly write: readonly string[];
    readonly create: readonly string[];
    readonly delete: readonly string[];
    readonly deny: readonly string[];
  }>;
  readonly profile_boundary: ProfileFilesystemBoundary;
  readonly working_set?: WorkingSetRuntimeProjection;
  readonly decisions: readonly FilesystemPolicyDecision[];
  readonly diagnostics: readonly Readonly<{
    readonly path: string;
    readonly operation?: string;
    readonly reason: string;
  }>[];
}>;

const MAX_PATHS = 2_048;
const MAX_TEXT = 1_024;
const CONCRETE = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_./@+:-]+$/u;
const SELECTOR = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_.*?/@+:-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function normalizePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return CONCRETE.test(normalized) ? normalized : undefined;
}

function normalizeSelector(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return SELECTOR.test(normalized) ? normalized : undefined;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function error(
  code: "RUNTIME_PROFILE_INVALID" | "RUNTIME_PROJECTION_INVALID" | "RUNTIME_PROJECTION_AMBIGUOUS",
  message: string,
): DomainResult<never> {
  return failure(new DomainError(code, message));
}

function finiteSelectors(
  ceiling: WorktreeRuntimeFilesystemCeiling,
  operation: "readOnly" | "write" | "create" | "delete",
): readonly string[] | undefined {
  const selectors = ceiling[operation];
  if (!Array.isArray(selectors) || selectors.length > MAX_PATHS) return undefined;
  const normalized = selectors.map(normalizeSelector);
  if (normalized.some((selector) => selector === undefined)) return undefined;
  // Existing bounded runtime can enforce a concrete file, but cannot safely
  // turn a profile-wide directory grant into a finite runtime projection.
  if (normalized.some((selector) => selector?.includes("*") || selector?.includes("?"))) return undefined;
  return Object.freeze([...normalized] as string[]);
}

function unsupported(
  profile: ResolvedWorktreeRuntimeProfile,
  boundary: ProfileFilesystemBoundary,
  decisions: readonly FilesystemPolicyDecision[],
  reason: string,
  path = "profile",
  operation?: string,
): ProfileRuntimeScopeResolution {
  return Object.freeze({
    contract_id: PROFILE_RUNTIME_SCOPE_CONTRACT_ID,
    schema_version: PROFILE_RUNTIME_SCOPE_SCHEMA_VERSION,
    status: "unsupported" as const,
    profile_id: profile.id,
    profile_version: profile.version,
    scope: Object.freeze({ readOnly: [], write: [], create: [], delete: [], deny: [] }),
    profile_boundary: boundary,
    decisions: Object.freeze([...decisions]),
    diagnostics: Object.freeze([{ path, ...(operation === undefined ? {} : { operation }), reason }]),
  });
}

function boundaryFor(profile: ResolvedWorktreeRuntimeProfile): ProfileFilesystemBoundary {
  const scope = {
    readOnly: [...profile.filesystem.readOnly].sort(),
    write: [...profile.filesystem.write].sort(),
    deny: [...profile.filesystem.deny].sort(),
    immutable: [...profile.filesystem.immutable].sort(),
  };
  const identity = {
    contract_id: PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID,
    schema_version: PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION,
    profile_id: profile.id,
    profile_version: profile.version,
    scope,
  } as const;
  return Object.freeze({ ...identity, token: profileRuntimeBoundaryToken(identity) });
}

function validateClaims(value: unknown): DomainResult<readonly ResourceClaim[] | undefined> {
  if (value === undefined) return success(undefined);
  if (!Array.isArray(value) || value.length > MAX_PATHS)
    return error("RUNTIME_PROJECTION_INVALID", "Current ResourceClaim evidence must be a bounded array.");
  for (const [index, claim] of value.entries()) {
    if (
      !record(claim) ||
      !text(claim.resource) ||
      !text(claim.repositoryId) ||
      !text(claim.mode) ||
      !["read", "write", "exclusive-write"].includes(claim.mode)
    ) {
      return error("RUNTIME_PROJECTION_INVALID", `Current ResourceClaim evidence at index ${index} is invalid.`);
    }
  }
  return success(value as readonly ResourceClaim[]);
}

function pathRequests(
  evidence: unknown,
  defaults: readonly ProfileRuntimeScopePathRequest[],
): DomainResult<readonly ProfileRuntimeScopePathRequest[]> {
  if (evidence === undefined) return success(defaults);
  if (Array.isArray(evidence)) {
    const paths = evidence.map((value) => normalizePath(value));
    if (paths.some((value) => value === undefined))
      return error("RUNTIME_PROJECTION_INVALID", "Path evidence contains a non-concrete path.");
    return success(paths.map((path) => ({ path: path as string, operation: "READONLY" as const })));
  }
  if (!record(evidence))
    return error("RUNTIME_PROJECTION_INVALID", "Path evidence must be an object or finite path array.");
  if (!Array.isArray(evidence.paths) || evidence.paths.length > MAX_PATHS)
    return error("RUNTIME_PROJECTION_INVALID", "Path evidence.paths must be a bounded array.");
  const paths = evidence.paths.map((value) => normalizePath(value));
  if (paths.some((value) => value === undefined))
    return error("RUNTIME_PROJECTION_INVALID", "Path evidence contains a non-concrete path.");
  if (evidence.requests === undefined) {
    if (paths.length === 0) return success(defaults);
    const defaultByPath = new Map(defaults.map((request) => [request.path, request.operation]));
    return success(
      paths.map((path) => ({
        path: path as string,
        operation: defaultByPath.get(path as string) ?? ("READONLY" as const),
      })),
    );
  }
  if (!Array.isArray(evidence.requests) || evidence.requests.length > MAX_PATHS)
    return error("RUNTIME_PROJECTION_INVALID", "Path evidence.requests must be a bounded array.");
  const requests: ProfileRuntimeScopePathRequest[] = [];
  for (const [index, request] of evidence.requests.entries()) {
    if (!record(request) || !FILESYSTEM_POLICY_OPERATIONS.includes(request.operation as FilesystemPolicyOperation)) {
      return error("RUNTIME_PROJECTION_INVALID", `Path evidence.requests[${index}] is invalid.`);
    }
    const path = normalizePath(request.path);
    if (path === undefined)
      return error("RUNTIME_PROJECTION_INVALID", `Path evidence.requests[${index}].path is not concrete.`);
    requests.push({ path, operation: request.operation as FilesystemPolicyOperation });
  }
  return success(requests);
}

function makeScope(
  decisions: readonly FilesystemPolicyDecision[],
  deny: readonly string[],
): ProfileRuntimeScopeResolution["scope"] {
  const readOnly = decisions
    .filter((entry) => entry.status === "allowed" && entry.operation === "READONLY")
    .map((entry) => entry.path);
  const write = decisions
    .filter((entry) => entry.status === "allowed" && entry.operation === "WRITE")
    .map((entry) => entry.path);
  return Object.freeze({
    readOnly: Object.freeze([...new Set(readOnly)].sort()),
    write: Object.freeze([...new Set(write)].sort()),
    create: Object.freeze([]),
    delete: Object.freeze([]),
    deny: Object.freeze([...new Set(deny)].sort()),
  });
}

function digestResolution(resolution: Omit<ProfileRuntimeScopeResolution, "digest">): string {
  return createHash("sha256").update(stable(resolution), "utf8").digest("hex");
}

/**
 * Compile a validated profile with finite path facts.  External EWS and
 * claims are only additional maxima; without an EWS the local explicit path
 * request is used and no synthetic external artifact is produced.
 */
export function resolveProfileRuntimeScope(
  profileInput: unknown,
  sessionEvidenceInput: unknown,
  pathEvidenceInput: unknown,
): DomainResult<ProfileRuntimeScopeResolution> {
  const profileResult = validateWorktreeRuntimeProfile(profileInput);
  if (!profileResult.ok) return failure(profileResult.error);
  const profile = profileResult.value;
  const boundary = boundaryFor(profile);
  const ceiling = profile.filesystem;
  const readOnly = finiteSelectors(ceiling, "readOnly");
  const write = finiteSelectors(ceiling, "write");
  const create = finiteSelectors(ceiling, "create");
  const remove = finiteSelectors(ceiling, "delete");
  if (readOnly === undefined || write === undefined) {
    return success(
      unsupported(profile, boundary, [], "profile READONLY/WRITE grants must resolve to finite concrete paths"),
    );
  }
  if (create === undefined || remove === undefined || create.length > 0 || remove.length > 0) {
    return success(
      unsupported(
        profile,
        boundary,
        [],
        "CREATE and DELETE profile requirements are unsupported by the bounded backend",
      ),
    );
  }

  let session: ProfileSessionEvidence = {};
  if (sessionEvidenceInput !== undefined) {
    if (!record(sessionEvidenceInput))
      return error("RUNTIME_PROJECTION_INVALID", "Session evidence must be an object.");
    session = sessionEvidenceInput as ProfileSessionEvidence;
  }
  const externalArtifact =
    session.externalArtifact === true || ("workingSet" in session && session.workingSet !== undefined);
  let workingSet: WorkingSetRuntimeProjection | undefined;
  if (session.workingSet !== undefined && session.workingSet !== null) {
    const parsed = validateWorkingSetRuntimeProjection(session.workingSet);
    if (!parsed.ok) return failure(parsed.error);
    workingSet = parsed.value;
  } else if (externalArtifact) {
    return success(
      unsupported(
        profile,
        boundary,
        [],
        "an external session requires a valid Effective Working Set artifact",
        "session.workingSet",
      ),
    );
  }
  const repositoryId = session.repositoryId ?? workingSet?.repository.repositoryId;
  if (repositoryId === undefined) {
    return success(unsupported(profile, boundary, [], "session owner identity is not proven", "session.repositoryId"));
  }
  if (
    workingSet !== undefined &&
    session.repositoryId !== undefined &&
    session.repositoryId !== workingSet.repository.repositoryId
  ) {
    return success(
      unsupported(
        profile,
        boundary,
        [],
        "session owner identity does not match the Effective Working Set",
        "session.repositoryId",
      ),
    );
  }
  const claimsResult = validateClaims(session.claims);
  if (!claimsResult.ok) return claimsResult;
  const claims = claimsResult.value;
  const defaults: ProfileRuntimeScopePathRequest[] = [
    ...readOnly.map((path) => ({ path, operation: "READONLY" as const })),
    ...write.map((path) => ({ path, operation: "WRITE" as const })),
  ];
  const requestsResult = pathRequests(pathEvidenceInput, defaults);
  if (!requestsResult.ok) return requestsResult;
  const requests = requestsResult.value;
  if (requests.length === 0)
    return success(
      unsupported(profile, boundary, [], "profile scope requires finite explicit path evidence", "pathEvidence"),
    );
  for (const required of defaults) {
    if (!requests.some((request) => request.path === required.path && request.operation === required.operation)) {
      return success(
        unsupported(
          profile,
          boundary,
          [],
          "path evidence omitted a required profile baseline operation",
          required.path,
          required.operation,
        ),
      );
    }
  }

  const decisions: FilesystemPolicyDecision[] = [];
  for (const request of requests) {
    const evaluated = decideEffectivePathAccess({
      path: request.path,
      operation: request.operation,
      profile,
      ...(workingSet === undefined ? {} : { workingSet }),
      ...(claims === undefined ? {} : { claims, claimsRequired: session.claimsRequired === true }),
      ...(repositoryId === undefined ? {} : { repositoryId }),
    });
    decisions.push(evaluated);
    if (evaluated.status === "unsupported")
      return success(unsupported(profile, boundary, decisions, evaluated.reason, evaluated.path, evaluated.operation));
    if (evaluated.status === "denied")
      return success(unsupported(profile, boundary, decisions, evaluated.reason, evaluated.path, evaluated.operation));
  }
  const scope = makeScope(decisions, [...ceiling.deny, ...ceiling.immutable]);
  let compiledWorkingSet: WorkingSetRuntimeProjection | undefined;
  if (workingSet !== undefined) {
    const compiled = validateWorkingSetRuntimeProjection({
      ...workingSet,
      // Preserve EWS identity/revision while narrowing its runtime projection
      // to the finite READONLY/WRITE profile result.
      scope: { ...scope, deny: workingSet.scope.deny },
    });
    if (!compiled.ok) return failure(compiled.error);
    compiledWorkingSet = compiled.value;
  }
  const resolution = Object.freeze({
    contract_id: PROFILE_RUNTIME_SCOPE_CONTRACT_ID,
    schema_version: PROFILE_RUNTIME_SCOPE_SCHEMA_VERSION,
    status: "ready" as const,
    profile_id: profile.id,
    profile_version: profile.version,
    scope,
    profile_boundary: boundary,
    ...(compiledWorkingSet === undefined ? {} : { working_set: compiledWorkingSet }),
    decisions: Object.freeze(decisions),
    diagnostics: Object.freeze([]),
  });
  return success(resolution);
}

export function serializeProfileRuntimeScope(resolution: ProfileRuntimeScopeResolution): DomainResult<string> {
  if (
    resolution.contract_id !== PROFILE_RUNTIME_SCOPE_CONTRACT_ID ||
    resolution.schema_version !== PROFILE_RUNTIME_SCOPE_SCHEMA_VERSION ||
    !SHA256.test(resolution.profile_boundary.token)
  ) {
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Profile runtime scope contract is invalid."));
  }
  return success(JSON.stringify({ [FILESYSTEM_POLICY_SERIALIZATION_KEY]: resolution }));
}

export function profileRuntimeScopeDigest(resolution: ProfileRuntimeScopeResolution): string {
  return digestResolution(resolution);
}
