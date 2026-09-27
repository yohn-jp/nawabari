import {
  getNawabariRepositoryRuntimeSnapshot,
  type RepositoryRuntimeObservation,
  type RepositoryRuntimeSnapshot,
} from "../repository-runtime-snapshot.js";
import type { JsonValue } from "./errors.js";
import { DomainError, failure, type DomainResult } from "./errors.js";
import { collectRepositoryRuntimeCoordinationObservation } from "./repository-runtime-coordination-collector.js";
import {
  collectRepositoryRuntimeFilesystemObservation,
  type RepositoryRuntimeEffectiveFilesystemPolicySource,
  type RepositoryRuntimeFilesystemPolicyReadContext,
} from "./repository-runtime-filesystem-collector.js";
import { collectRepositoryRuntimeLifecycleObservation } from "./repository-runtime-lifecycle-collector.js";
import { collectRepositoryRuntimeProcessObservation } from "./repository-runtime-process-collector.js";
import { collectRepositoryRuntimeProfileObservation } from "./repository-runtime-profile-collector.js";
import { compileEffectiveFilesystemPolicy } from "./filesystem-policy.js";
import { parsePinnedProfileRecord } from "./worktree-profile-pinning.js";
import type { RepositoryRegistryView, SessionRegistry } from "../session-registry.js";

const MAX_REGISTRY_SAMPLES = 2;
const MIXED_REGISTRY_REASON = "repository registry changed during observation collection";

type Observations = Readonly<{
  readonly coordination: RepositoryRuntimeObservation<JsonValue>;
  readonly profiles: RepositoryRuntimeObservation<JsonValue>;
  readonly filesystem: RepositoryRuntimeObservation<JsonValue>;
  readonly processes: RepositoryRuntimeObservation<JsonValue>;
  readonly lifecycle: RepositoryRuntimeObservation<JsonValue>;
}>;

/**
 * Collect one read-only RepositoryRuntimeSnapshot from the current registry and
 * its real observation producers. The service owns composition only; producer
 * envelopes remain the source of availability, timestamps, and bounds.
 */
export function collectRepositoryRuntimeSnapshot(registry: SessionRegistry): DomainResult<RepositoryRuntimeSnapshot> {
  for (let sample = 0; sample < MAX_REGISTRY_SAMPLES; sample += 1) {
    let before: RepositoryRegistryView;
    try {
      before = registry.readRepositoryView();
    } catch {
      return failure(
        new DomainError("REGISTRY_UNREADABLE", "Repository observations could not read current registry state."),
      );
    }
    if (before.repositoryId !== registry.repository.repositoryId) {
      return failure(new DomainError("REPOSITORY_MISMATCH", "Repository observation registry identity changed."));
    }

    const observations = collectObservations(registry);
    let after: RepositoryRegistryView;
    try {
      after = registry.readRepositoryView();
    } catch {
      return failure(
        new DomainError("REGISTRY_UNREADABLE", "Repository observations could not recheck registry state."),
      );
    }
    if (after.repositoryId !== registry.repository.repositoryId) {
      return failure(new DomainError("REPOSITORY_MISMATCH", "Repository observation registry identity changed."));
    }

    if (sameRegistrySample(before, after)) {
      return projectSnapshot(after, observations);
    }
    if (sample + 1 === MAX_REGISTRY_SAMPLES) {
      return projectSnapshot(after, unknownObservations(MIXED_REGISTRY_REASON));
    }
  }

  return failure(
    new DomainError("REGISTRY_UNREADABLE", "Repository observations could not establish a registry sample."),
  );
}

function collectObservations(registry: SessionRegistry): Observations {
  return {
    coordination: observe("coordination", () => collectRepositoryRuntimeCoordinationObservation(registry)),
    profiles: observe("profile", () => collectRepositoryRuntimeProfileObservation(registry)),
    filesystem: observe("filesystem", () =>
      collectRepositoryRuntimeFilesystemObservation(registry, {
        readEffectiveFilesystemPolicy: readEffectiveFilesystemPolicy,
      }),
    ),
    processes: observe("process", () => collectRepositoryRuntimeProcessObservation(registry)),
    lifecycle: observe("lifecycle", () => collectRepositoryRuntimeLifecycleObservation(registry)),
  };
}

function observe(
  producer: string,
  collect: () => RepositoryRuntimeObservation<JsonValue>,
): RepositoryRuntimeObservation<JsonValue> {
  try {
    return collect();
  } catch {
    return {
      status: "unknown",
      observed_at: null,
      reason: `${producer} observation producer failed`,
    };
  }
}

function readEffectiveFilesystemPolicy(
  context: RepositoryRuntimeFilesystemPolicyReadContext,
): RepositoryRuntimeEffectiveFilesystemPolicySource | null {
  const { registry, session, evidence } = context;
  if (
    session.repositoryId !== registry.repositoryId ||
    evidence.repositoryId !== registry.repositoryId ||
    evidence.sessionId !== session.sessionId ||
    evidence.worktreePath !== session.worktreePath ||
    evidence.branchId !== session.branchId ||
    evidence.branchName !== session.branchName ||
    session.baseRevision === undefined
  ) {
    return null;
  }

  const records = registry.runtimeRecords.records.pinned_profiles ?? [];
  const matchingPins = records.filter((record) => record.session_id === session.sessionId);
  if (matchingPins.length !== 1) return null;

  let pin: ReturnType<typeof parsePinnedProfileRecord>;
  try {
    pin = parsePinnedProfileRecord(matchingPins[0]);
  } catch {
    return null;
  }
  if (
    pin.provenance.repository.id !== registry.repositoryId ||
    pin.provenance.repository.revision !== session.baseRevision ||
    pin.provenance.base.revision !== session.baseRevision
  ) {
    return null;
  }

  const claimEnforcement = session.claimEnforcement === true;
  const currentClaims = registry.claims.filter((claim) => claim.sessionId === session.sessionId);
  const generation = registry.claimSetGeneration === 0 ? null : registry.claimSetGeneration;
  const workingSetRepository = session.workingSet?.repository;
  const compiled = compileEffectiveFilesystemPolicy({
    profile: {
      status: "applied",
      identity: pin.resolved.id,
      digest: pin.digest,
      scope: pin.resolved.filesystem,
    },
    ...(session.workingSet === undefined ? {} : { working_set: session.workingSet }),
    ...(claimEnforcement ? { claims: currentClaims, claim_set_generation: generation } : {}),
    runtime_epoch: registry.runtimeEpoch === 0 ? null : registry.runtimeEpoch,
    repository: {
      repositoryHost: workingSetRepository?.repositoryHost ?? "local",
      repositoryId: registry.repositoryId,
    },
    base: { branch: session.branchName, revision: session.baseRevision },
    worktree_path: session.worktreePath,
  });
  if (!compiled.ok) return null;

  return {
    repository_id: registry.repositoryId,
    session_id: session.sessionId,
    worktree_id: session.worktreeId,
    worktree_path: session.worktreePath,
    branch_id: evidence.branchId,
    branch_name: evidence.branchName,
    head_id: evidence.headId,
    policy: compiled.value,
  };
}

function sameRegistrySample(left: RepositoryRegistryView, right: RepositoryRegistryView): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.registrySchemaVersion === right.registrySchemaVersion &&
    left.registryRevision === right.registryRevision &&
    left.runtimeEpoch === right.runtimeEpoch &&
    left.claimSetGeneration === right.claimSetGeneration &&
    JSON.stringify(left.sessions) === JSON.stringify(right.sessions) &&
    JSON.stringify(left.claims) === JSON.stringify(right.claims) &&
    JSON.stringify(left.runtimeRecords) === JSON.stringify(right.runtimeRecords)
  );
}

function unknownObservations(reason: string): Observations {
  const unknown: RepositoryRuntimeObservation<JsonValue> = {
    status: "unknown",
    observed_at: null,
    reason,
  };
  return {
    coordination: unknown,
    profiles: unknown,
    filesystem: unknown,
    processes: unknown,
    lifecycle: unknown,
  };
}

function projectSnapshot(
  registry: RepositoryRegistryView,
  observations: Observations,
): DomainResult<RepositoryRuntimeSnapshot> {
  return getNawabariRepositoryRuntimeSnapshot({
    registry,
    captured_at: new Date().toISOString(),
    ...observations,
  });
}
