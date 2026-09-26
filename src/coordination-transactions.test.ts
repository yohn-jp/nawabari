import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import {
  applyCoordinationTransaction,
  authorizeCoordinationOperation,
  COORDINATION_TRANSACTION_SERIALIZATION_KEYS,
  coordinationTransactionDigest,
  planCoordinationTransaction,
  type CoordinationTransactionSnapshot,
  type ExecutionFence,
  type ManagedExecution,
} from "./coordination-transactions.js";
import { createResourceClaim, type CoordinationFacts, type ResourceClaim } from "./resource-claims.js";
import type { SessionRecord } from "./session-registry.js";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface Fixture {
  readonly root: string;
  readonly left: SessionRecord;
  readonly right: SessionRecord;
  readonly cleanup: () => void;
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-coordination-transaction-"));
  const leftPath = path.join(root, "left");
  const rightPath = path.join(root, "right");
  fs.mkdirSync(leftPath);
  fs.mkdirSync(rightPath);
  const session = (sessionId: string, worktreePath: string): SessionRecord => ({
    schemaVersion: 1,
    sessionId,
    repositoryId: path.join(root, ".git"),
    worktreeId: `${sessionId}-worktree`,
    worktreePath,
    branchId: `${sessionId}-branch`,
    branchName: sessionId,
    state: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  });
  return {
    root,
    left: session("left", leftPath),
    right: session("right", rightPath),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function claim(
  session: SessionRecord,
  mode: "read" | "write" | "exclusive-write",
  resource = "src/file.ts",
  groupId?: string,
): ResourceClaim {
  return createResourceClaim(
    {
      resource,
      mode,
      ...(groupId === undefined ? {} : { sharing: { kind: "isolated-worktree", groupId } }),
    },
    session,
    TIMESTAMP,
  );
}

function snapshot(
  fixtureValue: Fixture,
  claims: readonly ResourceClaim[] = [],
  generation = 0,
): CoordinationTransactionSnapshot {
  return {
    repositoryId: fixtureValue.left.repositoryId,
    claimSetGeneration: generation,
    sessions: [fixtureValue.left, fixtureValue.right],
    claims,
  };
}

function coordinationFacts(left: ResourceClaim, right: ResourceClaim, generation: number): CoordinationFacts {
  return {
    left,
    right,
    claimSetGeneration: generation,
    observedClaimSetGeneration: generation,
    leftIdentity: {
      status: "verified",
      repositoryId: left.repositoryId,
      sessionId: left.sessionId,
      worktreeId: `${left.sessionId}-worktree`,
      worktreePath: left.worktreePath,
    },
    rightIdentity: {
      status: "verified",
      repositoryId: right.repositoryId,
      sessionId: right.sessionId,
      worktreeId: `${right.sessionId}-worktree`,
      worktreePath: right.worktreePath,
    },
  };
}

function errorCode(action: () => unknown, code: SessionRegistryError["code"]): SessionRegistryError {
  try {
    action();
  } catch (error: unknown) {
    assert.ok(error instanceof SessionRegistryError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test("normalizes a full replacement and invokes one atomic writer", () => {
  const value = fixture();
  try {
    let writes = 0;
    let committedGeneration: number | undefined;
    const result = applyCoordinationTransaction(
      snapshot(value),
      {
        kind: "replace",
        sessionId: value.left.sessionId,
        claims: [
          { resource: "docs/readme.md", mode: "read" },
          { resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } },
        ],
        force: true,
        timestamp: TIMESTAMP,
      },
      {
        commit: (commit) => {
          writes += 1;
          committedGeneration = commit.claimSetGeneration;
          assert.equal(commit.claims.length, 2);
          assert.equal(commit.changes.length, 2);
        },
      },
    );
    assert.equal(writes, 1);
    assert.equal(committedGeneration, 1);
    assert.equal(result.claimSetGeneration, 1);
    assert.equal(result.idempotent, false);
    assert.deepEqual(
      result.claims.map((entry) => [entry.resource, entry.mode, entry.sharing?.groupId]),
      [
        ["docs/readme.md", "read", undefined],
        ["src/file.ts", "write", "g"],
      ],
    );
  } finally {
    value.cleanup();
  }
});

test("rejects a conflicting member of a batch without changing any member", () => {
  const value = fixture();
  try {
    const blocking = claim(value.right, "write", "src/conflict.ts");
    const before = snapshot(value, [blocking], 4);
    let writes = 0;
    const error = errorCode(
      () =>
        applyCoordinationTransaction(
          before,
          {
            kind: "replace",
            sessionId: value.left.sessionId,
            claims: [
              { resource: "docs/keep.ts", mode: "read" },
              { resource: "src/conflict.ts", mode: "write" },
            ],
            expectedClaimSetGeneration: 4,
            timestamp: TIMESTAMP,
          },
          { commit: () => (writes += 1) },
        ),
      "RESOURCE_CLAIM_CONFLICT",
    );
    assert.equal(error.details.ownerSessionId, value.right.sessionId);
    assert.equal(writes, 0);
    assert.deepEqual(before.claims, [blocking]);
  } finally {
    value.cleanup();
  }
});

test("rejects a stale generation before a coordinated sharing change can be committed", () => {
  const value = fixture();
  try {
    const existing = claim(value.left, "write", "src/file.ts", "old");
    const before = snapshot(value, [existing], 9);
    let writes = 0;
    const error = errorCode(
      () =>
        applyCoordinationTransaction(
          before,
          {
            kind: "replace",
            sessionId: value.left.sessionId,
            claims: [
              { resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "new" } },
            ],
            expectedClaimSetGeneration: 8,
            timestamp: TIMESTAMP,
          },
          { commit: () => (writes += 1) },
        ),
      "STALE_CLAIM_SET",
    );
    assert.equal(error.details.actualClaimSetGeneration, 9);
    assert.equal(writes, 0);
    assert.equal(before.claims[0]?.sharing?.groupId, "old");
  } finally {
    value.cleanup();
  }
});

test("allows only a proven same-group write overlap and leaves ordinary conflicts unchanged", () => {
  const value = fixture();
  try {
    const foreign = claim(value.right, "write", "src/file.ts", "g");
    const before = snapshot(value, [foreign], 2);
    const facts = (left: ResourceClaim, right: ResourceClaim) => coordinationFacts(left, right, 2);
    const result = applyCoordinationTransaction(
      before,
      {
        kind: "acquire",
        sessionId: value.left.sessionId,
        claims: [{ resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } }],
        timestamp: TIMESTAMP,
      },
      { coordinationFacts: facts },
    );
    assert.equal(result.claimSetGeneration, 3);
    assert.equal(result.claims.length, 1);

    const unproven = errorCode(
      () =>
        planCoordinationTransaction(before, {
          kind: "acquire",
          sessionId: value.left.sessionId,
          claims: [{ resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } }],
          timestamp: TIMESTAMP,
        }),
      "RESOURCE_CLAIM_CONFLICT",
    );
    assert.equal(unproven.details.coordination, "unproven");
  } finally {
    value.cleanup();
  }
});

test("coordinated write cannot satisfy commit or push exclusive access", () => {
  const value = fixture();
  try {
    const foreign = claim(value.right, "write", "src/file.ts", "g");
    const own = claim(value.left, "write", "src/file.ts", "g");
    const before = snapshot(value, [own, foreign], 7);
    const facts = (left: ResourceClaim, right: ResourceClaim) => coordinationFacts(left, right, 7);
    const sourceWrite = authorizeCoordinationOperation({
      operation: "source-write",
      sessionId: value.left.sessionId,
      resources: ["src/file.ts"],
      snapshot: before,
      coordinationFacts: facts,
    });
    assert.equal(sourceWrite.allowed, true);
    assert.equal(sourceWrite.requiredAccess, "write");
    for (const operation of ["commit", "push"]) {
      const denied = authorizeCoordinationOperation({
        operation,
        sessionId: value.left.sessionId,
        resources: ["src/file.ts"],
        snapshot: before,
        coordinationFacts: facts,
      });
      assert.equal(denied.allowed, false, operation);
      assert.equal(denied.code, "RESOURCE_CLAIM_CONFLICT", operation);
      assert.equal(denied.details.requiredAccess, "exclusive-write", operation);
    }
  } finally {
    value.cleanup();
  }
});

test("requires managed execution drain before reducing or ending authority", () => {
  const value = fixture();
  try {
    const existing = claim(value.left, "write", "src/file.ts", "g");
    const before = snapshot(value, [existing], 5);
    const execution: ManagedExecution = {
      executionId: "exec-1",
      sessionId: value.left.sessionId,
      state: "active",
      managed: true,
      resources: ["src/file.ts"],
    };
    const fence: ExecutionFence = { epoch: 3, state: "open", observed: true };
    const error = errorCode(
      () =>
        planCoordinationTransaction(before, {
          kind: "delta",
          sessionId: value.left.sessionId,
          deltas: [{ kind: "upsert", resource: "src/file.ts", mode: "read" }],
          expectedClaimSetGeneration: 5,
          managedExecutions: [execution],
          executionFence: fence,
          timestamp: TIMESTAMP,
        }),
      "OPERATION_REJECTED",
    );
    assert.equal(error.details.reason, "drain-required");
    assert.equal(error.details.executionId, "exec-1");

    const released = planCoordinationTransaction(before, {
      kind: "delta",
      sessionId: value.left.sessionId,
      deltas: [{ kind: "release", resource: "src/file.ts" }],
      expectedClaimSetGeneration: 5,
      managedExecutions: [{ ...execution, state: "stopped" }],
      timestamp: TIMESTAMP,
    });
    assert.equal(released.changes[0]?.kind, "released");
  } finally {
    value.cleanup();
  }
});

test("keeps untracked legacy process absence outside claim-only guarantees", () => {
  const value = fixture();
  try {
    const existing = claim(value.left, "write", "src/file.ts");
    const result = planCoordinationTransaction(snapshot(value, [existing], 1), {
      kind: "release",
      sessionId: value.left.sessionId,
      resources: ["src/file.ts"],
      expectedClaimSetGeneration: 1,
      managedExecutions: [
        {
          executionId: "legacy-1",
          sessionId: value.left.sessionId,
          state: "active",
          managed: false,
        },
      ],
      timestamp: TIMESTAMP,
    });
    assert.equal(result.claimSetGeneration, 2);
  } finally {
    value.cleanup();
  }
});

test("supports partial release and multi-delta changes while preserving unrelated claims", () => {
  const value = fixture();
  try {
    const keep = claim(value.left, "read", "docs/keep.md");
    const replace = claim(value.left, "write", "src/replace.ts");
    const before = snapshot(value, [keep, replace], 11);
    const result = planCoordinationTransaction(before, {
      kind: "delta",
      sessionId: value.left.sessionId,
      deltas: [
        { kind: "upsert", resource: "src/replace.ts", mode: "exclusive-write" },
        { kind: "release", resource: "docs/keep.md" },
        { kind: "upsert", resource: "src/new.ts", mode: "read" },
      ],
      force: true,
      timestamp: TIMESTAMP,
    });
    assert.deepEqual(
      result.sessionClaims.map((entry) => [entry.resource, entry.mode]),
      [
        ["src/new.ts", "read"],
        ["src/replace.ts", "exclusive-write"],
      ],
    );
    assert.deepEqual(
      result.changes.map((change) => [change.resource, change.kind]),
      [
        ["docs/keep.md", "released"],
        ["src/new.ts", "added"],
        ["src/replace.ts", "changed"],
      ],
    );
  } finally {
    value.cleanup();
  }
});

test("retries an equivalent transaction idempotently without a second write", () => {
  const value = fixture();
  try {
    const before = snapshot(value);
    let committed = 0;
    const first = applyCoordinationTransaction(
      before,
      {
        kind: "acquire",
        sessionId: value.left.sessionId,
        claims: [{ resource: "src/idempotent.ts", mode: "read" }],
        timestamp: TIMESTAMP,
      },
      { commit: () => (committed += 1) },
    );
    assert.equal(committed, 1);
    const retrySnapshot = snapshot(value, first.claims, first.claimSetGeneration);
    const retry = applyCoordinationTransaction(
      retrySnapshot,
      {
        kind: "acquire",
        sessionId: value.left.sessionId,
        claims: [{ resource: "src/idempotent.ts", mode: "read" }],
        timestamp: TIMESTAMP,
      },
      { commit: () => (committed += 1) },
    );
    assert.equal(retry.idempotent, true);
    assert.equal(retry.claimSetGeneration, first.claimSetGeneration);
    assert.equal(committed, 1);
    assert.equal(retry.changes[0]?.kind, "unchanged");
  } finally {
    value.cleanup();
  }
});

test("preserves exact claims and generation on no-op replace and delta", () => {
  const value = fixture();
  try {
    const existing = [
      claim(value.left, "read", "docs/existing.md"),
      claim(value.left, "write", "src/existing.ts", "group"),
    ];
    const before = snapshot(value, existing, 7);
    const replacement = planCoordinationTransaction(before, {
      kind: "replace",
      sessionId: value.left.sessionId,
      claims: [
        { resource: "docs/existing.md", mode: "read" },
        { resource: "src/existing.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "group" } },
      ],
      expectedClaimSetGeneration: 7,
      timestamp: "2026-02-02T00:00:00.000Z",
    });
    assert.equal(replacement.idempotent, true);
    assert.equal(replacement.claimSetGeneration, before.claimSetGeneration);
    assert.equal(JSON.stringify(replacement.claims), JSON.stringify(before.claims));
    assert.equal(JSON.stringify(replacement.sessionClaims), JSON.stringify(before.claims));

    const delta = planCoordinationTransaction(snapshot(value, replacement.claims, replacement.claimSetGeneration), {
      kind: "delta",
      sessionId: value.left.sessionId,
      deltas: [
        {
          kind: "upsert",
          resource: "src/existing.ts",
          mode: "write",
          sharing: { kind: "isolated-worktree", groupId: "group" },
        },
      ],
      expectedClaimSetGeneration: replacement.claimSetGeneration,
      timestamp: "2026-03-03T00:00:00.000Z",
    });
    assert.equal(delta.idempotent, true);
    assert.equal(delta.claimSetGeneration, before.claimSetGeneration);
    assert.equal(JSON.stringify(delta.sessionClaims), JSON.stringify(replacement.claims));
  } finally {
    value.cleanup();
  }
});

test("keeps serialization identity and rejects sharing on read or exclusive claims", () => {
  const value = fixture();
  try {
    assert.deepEqual(COORDINATION_TRANSACTION_SERIALIZATION_KEYS, ["registry", "domain-session", "cli", "contract"]);
    assert.throws(
      () =>
        planCoordinationTransaction(snapshot(value), {
          kind: "acquire",
          sessionId: value.left.sessionId,
          claims: [{ resource: "src/read.ts", mode: "read", sharing: { kind: "isolated-worktree", groupId: "g" } }],
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_CLAIM",
    );
    const plan = planCoordinationTransaction(snapshot(value), {
      kind: "acquire",
      sessionId: value.left.sessionId,
      claims: [{ resource: "src/serialized.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } }],
      timestamp: TIMESTAMP,
    });
    assert.equal(coordinationTransactionDigest(plan).length, 64);
    assert.equal(coordinationTransactionDigest(plan), coordinationTransactionDigest(plan));
  } finally {
    value.cleanup();
  }
});

test("binds one explicit sharing group to all write declarations and rejects acquire reinterpretation", () => {
  const value = fixture();
  try {
    const first = planCoordinationTransaction(snapshot(value), {
      kind: "acquire",
      sessionId: value.left.sessionId,
      sharing: { kind: "isolated-worktree", groupId: "group" },
      claims: [
        { resource: "src/one.ts", mode: "write" },
        { resource: "src/two.ts", mode: "write" },
      ],
      timestamp: TIMESTAMP,
    });
    assert.deepEqual(
      first.sessionClaims.map((entry) => entry.sharing?.groupId),
      ["group", "group"],
    );

    const existing = first.sessionClaims[0] as ResourceClaim;
    errorCode(
      () =>
        planCoordinationTransaction(snapshot(value, [existing], 1), {
          kind: "acquire",
          sessionId: value.left.sessionId,
          claims: [{ resource: "src/one.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "other" } }],
          timestamp: TIMESTAMP,
        }),
      "CONTRADICTORY_CLAIM",
    );
  } finally {
    value.cleanup();
  }
});

test("rejects delta sharing that conflicts with its top-level binding", () => {
  const value = fixture();
  try {
    errorCode(
      () =>
        planCoordinationTransaction(snapshot(value), {
          kind: "delta",
          sessionId: value.left.sessionId,
          sharing: { kind: "isolated-worktree", groupId: "top-level" },
          force: true,
          deltas: [
            {
              kind: "upsert",
              resource: "src/conflicting-sharing.ts",
              mode: "write",
              sharing: { kind: "isolated-worktree", groupId: "per-delta" },
            },
          ],
        }),
      "CONTRADICTORY_CLAIM",
    );
  } finally {
    value.cleanup();
  }
});
