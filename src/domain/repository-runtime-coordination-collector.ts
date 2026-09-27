import type { JsonValue } from "./errors.js";
import type { ResourceCoordinationSnapshotBounds } from "../resource-coordination-snapshot.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import type { SessionRegistry } from "../session-registry.js";

const COORDINATION_SOURCE_UNAVAILABLE = "coordination source unavailable" as const;

export type RepositoryRuntimeCoordinationCollectorOptions = Readonly<{
  /** Optional tighter bounds; the producer applies its existing bounded defaults when omitted. */
  bounds?: ResourceCoordinationSnapshotBounds;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}>;

/** Collect the current registry-backed coordination projection without mutation. */
export function collectRepositoryRuntimeCoordinationObservation(
  registry: Pick<SessionRegistry, "resourceCoordinationSnapshot">,
  options: RepositoryRuntimeCoordinationCollectorOptions = {},
): RepositoryRuntimeObservation<JsonValue> {
  try {
    // No intent, worktree-change, or mergeability evidence is supplied by this
    // leaf. The producer therefore retains its explicit incomplete status.
    const snapshot = registry.resourceCoordinationSnapshot({ complete: false }, options.bounds);
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    return {
      status: "available",
      observed_at: observedAt,
      value: snapshot as unknown as JsonValue,
    };
  } catch {
    return {
      status: "unknown",
      observed_at: null,
      reason: COORDINATION_SOURCE_UNAVAILABLE,
    };
  }
}
