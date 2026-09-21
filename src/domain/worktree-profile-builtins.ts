import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import { FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS } from "./fhs-development-runtime.js";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  resolveWorktreeProfile,
  substituteProfileParameters,
  validateWorktreeProfileCatalog,
  type CatalogWorktreeProfile,
  type WorktreeProfileCatalog,
  type WorktreeProfileParameterValues,
} from "./worktree-profile-catalog.js";
import type { ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

/** Stable namespace used when a built-in and repository profile share an id. */
export const BUILTIN_WORKTREE_PROFILE_NAMESPACE = "builtin" as const;
export const BUILTIN_WORKTREE_PROFILE_VERSION = "1" as const;

export const BUILTIN_WORKTREE_PROFILE_IDS = Object.freeze(["minimal", "standard-shell"] as const);
export type BuiltinWorktreeProfileId = (typeof BUILTIN_WORKTREE_PROFILE_IDS)[number];

/** A declaration is available only when its declared executable surface exists. */
export type BuiltinWorktreeProfileAvailability = "available" | "missing";
export type BuiltinWorktreeProfileStatus = Readonly<{
  readonly id: BuiltinWorktreeProfileId;
  readonly version: typeof BUILTIN_WORKTREE_PROFILE_VERSION;
  readonly availability: BuiltinWorktreeProfileAvailability;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly reason: string | null;
}>;

/**
 * Built-ins deliberately reuse the existing logical `development` material
 * profile.  They only declare a bounded worktree surface; executable paths
 * and host material remain owned by the existing runtime materializers.
 */
const MINIMAL_WORKTREE_PROFILE = Object.freeze({
  id: "minimal",
  version: BUILTIN_WORKTREE_PROFILE_VERSION,
  extends: Object.freeze([]),
  materialSelection: Object.freeze({ profiles: Object.freeze(["development"]), operations: Object.freeze([]) }),
  filesystem: Object.freeze({
    readOnly: Object.freeze(["**"]),
    write: Object.freeze([]),
    create: Object.freeze([]),
    delete: Object.freeze([]),
    deny: Object.freeze([".git/**"]),
    immutable: Object.freeze([".git/**"]),
  }),
  tools: Object.freeze([
    Object.freeze({
      entrypoint: "git",
      provider: Object.freeze({
        id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["git-package"],
        requirement_id: "git-package",
      }),
    }),
    Object.freeze({
      entrypoint: "ls",
      provider: Object.freeze({ id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["ls-runtime"], requirement_id: "ls-runtime" }),
    }),
    Object.freeze({
      entrypoint: "node",
      provider: Object.freeze({
        id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["node-runtime"],
        requirement_id: "node-runtime",
      }),
    }),
  ]),
  shell: Object.freeze({ entrypoint: "node" }),
  environment: Object.freeze({
    home: "session",
    xdg: Object.freeze({ config: "session", cache: "session", data: "session", state: "session" }),
    tmp: "execution",
  }),
  git: Object.freeze({
    config: "session-private",
    globalConfig: "excluded",
    credentialHelpers: "disabled",
    hooks: "disabled",
  }),
  execution: Object.freeze({ policy: STRICT_RUNTIME_POLICY, processTracking: "required" }),
});

/**
 * `standard-shell` is intentionally a declaration only.  The current
 * development materializer does not provide Bash, so this profile cannot
 * advertise readiness until a later producer supplies that requirement.
 */
const STANDARD_SHELL_WORKTREE_PROFILE = Object.freeze({
  id: "standard-shell",
  version: BUILTIN_WORKTREE_PROFILE_VERSION,
  extends: Object.freeze([]),
  materialSelection: Object.freeze({ profiles: Object.freeze(["development"]), operations: Object.freeze([]) }),
  filesystem: Object.freeze({
    readOnly: Object.freeze(["**"]),
    write: Object.freeze([]),
    create: Object.freeze([]),
    delete: Object.freeze([]),
    deny: Object.freeze([".git/**"]),
    immutable: Object.freeze([".git/**"]),
  }),
  tools: Object.freeze([
    Object.freeze({
      entrypoint: "bash",
      provider: Object.freeze({ id: "fhs-bash-runtime-provider", requirement_id: "bash-runtime" }),
    }),
    Object.freeze({
      entrypoint: "git",
      provider: Object.freeze({
        id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["git-package"],
        requirement_id: "git-package",
      }),
    }),
    Object.freeze({
      entrypoint: "ls",
      provider: Object.freeze({ id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["ls-runtime"], requirement_id: "ls-runtime" }),
    }),
    Object.freeze({
      entrypoint: "node",
      provider: Object.freeze({
        id: FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS["node-runtime"],
        requirement_id: "node-runtime",
      }),
    }),
  ]),
  shell: Object.freeze({ entrypoint: "bash" }),
  environment: Object.freeze({
    home: "session",
    xdg: Object.freeze({ config: "session", cache: "session", data: "session", state: "session" }),
    tmp: "execution",
  }),
  git: Object.freeze({
    config: "session-private",
    globalConfig: "excluded",
    credentialHelpers: "disabled",
    hooks: "disabled",
  }),
  execution: Object.freeze({ policy: STRICT_RUNTIME_POLICY, processTracking: "required" }),
});

const BUILTIN_INPUTS = Object.freeze([MINIMAL_WORKTREE_PROFILE, STANDARD_SHELL_WORKTREE_PROFILE]);

function buildBuiltinCatalog(): WorktreeProfileCatalog {
  const result = validateWorktreeProfileCatalog({ profiles: BUILTIN_INPUTS });
  if (!result.ok) throw result.error;
  return result.value;
}

/** Canonical validated catalog consumed by the same resolver as repository profiles. */
export const BUILTIN_WORKTREE_PROFILE_CATALOG = buildBuiltinCatalog();

/** Validated built-in declarations in deterministic id order. */
export const BUILTIN_WORKTREE_PROFILES: readonly CatalogWorktreeProfile[] = BUILTIN_WORKTREE_PROFILE_CATALOG.profiles;

export const BUILTIN_WORKTREE_PROFILE_AVAILABILITY: Readonly<
  Record<BuiltinWorktreeProfileId, BuiltinWorktreeProfileStatus>
> = Object.freeze({
  minimal: Object.freeze({
    id: "minimal",
    version: BUILTIN_WORKTREE_PROFILE_VERSION,
    availability: "available",
    ready: true,
    missing: Object.freeze([]),
    reason: null,
  }),
  "standard-shell": Object.freeze({
    id: "standard-shell",
    version: BUILTIN_WORKTREE_PROFILE_VERSION,
    availability: "missing",
    ready: false,
    missing: Object.freeze(["bash-runtime"]),
    reason: "The standard-shell Bash entrypoint is declared but has not been materialized.",
  }),
});

function invalidSelection(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("RUNTIME_PROFILE_INVALID", message, details));
}

function missingProfile(id: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_MISSING", `Unknown built-in worktree profile '${id}'.`, { profile_id: id }),
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return one built-in declaration without resolving its material requirements. */
export function getBuiltinWorktreeProfile(id: string): DomainResult<CatalogWorktreeProfile> {
  if (!BUILTIN_WORKTREE_PROFILE_IDS.includes(id as BuiltinWorktreeProfileId)) return missingProfile(id);
  const profile = BUILTIN_WORKTREE_PROFILES.find((candidate) => candidate.id === id);
  return profile === undefined ? missingProfile(id) : success(profile);
}

/** Return the frozen readiness/status projection for one built-in declaration. */
export function getBuiltinWorktreeProfileStatus(id: string): DomainResult<BuiltinWorktreeProfileStatus> {
  if (!BUILTIN_WORKTREE_PROFILE_IDS.includes(id as BuiltinWorktreeProfileId)) return missingProfile(id);
  return success(BUILTIN_WORKTREE_PROFILE_AVAILABILITY[id as BuiltinWorktreeProfileId]);
}

/** Resolve a built-in through the canonical worktree-profile resolver. */
export function resolveBuiltinWorktreeProfile(
  selection: unknown,
  parameters?: WorktreeProfileParameterValues,
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  if (!record(selection) || typeof selection.profile !== "string") {
    return invalidSelection("Built-in profile selection requires one profile id.", { field: "profile" });
  }
  const selected = getBuiltinWorktreeProfile(selection.profile);
  if (!selected.ok) return selected;
  const resolved = resolveWorktreeProfile(selection, BUILTIN_WORKTREE_PROFILE_CATALOG);
  if (!resolved.ok) return resolved;
  if (parameters === undefined) return resolved;
  if (!record(parameters))
    return invalidSelection("Profile parameters must be a JSON object.", { field: "parameters" });
  return substituteProfileParameters(resolved.value, parameters);
}

/** Serialize a validated built-in catalog under the canonical profile key. */
export function serializeBuiltinWorktreeProfiles(): string {
  return JSON.stringify({ profiles: BUILTIN_WORKTREE_PROFILES });
}

/** JSON-safe descriptor for the built-in profile producer and its readiness rule. */
export const BUILTIN_WORKTREE_PROFILE_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: "nawabari.worktree-profile-builtins.v1",
  schema_version: 1,
  serialization_key: "worktree-profile",
  identities: [...BUILTIN_WORKTREE_PROFILE_IDS],
  material_authority: "canonical development runtime profile",
  readiness: "standard-shell remains missing until bash-runtime is materialized",
  namespace: BUILTIN_WORKTREE_PROFILE_NAMESPACE,
  excludes: ["ambient PATH", "host fallback", "repository-profile override"],
});
