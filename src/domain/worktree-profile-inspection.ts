import type { JsonObject } from "./errors.js";
import type { PinnedWorktreeProfile } from "./worktree-profile-pinning.js";
import type { WorktreeProfileCatalog } from "./worktree-profile-catalog.js";
import type { RuntimeExecutableProvider } from "./runtime-projection.js";
import type { WorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

/** The schema version of the read-only worktree profile inspection projection. */
export const WORKTREE_PROFILE_INSPECTION_SCHEMA_VERSION = 1 as const;

/** The governed document key used when an inspection is serialized. */
export const WORKTREE_PROFILE_INSPECTION_SERIALIZATION_KEY = "worktree-profile-inspection" as const;

/** Repository-definition drift is informational and never a lifecycle decision. */
export type WorktreeProfileDrift = "same" | "changed" | "unknown";

export type WorktreeProfileCatalogObservation =
  | Readonly<{
      readonly status: "available";
      /** The immutable repository-catalog identity observed at inspection time. */
      readonly digest: string;
      readonly catalog: WorktreeProfileCatalog;
    }>
  | Readonly<{
      readonly status: "unknown";
      /** A bounded diagnostic; it must not contain host configuration or secrets. */
      readonly reason: string;
    }>;

export type WorktreeProfileRuntimeObservation = Readonly<{
  readonly status: "available" | "missing" | "unknown";
  readonly materializer: "nix" | "fhs" | "compatibility" | "provided" | null;
  /** Provider identities, not executable paths or host-backed material. */
  readonly providers: readonly RuntimeExecutableProvider[];
}>;

export type WorktreeProfileToolAvailability = "available" | "missing" | "unknown";

export type WorktreeProfileInspection = Readonly<{
  readonly schema_version: typeof WORKTREE_PROFILE_INSPECTION_SCHEMA_VERSION;
  /** The catalog and selection declared by the pinned session authority. */
  readonly declared: Readonly<{
    readonly catalog: Readonly<{
      readonly path: string;
      readonly digest: string;
    }>;
    readonly selection: Readonly<{
      readonly profile: string;
      readonly parameters: JsonObject;
    }>;
  }>;
  /** The resolved profile pinned at session bootstrap, kept separate from current definitions. */
  readonly pinned: Readonly<{
    readonly profile: WorktreeRuntimeProfile;
    readonly provenance: PinnedWorktreeProfile["provenance"];
    readonly digest: string;
  }>;
  /** The current repository catalog observation and its comparison to the pinned identity. */
  readonly current: Readonly<{
    readonly catalog: WorktreeProfileCatalogObservation;
    readonly drift: WorktreeProfileDrift;
  }>;
  /** Materialization is an independent capability observation, not profile declaration. */
  readonly runtime: Readonly<{
    readonly status: WorktreeProfileRuntimeObservation["status"];
    readonly materializer: WorktreeProfileRuntimeObservation["materializer"];
    readonly tools: readonly Readonly<{
      readonly entrypoint: string;
      readonly provider: Readonly<{ readonly id: string; readonly requirement_id: string }>;
      readonly availability: WorktreeProfileToolAvailability;
    }>[];
  }>;
}>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freeze(item);
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    return Object.freeze(value);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function driftFor(pinned: PinnedWorktreeProfile, current: WorktreeProfileCatalogObservation): WorktreeProfileDrift {
  if (current.status === "unknown") return "unknown";
  return current.digest === pinned.provenance.catalog.blob_oid ? "same" : "changed";
}

function toolAvailability(
  observation: WorktreeProfileRuntimeObservation,
  provider: RuntimeExecutableProvider,
): WorktreeProfileToolAvailability {
  if (observation.status === "unknown") return "unknown";
  if (observation.status === "missing") return "missing";
  return observation.providers.some(
    (candidate) => candidate.id === provider.id && candidate.requirement_id === provider.requirement_id,
  )
    ? "available"
    : "missing";
}

/**
 * Project pinned profile authority, repository-definition drift, and runtime
 * materialization capability without consulting or mutating the host.
 *
 * The current catalog is deliberately never substituted for the pinned
 * resolved profile. A missing or unreadable catalog is represented as
 * `unknown`, while provider declarations remain distinct from materialized
 * provider availability.
 */
export function inspectWorktreeProfile(
  pinned: PinnedWorktreeProfile,
  currentCatalogObservation: WorktreeProfileCatalogObservation,
  runtimeObservation: WorktreeProfileRuntimeObservation,
): WorktreeProfileInspection {
  const tools = [...pinned.resolved.tools]
    .sort((left, right) => compareText(left.entrypoint, right.entrypoint))
    .map((tool) => ({
      entrypoint: tool.entrypoint,
      provider: { ...tool.provider },
      availability: toolAvailability(runtimeObservation, tool.provider),
    }));

  const projection = {
    schema_version: WORKTREE_PROFILE_INSPECTION_SCHEMA_VERSION,
    declared: {
      catalog: {
        path: pinned.provenance.catalog.path,
        digest: pinned.provenance.catalog.blob_oid,
      },
      selection: clone(pinned.provenance.selection),
    },
    pinned: {
      profile: clone(pinned.resolved),
      provenance: clone(pinned.provenance),
      digest: pinned.digest,
    },
    current: {
      catalog: clone(currentCatalogObservation),
      drift: driftFor(pinned, currentCatalogObservation),
    },
    runtime: {
      status: runtimeObservation.status,
      materializer: runtimeObservation.materializer,
      tools,
    },
  } satisfies WorktreeProfileInspection;

  return freeze(projection);
}

/** Serialize the inspection under its stable public document key. */
export function serializeWorktreeProfileInspection(input: WorktreeProfileInspection): string {
  return JSON.stringify({
    [WORKTREE_PROFILE_INSPECTION_SERIALIZATION_KEY]: input,
  });
}
