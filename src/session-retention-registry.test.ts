import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
} from "./domain/session-execution-record.js";
import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import { resolveWorktreeProfile } from "./domain/worktree-profile-catalog.js";
import { resolveBuiltinWorktreeProfile } from "./domain/worktree-profile-builtins.js";
import { pinWorktreeProfile } from "./domain/worktree-profile-pinning.js";
import { SessionRegistryError } from "./errors.js";
import { resolveRepositoryContext } from "./git.js";
import { REGISTRY_FEATURES } from "./registry/runtime-records.js";
import {
  retentionIdentityDigest,
  SessionRetentionError,
  parkSession,
  resumeSession,
  type ParkCommitInput,
} from "./session-retention.js";
import { SessionRegistry } from "./session-registry.js";
import { withDirectoryFsyncFailure } from "./testing/fs-fault-injection.js";

test("real registry park survives restart, rejects a conflicting resume, then resumes atomically", () => {
  const fixture = createRetentionFixture();
  try {
    const { registry, otherRegistry, session, otherSession, pinnedProfile, executionScope } = fixture;
    const parked = parkSession(registry, {
      sessionId: session.sessionId,
      pinnedProfile,
      operationId: "retention-park-restart",
    });

    assert.equal(parked.status, "parked");
    assert.equal(registry.get(session.sessionId)?.state, "parked");
    assert.equal(registry.listClaims(session.sessionId).length, 0);
    assert.deepEqual(
      registry.listClaims(otherSession.sessionId).map((claim) => claim.resource),
      ["OTHER.md"],
    );
    assert.equal(registry.getSessionManagedRuntime(session.sessionId).admission?.admission, "closed");
    assert.equal(registry.readRepositoryView().runtimeRecords.records.retentions?.length, 1);

    otherRegistry.claimResources({
      sessionId: otherSession.sessionId,
      claims: [{ resource: "README.md", mode: "exclusive-write" }],
    });

    // A fresh Registry instance must reconstruct the parked owner and reject
    // the current all-session conflict without reacquiring any claims.
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    assert.throws(
      () =>
        resumeSession(restarted, {
          sessionId: session.sessionId,
          pinnedProfile,
          latestExternalScope: executionScope,
          operationId: "retention-resume-conflict",
        }),
      (error: unknown) => error instanceof SessionRetentionError && error.code === "CLAIM_CONFLICT",
    );
    assert.equal(restarted.get(session.sessionId)?.state, "parked");
    assert.equal(restarted.listClaims(session.sessionId).length, 0);
    assert.equal(restarted.getSessionManagedRuntime(session.sessionId).admission?.admission, "closed");
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.retentions?.length, 1);

    otherRegistry.releaseClaims({
      sessionId: otherSession.sessionId,
      resources: ["README.md"],
      expectedClaimSetGeneration: otherRegistry.readRepositoryView().claimSetGeneration,
    });
    const resumed = resumeSession(restarted, {
      sessionId: session.sessionId,
      pinnedProfile,
      latestExternalScope: executionScope,
      operationId: "retention-resume-after-conflict",
    });

    assert.equal(resumed.status, "resumed");
    assert.equal(restarted.get(session.sessionId)?.state, "active");
    assert.deepEqual(
      restarted.listClaims(session.sessionId).map(({ resource, mode }) => ({ resource, mode })),
      [{ resource: "README.md", mode: "exclusive-write" }],
    );
    assert.deepEqual(
      restarted.listClaims(otherSession.sessionId).map((claim) => claim.resource),
      ["OTHER.md"],
    );
    assert.equal(restarted.getSessionManagedRuntime(session.sessionId).admission?.admission, "open");
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a new registry can revalidate and finish parking after the durable closed-gate crash cut", () => {
  const fixture = createRetentionFixture();
  try {
    const operationId = "retention-park-before-crash";
    const fence = fixture.registry.fence({
      sessionId: fixture.session.sessionId,
      operationId,
    });
    assert.equal(fence.accepted, true);
    assert.equal(fixture.registry.get(fixture.session.sessionId)?.state, "active");
    assert.equal(fixture.registry.getSessionManagedRuntime(fixture.session.sessionId).admission?.admission, "closed");
    assert.equal(fixture.registry.listClaims(fixture.session.sessionId).length, 1);
    const durableIntent = fixture.registry.readRepositoryView().runtimeRecords.records.park_intents?.[0];
    assert.equal(durableIntent?.operationId, operationId);
    assert.equal(durableIntent?.sessionId, fixture.session.sessionId);
    assert.equal(
      durableIntent?.admissionEpoch,
      fixture.registry.getSessionManagedRuntime(fixture.session.sessionId).runtime_epoch,
    );
    assert.equal(durableIntent?.expectedClaimSetGeneration, fixture.registry.readRepositoryView().claimSetGeneration);

    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    const beforeRejectedAdoption = restarted.readRepositoryView();
    const rejectedAdoption = restarted.fence({
      sessionId: fixture.session.sessionId,
      operationId: "retention-park-different-operation",
    });
    assert.equal(rejectedAdoption.accepted, false);
    if (!rejectedAdoption.accepted) assert.equal(rejectedAdoption.code, "FENCE_REJECTED");
    assert.equal(restarted.readRepositoryView().registryRevision, beforeRejectedAdoption.registryRevision);
    assert.equal(restarted.readRepositoryView().claimSetGeneration, beforeRejectedAdoption.claimSetGeneration);
    assert.deepEqual(restarted.readRepositoryView().runtimeRecords.records.park_intents, [durableIntent]);

    const adopted = restarted.fence({ sessionId: fixture.session.sessionId, operationId });
    assert.equal(adopted.accepted, true);
    const recovered = parkSession(restarted, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId,
    });

    assert.equal(recovered.status, "parked");
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 0);
    assert.deepEqual(
      restarted.listClaims(fixture.otherSession.sessionId).map((claim) => claim.resource),
      ["OTHER.md"],
    );
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.retentions?.[0]?.operationId, operationId);
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.park_intents?.length ?? 0, 0);
  } finally {
    fixture.cleanup();
  }
});

test("fresh registries cannot close or discard while a durable park intent owns admission", () => {
  const fixture = createRetentionFixture();
  try {
    const preview = fixture.registry.previewDiscard(fixture.session.sessionId);
    const fence = fixture.registry.fence({
      sessionId: fixture.session.sessionId,
      operationId: "retention-park-block-cleanup",
    });
    assert.equal(fence.accepted, true);
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    const before = restarted.readRepositoryView();
    const admissionEpoch = restarted.getSessionManagedRuntime(fixture.session.sessionId).runtime_epoch;

    assert.throws(
      () => restarted.close({ sessionId: fixture.session.sessionId }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        /durable in-progress park intent/iu.test(error.message),
    );
    assert.throws(
      () =>
        restarted.discard({
          sessionId: fixture.session.sessionId,
          approvalWitness: preview.approvalWitness,
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        /durable in-progress park intent/iu.test(error.message),
    );
    assert.throws(
      () => restarted.closeSessionLaunchAdmission(fixture.session.sessionId, admissionEpoch),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        /durable in-progress park intent/iu.test(error.message),
    );

    const after = restarted.readRepositoryView();
    assert.equal(after.registryRevision, before.registryRevision);
    assert.equal(after.runtimeEpoch, before.runtimeEpoch);
    assert.equal(after.claimSetGeneration, before.claimSetGeneration);
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "active");
    assert.equal(restarted.get(fixture.session.sessionId)?.terminalOperation, undefined);
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 1);
    assert.equal(after.runtimeRecords.records.park_intents?.length, 1);
    assert.equal(fs.existsSync(fixture.session.worktreePath), true);
    assert.equal(fs.existsSync(path.join(fixture.session.worktreePath, "README.md")), true);
  } finally {
    fixture.cleanup();
  }
});

test("garbage collection reports but cannot mutate a session with a durable park intent", () => {
  const fixture = createRetentionFixture({ clock: () => new Date("2000-01-01T00:00:00.000Z") });
  try {
    const fence = fixture.registry.fence({
      sessionId: fixture.session.sessionId,
      operationId: "retention-park-block-gc",
    });
    assert.equal(fence.accepted, true);
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    const before = restarted.readRepositoryView();

    const result = restarted.garbageCollect({ apply: true, staleAfterMs: 1 });

    assert.ok(result.candidates.some((candidate) => candidate.sessionId === fixture.session.sessionId));
    assert.ok(!result.eligible.some((candidate) => candidate.sessionId === fixture.session.sessionId));
    assert.ok(!result.cleaned.some((session) => session.sessionId === fixture.session.sessionId));
    assert.ok(result.blocked.some((item) => item.sessionId === fixture.session.sessionId));
    assert.equal(restarted.readRepositoryView().registryRevision, before.registryRevision);
    assert.equal(restarted.readRepositoryView().runtimeEpoch, before.runtimeEpoch);
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "active");
    assert.equal(restarted.get(fixture.session.sessionId)?.terminalOperation, undefined);
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 1);
    assert.equal(fs.existsSync(fixture.session.worktreePath), true);
  } finally {
    fixture.cleanup();
  }
});

test("registry rejects park intents with inconsistent session, admission, generation, or retention ownership", async (t) => {
  const mutations: readonly [string, (document: Record<string, unknown>, fixture: RetentionFixture) => void][] = [
    ["unknown session", (document) => patchParkIntent(document, { sessionId: "missing-session" })],
    [
      "non-active session",
      (document, fixture) => {
        const sessions = document.sessions as Record<string, unknown>[];
        sessions.find((session) => session.session_id === fixture.session.sessionId)!.state = "stale";
      },
    ],
    [
      "open admission",
      (document, fixture) => {
        const runtimeSessions = document.runtime_sessions as Record<string, unknown>[];
        runtimeSessions.find((record) => record.session_id === fixture.session.sessionId)!.admission = "open";
      },
    ],
    ["admission epoch mismatch", (document) => patchParkIntent(document, { admissionEpoch: 999_999 })],
    [
      "future claim generation",
      (document) => {
        const intents = document.park_intents as Record<string, unknown>[];
        intents[0]!.expectedClaimSetGeneration = Number(document.claim_set_generation) + 1;
      },
    ],
    [
      "simultaneous final retention",
      (document, fixture) => {
        const session = (document.sessions as Record<string, unknown>[]).find(
          (candidate) => candidate.session_id === fixture.session.sessionId,
        )!;
        session.state = "parked";
        document.claims = (document.claims as Record<string, unknown>[]).filter(
          (claim) => claim.session_id !== fixture.session.sessionId,
        );
        document.claim_set_generation = Number(document.claim_set_generation) + 1;
        const features = document.required_features as string[];
        if (!features.includes("retentions.v1")) features.push("retentions.v1");
        features.sort(
          (left, right) =>
            REGISTRY_FEATURES.indexOf(left as (typeof REGISTRY_FEATURES)[number]) -
            REGISTRY_FEATURES.indexOf(right as (typeof REGISTRY_FEATURES)[number]),
        );
        document.retentions = [
          {
            schemaVersion: 1,
            operationId: "retention-park-final-record",
            sessionId: fixture.session.sessionId,
            repositoryId: fixture.session.repositoryId,
            state: "parked",
            physicalIdentity: {
              repositoryId: fixture.session.repositoryId,
              worktreeId: fixture.session.worktreeId,
              worktreePath: fixture.session.worktreePath,
              branchId: fixture.session.branchId,
              branchName: fixture.session.branchName,
            },
            desiredClaims: [{ resource: "README.md", mode: "exclusive-write" }],
            pinnedProfileDigest: retentionIdentityDigest(fixture.pinnedProfile),
            parkedAt: "2026-09-27T00:00:00.000Z",
            updatedAt: "2026-09-27T00:00:00.000Z",
          },
        ];
      },
    ],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const fixture = createRetentionFixture();
      try {
        const fence = fixture.registry.fence({
          sessionId: fixture.session.sessionId,
          operationId: `retention-park-corruption-${name.replaceAll(" ", "-")}`,
        });
        assert.equal(fence.accepted, true);
        const document = JSON.parse(fs.readFileSync(fixture.registry.paths.registry, "utf8")) as Record<
          string,
          unknown
        >;
        mutate(document, fixture);
        fs.writeFileSync(fixture.registry.paths.registry, `${JSON.stringify(document, null, 2)}\n`);

        assert.throws(
          () =>
            new SessionRegistry({
              cwd: fixture.repositoryPath,
              cgroupFilesystem: fixture.cgroupFilesystem,
            }).readRepositoryView(),
          (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
        );
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("parked worktree remains the owner for normal cleanup diagnostics", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-owner-projection",
    });
    const parkedWorktreeRegistry = new SessionRegistry({
      cwd: fixture.session.worktreePath,
      cgroupFilesystem: fixture.cgroupFilesystem,
    });

    assert.equal(parkedWorktreeRegistry.diagnose()?.session.sessionId, fixture.session.sessionId);
    assert.equal(parkedWorktreeRegistry.cleanupDecision()?.session.state, "parked");
  } finally {
    fixture.cleanup();
  }
});

test("approved close consumes parked retention in its first durable closing intent", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-before-close",
    });
    assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length, 1);

    const finalization = closeAdmissionForCleanup(fixture.registry, fixture.session.sessionId, "close");
    const closed = fixture.registry.close({ sessionId: fixture.session.sessionId }, finalization);

    assert.equal(closed.session.state, "closed");
    assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
    assert.equal(fixture.registry.listClaims(fixture.session.sessionId).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("uncertain parked close intent consumes retention before physical cleanup", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-before-uncertain-close",
    });
    const finalization = closeAdmissionForCleanup(fixture.registry, fixture.session.sessionId, "close");

    assert.throws(
      () =>
        withDirectoryFsyncFailure(fixture.registry.paths.directory, "EIO", () =>
          fixture.registry.close({ sessionId: fixture.session.sessionId }, finalization),
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_DURABILITY_UNCERTAIN",
    );

    assert.equal(fixture.registry.get(fixture.session.sessionId)?.state, "closing");
    assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
    assert.equal(fs.existsSync(fixture.session.worktreePath), true);
  } finally {
    fixture.cleanup();
  }
});

test("approved discard consumes parked retention without bypassing its preview witness", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-before-discard",
    });
    const preview = fixture.registry.previewDiscard(fixture.session.sessionId);
    const finalization = closeAdmissionForCleanup(fixture.registry, fixture.session.sessionId, "discard");
    const discarded = fixture.registry.discard(
      { sessionId: fixture.session.sessionId, approvalWitness: preview.approvalWitness },
      finalization,
    );

    assert.equal(discarded.session.state, "closed");
    assert.equal(discarded.session.terminalOperation, "discard");
    assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
    assert.equal(fixture.registry.listClaims(fixture.session.sessionId).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("resume checks latest filesystem scope even when parking retained no claims", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      desiredClaims: [],
      operationId: "retention-park-empty-intent",
    });
    const latestNarrowerScope = {
      ...fixture.executionScope,
      scope: {
        readOnly: ["README.md"],
        write: [],
        create: [],
        delete: [],
        deny: [],
      },
    };
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });

    assert.throws(
      () =>
        resumeSession(restarted, {
          sessionId: fixture.session.sessionId,
          pinnedProfile: fixture.pinnedProfile,
          latestExternalScope: latestNarrowerScope,
          operationId: "retention-resume-narrowed-scope",
        }),
      (error: unknown) => error instanceof SessionRetentionError && error.code === "EXTERNAL_SCOPE_REJECTED",
    );
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(restarted.getSessionManagedRuntime(fixture.session.sessionId).admission?.admission, "closed");
  } finally {
    fixture.cleanup();
  }
});

test("resume rejects changed pin and physical identity without changing parked ownership", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-identity-check",
    });
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    const changedPin = { ...fixture.pinnedProfile, digest: "c".repeat(64) };

    assert.throws(
      () =>
        resumeSession(restarted, {
          sessionId: fixture.session.sessionId,
          pinnedProfile: changedPin,
          latestExternalScope: fixture.executionScope,
          operationId: "retention-resume-changed-pin",
        }),
      (error: unknown) => error instanceof SessionRetentionError && error.code === "PINNED_PROFILE_MISMATCH",
    );

    const snapshot = restarted.observe(fixture.session.sessionId);
    const retention = snapshot.retention;
    assert.ok(retention);
    const identityResult = restarted.validateResume({
      operationId: "retention-resume-changed-identity",
      sessionId: fixture.session.sessionId,
      snapshot,
      retention,
      physicalIdentity: { ...snapshot.session.physicalIdentity, branchName: "feature/replaced" },
      pinnedProfileDigest: retention.pinnedProfileDigest,
      latestExternalScope: fixture.executionScope,
      desiredClaims: retention.desiredClaims,
    });
    assert.equal(identityResult.accepted, false);
    assert.match(identityResult.reason, /physical identity changed/iu);
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.retentions?.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("resume final CAS rejects a changed claim generation without partial reacquisition", () => {
  const fixture = createRetentionFixture();
  try {
    parkSession(fixture.registry, {
      sessionId: fixture.session.sessionId,
      pinnedProfile: fixture.pinnedProfile,
      operationId: "retention-park-stale-cas",
    });
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    const snapshot = restarted.observe(fixture.session.sessionId);
    const retention = snapshot.retention;
    assert.ok(retention);
    const input = {
      operationId: "retention-resume-stale-cas",
      sessionId: fixture.session.sessionId,
      snapshot,
      retention,
      physicalIdentity: snapshot.session.physicalIdentity,
      pinnedProfileDigest: retention.pinnedProfileDigest,
      latestExternalScope: fixture.executionScope,
      desiredClaims: retention.desiredClaims,
    };
    const validation = restarted.validateResume(input);
    assert.equal(validation.accepted, true);
    if (!validation.accepted) return;

    fixture.otherRegistry.claimResources({
      sessionId: fixture.otherSession.sessionId,
      claims: [{ resource: "SIBLING.md", mode: "write" }],
    });
    const committed = restarted.atomicResume({
      ...input,
      expectedState: "parked",
      expectedClaimSetGeneration: snapshot.claimSetGeneration,
      validationToken: validation.token,
    });

    assert.equal(committed.status, "rejected");
    if (committed.status === "rejected") assert.equal(committed.code, "STALE_CLAIM_SET");
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(restarted.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(restarted.getSessionManagedRuntime(fixture.session.sessionId).admission?.admission, "closed");
    assert.equal(restarted.readRepositoryView().runtimeRecords.records.retentions?.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("park refuses active and unknown descendant occupancy while preserving claims", async (t) => {
  for (const population of ["populated", "unknown"] as const) {
    await t.test(population, () => {
      const fixture = createRetentionFixture({ population });
      try {
        assert.throws(
          () =>
            parkSession(fixture.registry, {
              sessionId: fixture.session.sessionId,
              pinnedProfile: fixture.pinnedProfile,
              operationId: `retention-park-${population}`,
            }),
          (error: unknown) => error instanceof SessionRetentionError && error.code === "DRAIN_INCOMPLETE",
        );
        assert.equal(fixture.registry.get(fixture.session.sessionId)?.state, "active");
        assert.equal(fixture.registry.listClaims(fixture.session.sessionId).length, 1);
        assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
        assert.equal(
          fixture.registry.getSessionManagedRuntime(fixture.session.sessionId).admission?.admission,
          "closed",
        );
      } finally {
        fixture.cleanup();
      }
    });
  }
});

test("shared-write retention rejects before park commit and keeps the closed-gate owner intact", () => {
  const fixture = createRetentionFixture({ sharedWrite: true });
  try {
    assert.throws(
      () =>
        parkSession(fixture.registry, {
          sessionId: fixture.session.sessionId,
          pinnedProfile: fixture.pinnedProfile,
          operationId: "retention-park-shared-intent",
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "INVALID_CLAIM" &&
        error.message.includes("shared-write claim cannot be retained"),
    );
    const retainedClaim = fixture.registry.listClaims(fixture.session.sessionId)[0];
    assert.equal(fixture.registry.get(fixture.session.sessionId)?.state, "active");
    assert.equal(retainedClaim?.sharing?.groupId, "retention-shared-group");
    assert.equal(fixture.registry.getSessionManagedRuntime(fixture.session.sessionId).admission?.admission, "closed");
    assert.equal(fixture.registry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
  } finally {
    fixture.cleanup();
  }
});

test("post-rename park durability uncertainty stays unresolved after registry restart", () => {
  const fixture = createRetentionFixture();
  try {
    const operationId = "retention-park-post-rename-uncertain";
    const initial = fixture.registry.observe(fixture.session.sessionId);
    const fence = fixture.registry.fence({ sessionId: fixture.session.sessionId, operationId });
    assert.equal(fence.accepted, true);
    if (!fence.accepted) return;
    const drained = fixture.registry.drain({
      sessionId: fixture.session.sessionId,
      operationId,
      fenceToken: fence.token,
    });
    assert.equal("drained" in drained, true);
    if (!("drained" in drained)) return;
    const revalidated = fixture.registry.revalidate({
      sessionId: fixture.session.sessionId,
      operationId,
      fenceToken: fence.token,
    });
    assert.equal("accepted" in revalidated, false);
    if ("accepted" in revalidated) return;

    const commitInput: ParkCommitInput = {
      operationId,
      sessionId: fixture.session.sessionId,
      expectedState: "active",
      expectedClaimSetGeneration: revalidated.claimSetGeneration,
      fenceToken: fence.token,
      physicalIdentity: revalidated.session.physicalIdentity,
      desiredClaims: initial.claims
        .filter((claim) => claim.sessionId === fixture.session.sessionId)
        .map(({ resource, mode }) => ({ resource, mode })),
      pinnedProfileDigest: retentionIdentityDigest(fixture.pinnedProfile),
      releaseClaimIds: revalidated.claims
        .filter((claim) => claim.sessionId === fixture.session.sessionId)
        .map((claim) => claim.claimId),
      parkedAt: "2026-09-27T00:00:02.000Z",
    };
    const commit = withDirectoryFsyncFailure(fixture.registry.paths.directory, "EIO", () =>
      fixture.registry.atomicPark(commitInput),
    );

    assert.equal(commit.status, "uncertain");
    assert.equal(fixture.registry.get(fixture.session.sessionId)?.state, "parked");
    const reconciliation = fixture.registry.reobserve({
      operationId,
      sessionId: fixture.session.sessionId,
      operation: "park",
    });
    assert.equal(reconciliation.status, "unknown");

    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: fixture.cgroupFilesystem });
    assert.equal(restarted.get(fixture.session.sessionId)?.state, "parked");
    const restartedReconciliation = restarted.reobserve({
      operationId,
      sessionId: fixture.session.sessionId,
      operation: "park",
    });
    assert.equal(restartedReconciliation.status, "unknown");
    if (restartedReconciliation.status === "unknown") {
      assert.match(restartedReconciliation.reason, /directory durability is not proven/iu);
    }
  } finally {
    fixture.cleanup();
  }
});

interface RetentionFixture {
  readonly repositoryPath: string;
  readonly registry: SessionRegistry;
  readonly otherRegistry: SessionRegistry;
  readonly session: ReturnType<SessionRegistry["provision"]>;
  readonly otherSession: ReturnType<SessionRegistry["create"]>;
  readonly pinnedProfile: NonNullable<ReturnType<SessionRegistry["getSessionManagedRuntime"]>["profile"]>;
  readonly executionScope: Record<string, unknown>;
  readonly cgroupFilesystem: CgroupFileSystem;
  cleanup(): void;
}

function createRetentionFixture(
  options: {
    readonly population?: "empty" | "populated" | "unknown";
    readonly sharedWrite?: boolean;
    readonly clock?: () => Date;
  } = {},
): RetentionFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-retention-registry-"));
  const linkedWorktreePath = `${repositoryPath}-linked`;
  const targetWorktreePath = `${repositoryPath}-target`;
  const cgroupFilesystem = controlledCgroupFilesystem(options.population ?? "empty");
  let targetProvisioned = false;
  try {
    runGit(["init", "-b", "main"], repositoryPath);
    runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
    runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
    runGit(["add", "README.md"], repositoryPath);
    runGit(["commit", "-m", "initial"], repositoryPath);
    runGit(["worktree", "add", "-b", "feature/retention-other", linkedWorktreePath], repositoryPath);

    const registry = new SessionRegistry({
      cwd: repositoryPath,
      cgroupFilesystem,
      managedExecutionReadiness: () => ({ ready: true }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const otherRegistry = new SessionRegistry({ cwd: linkedWorktreePath, cgroupFilesystem });
    const otherSession = otherRegistry.create();
    otherRegistry.claimResources({
      sessionId: otherSession.sessionId,
      claims: [{ resource: "OTHER.md", mode: "write" }],
    });

    const builtin = resolveBuiltinWorktreeProfile({ profile: "minimal" });
    if (!builtin.ok) throw builtin.error;
    const profile = {
      ...builtin.value,
      id: "retention-registry-test",
      extends: [],
      filesystem: {
        ...builtin.value.filesystem,
        readOnly: ["README.md"],
        write: ["README.md"],
        create: [],
        delete: [],
        deny: [],
        immutable: [],
      },
    };
    fs.writeFileSync(
      path.join(repositoryPath, "nawabari.profiles.json"),
      `${JSON.stringify({ profiles: [profile] })}\n`,
    );
    runGit(["add", "nawabari.profiles.json"], repositoryPath);
    runGit(["commit", "-m", "test: add retention profile"], repositoryPath);

    const repository = resolveRepositoryContext({ cwd: repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: repository.repositoryId };
    const executionScope: Record<string, unknown> = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 688 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: {
        readOnly: ["README.md"],
        write: ["README.md"],
        create: [],
        delete: [],
        deny: [],
      },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-retention-registry-test",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:retention", summary: "exercise retained ownership" },
          evidence: [{ artifact: "test", reference: "README.md" }],
        },
      ],
    };
    const initialClaim =
      options.sharedWrite === true
        ? {
            resource: "README.md",
            mode: "write" as const,
            sharing: { kind: "isolated-worktree" as const, groupId: "retention-shared-group" },
          }
        : { resource: "README.md", mode: "exclusive-write" as const };
    const session = registry.provision({
      branchName: "feature/retention-target",
      worktreePath: targetWorktreePath,
      claimEnforcement: true,
      initialClaims: [initialClaim],
      executionScope,
      candidateWorkingSet,
    });
    targetProvisioned = true;
    const parsedProfile = resolveWorktreeProfile({ profile: profile.id }, { profiles: [profile] });
    if (!parsedProfile.ok) throw parsedProfile.error;
    const baseRevision = session.baseRevision;
    if (baseRevision === undefined) throw new Error("Retention fixture session has no base revision");
    const pinnedProfile = pinWorktreeProfile(parsedProfile.value, {
      repository: { id: registry.repository.repositoryId, revision: baseRevision },
      base: { revision: baseRevision },
      catalog: {
        kind: "repository",
        path: "nawabari.profiles.json",
        blob_oid: runGit(["rev-parse", `${baseRevision}:nawabari.profiles.json`], repositoryPath),
      },
      selection: { profile: profile.id, parameters: {} },
    });
    installControlledPinAndAdmission(registry, session.sessionId, pinnedProfile);
    seedExitedExecution(registry, session.sessionId, pinnedProfile.digest);

    return {
      repositoryPath,
      registry,
      otherRegistry,
      session,
      otherSession,
      pinnedProfile,
      executionScope,
      cgroupFilesystem,
      cleanup(): void {
        removeWorktree(repositoryPath, targetWorktreePath);
        removeWorktree(repositoryPath, linkedWorktreePath);
        fs.rmSync(repositoryPath, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    if (targetProvisioned) removeWorktree(repositoryPath, targetWorktreePath);
    removeWorktree(repositoryPath, linkedWorktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
    throw error;
  }
}

function patchParkIntent(document: Record<string, unknown>, patch: Record<string, unknown>): void {
  const intents = document.park_intents as Record<string, unknown>[];
  Object.assign(intents[0]!, patch);
}

function closeAdmissionForCleanup(
  registry: SessionRegistry,
  sessionId: string,
  operation: "close" | "discard",
): {
  readonly contract_id: "nawabari.session-execution-control.v1";
  readonly schema_version: 1;
  readonly session_id: string;
  readonly fence_id: string;
  readonly operation: "close" | "discard";
  readonly expected_epoch: number;
  readonly admission_epoch: number;
  readonly admission: "closed";
  readonly status: "ready";
  readonly next_action: "finalize-lifecycle";
} {
  const expectedEpoch = registry.getSessionManagedRuntime(sessionId).runtime_epoch;
  const closedAdmission = registry.closeSessionLaunchAdmission(sessionId, expectedEpoch);
  return {
    contract_id: "nawabari.session-execution-control.v1",
    schema_version: 1,
    session_id: sessionId,
    fence_id: `retention-cleanup-${operation}`,
    operation,
    expected_epoch: expectedEpoch,
    admission_epoch: closedAdmission.runtimeEpoch,
    admission: "closed",
    status: "ready",
    next_action: "finalize-lifecycle",
  };
}

function installControlledPinAndAdmission(
  registry: SessionRegistry,
  sessionId: string,
  pinnedProfile: RetentionFixture["pinnedProfile"],
): void {
  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const currentFeatures = Array.isArray(persisted.required_features)
    ? persisted.required_features.filter((value): value is string => typeof value === "string")
    : [];
  const requiredFeatures = [...new Set([...currentFeatures, "pinned-profiles.v1", "runtime-sessions.v1"])].sort(
    (left, right) =>
      REGISTRY_FEATURES.indexOf(left as (typeof REGISTRY_FEATURES)[number]) -
      REGISTRY_FEATURES.indexOf(right as (typeof REGISTRY_FEATURES)[number]),
  );
  const pinnedProfiles = Array.isArray(persisted.pinned_profiles) ? persisted.pinned_profiles : [];
  const runtimeSessions = Array.isArray(persisted.runtime_sessions) ? persisted.runtime_sessions : [];
  fs.writeFileSync(
    registry.paths.registry,
    `${JSON.stringify(
      {
        ...persisted,
        required_features: requiredFeatures,
        pinned_profiles: [...pinnedProfiles, { ...pinnedProfile, session_id: sessionId }],
        runtime_sessions: [
          ...runtimeSessions,
          {
            kind: "session-admission",
            schema_version: 1,
            session_id: sessionId,
            admission: "open",
            runtime_epoch: persisted.runtime_epoch,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function seedExitedExecution(registry: SessionRegistry, sessionId: string, profileDigest: string): void {
  const runtime = registry.getSessionManagedRuntime(sessionId);
  const reserved = reserveExecution({
    session_id: sessionId,
    execution_id: "retention-drained-execution",
    cgroup_root: "/sys/fs/cgroup/user.slice/nawabari-retention-test.scope",
    profile_digest: profileDigest,
    filesystem_token: "a".repeat(64),
    runtime_epoch: runtime.runtime_epoch,
    boot_id: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    now: "2026-09-27T00:00:00.000Z",
  });
  if (!reserved.ok) throw reserved.error;
  registry.persistSessionExecution(toPersistedSessionExecutionRecord(reserved.value));
  const exited = recordExecutionState(reserved.value, {
    state: "exited",
    now: "2026-09-27T00:00:01.000Z",
  });
  if (!exited.ok) throw exited.error;
  registry.transitionSessionExecution(
    exited.value.execution_id,
    { state: "exited", now: exited.value.updated_at },
    toPersistedSessionExecutionRecord(exited.value),
  );
}

function controlledCgroupFilesystem(population: "empty" | "populated" | "unknown"): CgroupFileSystem {
  return {
    statSync: () => ({ isDirectory: () => true, isFile: () => true }),
    realpathSync: (file) => file,
    readFileSync: (file) => {
      if (file.endsWith("cgroup.events")) {
        if (population === "unknown") throw new Error("cgroup.events unavailable");
        return `populated ${population === "populated" ? "1" : "0"}\n`;
      }
      if (file.endsWith("cgroup.procs")) return "";
      return "0\n";
    },
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    rmdirSync: () => undefined,
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // Cleanup below remains safe when Git never registered the worktree.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}
