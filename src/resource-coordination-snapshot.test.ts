import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResourceClaim } from "./resource-claims.js";
import {
  projectResourceCoordinationSnapshot,
  serializeResourceCoordinationSnapshot,
  type ResourceCoordinationSnapshotInput,
} from "./resource-coordination-snapshot.js";

function claim(
  sessionId: string,
  resource: string,
  mode: ResourceClaim["mode"],
  claimId = `${sessionId}-${resource}-${mode}`,
): ResourceClaim {
  return {
    schemaVersion: 3,
    claimId,
    sessionId,
    repositoryId: "repo-1",
    worktreePath: `/tmp/${sessionId}`,
    resource,
    mode,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function input(overrides: Partial<ResourceCoordinationSnapshotInput> = {}): ResourceCoordinationSnapshotInput {
  return {
    registry: {
      repositoryId: "repo-1",
      claimSetGeneration: 3,
      registryRevision: 4,
      sessions: [
        { sessionId: "parked", worktreePath: "/tmp/parked", state: "stale" },
        { sessionId: "reader", worktreePath: "/tmp/reader", state: "active" },
        { sessionId: "writer", worktreePath: "/tmp/writer", state: "active" },
      ],
      claims: [],
    },
    contract: { complete: true },
    ...overrides,
  };
}

test("retains modified parked worktree evidence after its claims are empty", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      contract: {
        complete: true,
        observedChanges: [{ sessionId: "parked", resource: "src/a.ts", state: "modified", integrated: false }],
      },
    }),
  );

  assert.deepEqual(snapshot.resources[0]?.resource, "src/a.ts");
  assert.equal(snapshot.resources[0]?.physicalModification, "modified");
  assert.deepEqual(snapshot.resources[0]?.participants, [
    {
      sessionId: "parked",
      worktreePath: "/tmp/parked",
      state: "stale",
      claimId: null,
      mode: null,
      requestedMode: null,
      observedChange: "modified",
      integrated: false,
    },
  ]);
  assert.equal(snapshot.resources[0]?.nextActions[0]?.actionId, "inspect-observed-changes");
});

test("projects exclusive writer versus reader as a typed wait reason", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      registry: {
        ...input().registry,
        claims: [claim("writer", "src/a.ts", "exclusive-write")],
      },
      contract: {
        complete: true,
        resourceIntents: [{ sessionId: "reader", resource: "src/a.ts", mode: "read" }],
      },
    }),
  );
  const record = snapshot.resources[0];
  assert.equal(record?.permission, "denied");
  assert.equal(record?.conflict, "conflict");
  assert.deepEqual(record?.blockers[0], {
    kind: "claim-conflict",
    ownerSessionId: "writer",
    ownerClaimId: "writer-src/a.ts-exclusive-write",
    resource: "src/a.ts",
    requestedMode: "read",
    currentMode: "exclusive-write",
    releaseCondition: "owner-changes-claim",
  });
  assert.equal(record?.nextActions[0]?.actionId, "wait-for-owner-release");
});

test("an exclusive request against a reader requires release, not a mode change", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      registry: {
        ...input().registry,
        claims: [claim("reader", "src/a.ts", "read")],
      },
      contract: {
        complete: true,
        resourceIntents: [{ sessionId: "writer", resource: "src/a.ts", mode: "exclusive-write" }],
      },
    }),
  );

  assert.equal(snapshot.resources[0]?.blockers[0]?.kind, "claim-conflict");
  assert.equal(snapshot.resources[0]?.blockers[0]?.releaseCondition, "owner-releases-claim");
});

test("incomplete evidence remains unresolved instead of claiming no conflict", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      contract: {
        complete: false,
        incompleteReasons: ["MERGEABILITY_UNAVAILABLE"],
      },
    }),
  );
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.resources.length, 0);
  assert.deepEqual(snapshot.incompleteReasons, ["INCOMPLETE_AUTHORITY_EVIDENCE", "MERGEABILITY_UNAVAILABLE"]);
});

test("claims, intents, and changes are deterministically ordered and bounded", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      contract: {
        complete: true,
        resourceIntents: [{ sessionId: "reader", resource: "z.ts", mode: "read" }],
        observedChanges: [{ sessionId: "parked", resource: "a.ts", state: "clean", integrated: true }],
      },
      bounds: { maxResources: 1 },
    }),
  );
  assert.equal(snapshot.truncated, true);
  assert.deepEqual(
    snapshot.resources.map((resource) => resource.resource),
    ["a.ts"],
  );
  assert.equal(snapshot.complete, false);
  assert.match(serializeResourceCoordinationSnapshot(snapshot), /"contract"/u);
});

test("participant and blocker bounds are visible as incomplete truncation", () => {
  const snapshot = projectResourceCoordinationSnapshot(
    input({
      registry: {
        ...input().registry,
        claims: [claim("writer-a", "src/a.ts", "exclusive-write"), claim("writer-b", "src/a.ts", "exclusive-write")],
      },
      contract: {
        complete: true,
        resourceIntents: [{ sessionId: "reader", resource: "src/a.ts", mode: "read" }],
      },
      bounds: { maxParticipantsPerResource: 1, maxBlockersPerResource: 1 },
    }),
  );

  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.incompleteReasons, ["BLOCKER_BOUND_EXCEEDED", "PARTICIPANT_BOUND_EXCEEDED"]);
  assert.equal(snapshot.resources[0]?.blockers.length, 1);
  assert.equal(snapshot.resources[0]?.participants.length, 1);
});
