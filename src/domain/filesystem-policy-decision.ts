import { createHash } from "node:crypto";

import {
  resourceMatchesClaim,
  claimModeGrantsAccess,
  type ResourceClaim,
  type ResourceClaimMode,
} from "../resource-claims.js";
import { DomainError, failure, success, type DomainResult } from "./errors.js";
import {
  allowsWorkingSetPath,
  type WorkingSetRuntimeOperation,
  type WorkingSetRuntimeProjection,
} from "./working-set-runtime-projection.js";
import type { WorktreeRuntimeFilesystemCeiling } from "./worktree-runtime-profile.js";

/** Versioned pure compiler boundary for profile-derived filesystem policy. */
export const FILESYSTEM_POLICY_CONTRACT_ID = "nawabari.filesystem-policy.v1" as const;
export const FILESYSTEM_POLICY_SCHEMA_VERSION = 1 as const;
export const FILESYSTEM_POLICY_SERIALIZATION_KEY = "filesystem-policy" as const;
export const PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID = "nawabari.profile-runtime-boundary.v1" as const;
export const PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION = 1 as const;

export const FILESYSTEM_POLICY_OPERATIONS = Object.freeze(["READONLY", "WRITE", "CREATE", "DELETE"] as const);
export type FilesystemPolicyOperation = (typeof FILESYSTEM_POLICY_OPERATIONS)[number];
export type FilesystemPolicyDecisionStatus = "allowed" | "denied" | "unsupported";

export type ProfileFilesystemBoundary = Readonly<{
  readonly contract_id: typeof PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID;
  readonly schema_version: typeof PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION;
  readonly token: string;
  readonly profile_id: string;
  readonly profile_version: string;
  /** Additional profile constraints; this never changes an EWS identity or revision. */
  readonly scope: Readonly<{
    readonly readOnly: readonly string[];
    readonly write: readonly string[];
    readonly deny: readonly string[];
    readonly immutable: readonly string[];
  }>;
}>;

export type FilesystemPolicyDecision = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_SCHEMA_VERSION;
  readonly path: string;
  readonly operation: FilesystemPolicyOperation;
  readonly status: FilesystemPolicyDecisionStatus;
  readonly reason: string;
  /** The current EWS/claim facts are evidence, never a new authorization artifact. */
  readonly authorities: Readonly<{
    readonly profile: "allow" | "deny";
    readonly working_set: "allow" | "deny" | "not_provided";
    readonly claim: "allow" | "deny" | "not_provided";
  }>;
}>;

export type FilesystemPolicyFacts = Readonly<{
  readonly path: string;
  readonly operation: FilesystemPolicyOperation;
  /** Either the validated profile filesystem ceiling or the complete profile. */
  readonly profile:
    WorktreeRuntimeFilesystemCeiling | Readonly<{ readonly filesystem: WorktreeRuntimeFilesystemCeiling }>;
  readonly workingSet?: WorkingSetRuntimeProjection;
  /** Presence of this property means claims are an authoritative current set. */
  readonly claims?: readonly ResourceClaim[];
  readonly claimsRequired?: boolean;
  /** A claim must belong to this repository when a repository identity is supplied. */
  readonly repositoryId?: string;
}>;

const SELECTOR = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_.*?/@+:-]+$/u;
const CONCRETE = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_./@+:-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function normalizedPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  return CONCRETE.test(normalized) ? normalized : undefined;
}

function selectorMatches(selector: string, path: string): boolean {
  let expression = "^";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] as string;
    if (character === "*" && selector[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u").test(path);
}

function ceilingOf(
  profile: WorktreeRuntimeFilesystemCeiling | Readonly<{ readonly filesystem: WorktreeRuntimeFilesystemCeiling }>,
): WorktreeRuntimeFilesystemCeiling | undefined {
  if (record(profile) && "filesystem" in profile && record(profile.filesystem)) {
    return profile.filesystem as WorktreeRuntimeFilesystemCeiling;
  }
  if (record(profile)) return profile as WorktreeRuntimeFilesystemCeiling;
  return undefined;
}

function operationSelectors(
  ceiling: WorktreeRuntimeFilesystemCeiling,
  operation: FilesystemPolicyOperation,
): readonly string[] {
  if (operation === "READONLY") return ceiling.readOnly;
  if (operation === "WRITE") return ceiling.write;
  if (operation === "CREATE") return ceiling.create;
  return ceiling.delete;
}

function requiredClaimMode(operation: FilesystemPolicyOperation): ResourceClaimMode {
  return operation === "READONLY" ? "read" : "write";
}

function decision(
  path: string,
  operation: FilesystemPolicyOperation,
  status: FilesystemPolicyDecisionStatus,
  reason: string,
  authorities: FilesystemPolicyDecision["authorities"],
): FilesystemPolicyDecision {
  return Object.freeze({
    contract_id: FILESYSTEM_POLICY_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_SCHEMA_VERSION,
    path,
    operation,
    status,
    reason,
    authorities,
  });
}

/**
 * Evaluate one concrete path against every available authority.  This is the
 * one shared conjunction used by profile compilation and later capability
 * compilers.  It observes no host filesystem and never grants missing facts.
 */
export function decideEffectivePathAccess(facts: FilesystemPolicyFacts): FilesystemPolicyDecision {
  const path = normalizedPath(facts.path);
  const authorities: {
    profile: "allow" | "deny";
    working_set: "allow" | "deny" | "not_provided";
    claim: "allow" | "deny" | "not_provided";
  } = {
    profile: "deny",
    working_set: facts.workingSet === undefined ? "not_provided" : "deny",
    claim: facts.claims === undefined ? "not_provided" : "deny",
  };
  if (path === undefined) {
    return decision(
      typeof facts.path === "string" ? facts.path : "",
      facts.operation,
      "unsupported",
      "path must be one concrete repository-relative selector",
      authorities,
    );
  }
  if (!FILESYSTEM_POLICY_OPERATIONS.includes(facts.operation)) {
    return decision(
      path,
      facts.operation,
      "unsupported",
      "operation is outside the bounded filesystem backend",
      authorities,
    );
  }
  const ceiling = ceilingOf(facts.profile);
  if (ceiling === undefined || !Array.isArray(ceiling.deny) || !Array.isArray(ceiling.immutable)) {
    return decision(
      path,
      facts.operation,
      "unsupported",
      "profile filesystem ceiling is not a bounded contract",
      authorities,
    );
  }
  if (facts.operation === "CREATE" || facts.operation === "DELETE") {
    return decision(
      path,
      facts.operation,
      "unsupported",
      "the existing runtime backend cannot safely compile this operation",
      authorities,
    );
  }
  if (!SELECTOR.test(path)) {
    return decision(
      path,
      facts.operation,
      "unsupported",
      "path is not a canonical repository-relative selector",
      authorities,
    );
  }
  if (ceiling.deny.some((entry) => selectorMatches(entry, path))) {
    return decision(path, facts.operation, "denied", "profile DENY overrides every allow", authorities);
  }
  if (facts.operation === "WRITE" && ceiling.immutable.some((entry) => selectorMatches(entry, path))) {
    return decision(path, facts.operation, "denied", "profile immutable area cannot be mutated", authorities);
  }
  if (!operationSelectors(ceiling, facts.operation).some((entry) => selectorMatches(entry, path))) {
    return decision(path, facts.operation, "denied", "path is outside the profile operation ceiling", authorities);
  }
  authorities.profile = "allow";

  if (facts.workingSet !== undefined) {
    if (!allowsWorkingSetPath(facts.workingSet, path, facts.operation as WorkingSetRuntimeOperation)) {
      return decision(path, facts.operation, "denied", "path is outside the Effective Working Set", authorities);
    }
    authorities.working_set = "allow";
  }
  if (facts.claims !== undefined) {
    if (facts.repositoryId === undefined) {
      return decision(
        path,
        facts.operation,
        "unsupported",
        "claim authority has no proven repository identity",
        authorities,
      );
    }
    if (facts.claimsRequired === true && facts.claims.length === 0) {
      return decision(
        path,
        facts.operation,
        "denied",
        "the authoritative claim set contains no matching claim",
        authorities,
      );
    }
    const required = requiredClaimMode(facts.operation);
    let matching: readonly ResourceClaim[] = [];
    try {
      matching = facts.claims.filter(
        (claim) =>
          claim.repositoryId === facts.repositoryId &&
          resourceMatchesClaim(claim, path) &&
          claimModeGrantsAccess(claim.mode, required),
      );
    } catch {
      return decision(
        path,
        facts.operation,
        "unsupported",
        "current claim identity or resource syntax is ambiguous",
        authorities,
      );
    }
    if (matching.length === 0) {
      return decision(
        path,
        facts.operation,
        "denied",
        "no current ResourceClaim authorizes this operation",
        authorities,
      );
    }
    authorities.claim = "allow";
  }
  return decision(
    path,
    facts.operation,
    "allowed",
    "profile, working-set, and claim predicates all allow the path",
    authorities,
  );
}

/** Deterministic digest for the additional profile boundary token. */
export function profileRuntimeBoundaryToken(input: Omit<ProfileFilesystemBoundary, "token">): string {
  return createHash("sha256").update(stable(input), "utf8").digest("hex");
}

export function validateProfileRuntimeBoundary(input: unknown): DomainResult<ProfileFilesystemBoundary> {
  if (!record(input))
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Profile runtime boundary must be an object."));
  if (
    input.contract_id !== PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID ||
    input.schema_version !== PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION
  ) {
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Profile runtime boundary contract is unsupported."));
  }
  if (typeof input.token !== "string" || !SHA256.test(input.token)) {
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Profile runtime boundary token is invalid."));
  }
  if (typeof input.profile_id !== "string" || typeof input.profile_version !== "string" || !record(input.scope)) {
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Profile runtime boundary identity is invalid."));
  }
  const scope = input.scope;
  for (const field of ["readOnly", "write", "deny", "immutable"] as const) {
    if (
      !Array.isArray(scope[field]) ||
      scope[field].some((value) => typeof value !== "string" || !SELECTOR.test(value))
    ) {
      return failure(
        new DomainError("RUNTIME_PROJECTION_INVALID", `Profile runtime boundary scope.${field} is invalid.`),
      );
    }
  }
  const withoutToken = {
    contract_id: PROFILE_RUNTIME_BOUNDARY_CONTRACT_ID,
    schema_version: PROFILE_RUNTIME_BOUNDARY_SCHEMA_VERSION,
    profile_id: input.profile_id,
    profile_version: input.profile_version,
    scope: {
      readOnly: [...(scope.readOnly as readonly string[])].sort(),
      write: [...(scope.write as readonly string[])].sort(),
      deny: [...(scope.deny as readonly string[])].sort(),
      immutable: [...(scope.immutable as readonly string[])].sort(),
    },
  } as Omit<ProfileFilesystemBoundary, "token">;
  if (profileRuntimeBoundaryToken(withoutToken) !== input.token) {
    return failure(
      new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", "Profile runtime boundary token does not match its content."),
    );
  }
  return success(Object.freeze({ ...withoutToken, token: input.token }));
}

/** Serialize a validated filesystem policy under its governed document key. */
export function serializeFilesystemPolicy(policy: unknown): DomainResult<string> {
  if (
    !record(policy) ||
    policy.contract_id !== FILESYSTEM_POLICY_CONTRACT_ID ||
    policy.schema_version !== FILESYSTEM_POLICY_SCHEMA_VERSION
  ) {
    return failure(new DomainError("RUNTIME_PROJECTION_INVALID", "Filesystem policy contract is unsupported."));
  }
  return success(JSON.stringify({ [FILESYSTEM_POLICY_SERIALIZATION_KEY]: policy }));
}
