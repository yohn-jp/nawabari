import assert from "node:assert/strict";
import { test } from "node:test";

import type { ResourceClaim } from "./resource-claims.js";
import {
  RESOURCE_HANDOFF_OPERATION,
  RESOURCE_HANDOFF_SCHEMA_VERSION,
  canonicalResourceHandoffOperationId,
  handoffResources,
  type HandoffResourcesOptions,
  type ResourceHandoffAuthority,
  type ResourceHandoffCommitResult,
  type ResourceHandoffCommitInput,
  type ResourceHandoffFence,
  type ResourceHandoffFenceController,
  type ResourceHandoffQuiescence,
  type ResourceHandoffSession,
  type ResourceHandoffSnapshot,
} from "./resource-handoff.js";
import { validateResourceHandoff } from "./resource-handoff.js";
import { SessionRegistryError } from "./errors.js";

const timestamp = "2026-01-01T00:00:00.000Z";

function claim(sessionId: string, resource: string, mode: ResourceClaim["mode"] = "write"): ResourceClaim {
  return {
    schemaVersion: 3,
    claimId: `${sessionId}-${resource}-${mode}`,
    sessionId,
    repositoryId: "repo-1",
    worktreePath: `/worktrees/${sessionId}`,
    resource,
    mode,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function session(
  sessionId: string,
  state: string = "active",
  scope: ResourceHandoffSession["maxScope"] = {
    readOnly: ["src/**"],
    write: ["src/**"],
    create: [],
    delete: [],
    deny: [],
  },
): ResourceHandoffSession {
  return {
    sessionId,
    repositoryId: "repo-1",
    worktreePath: `/worktrees/${sessionId}`,
    state,
    maxScope: scope,
  };
}

function snapshot(overrides: Partial<ResourceHandoffSnapshot["registry"]> = {}): ResourceHandoffSnapshot {
  return {
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    operation: RESOURCE_HANDOFF_OPERATION,
    registry: {
      repositoryId: "repo-1",
      claimSetGeneration: 4,
      sessions: [session("source"), session("destination")],
      claims: [claim("source", "src/owned.ts")],
      ...overrides,
    },
  };
}

function options(overrides: Partial<HandoffResourcesOptions> = {}): HandoffResourcesOptions {
  return {
    fromSessionId: "source",
    toSessionId: "destination",
    resource: "src/owned.ts",
    mode: "write",
    ifGeneration: 4,
    operationId: "operation-1",
    ...overrides,
  };
}

test("validates repository, state, exact ownership, and destination maximum scope", () => {
  const valid = validateResourceHandoff(snapshot(), options());
  assert.equal(valid.status, "allowed");
  assert.equal(valid.code, "ALLOWED");
  assert.equal(valid.sourceClaim?.sessionId, "source");
  assert.equal(valid.destinationClaim, null);

  const denied = validateResourceHandoff(
    snapshot({
      sessions: [
        session("source"),
        session("destination", "active", { ...session("destination").maxScope!, deny: ["src/**"] }),
      ],
    }),
    options(),
  );
  assert.equal(denied.status, "blocked");
  assert.equal(denied.code, "OPERATION_REJECTED");
  assert.equal(denied.sourceRetained, true);
});

test("rejects stale generation, inactive sessions, mismatched identities, and missing exact claims", () => {
  assert.equal(validateResourceHandoff(snapshot({ claimSetGeneration: 5 }), options()).code, "STALE_CLAIM_SET");
  assert.equal(
    validateResourceHandoff(snapshot({ sessions: [session("source", "closing"), session("destination")] }), options())
      .code,
    "SESSION_NOT_ACTIVE",
  );
  assert.equal(
    validateResourceHandoff(
      snapshot({ sessions: [session("source"), { ...session("destination"), repositoryId: "other" }] }),
      options(),
    ).code,
    "REPOSITORY_MISMATCH",
  );
  assert.equal(
    validateResourceHandoff(snapshot({ claims: [claim("source", "src/*.ts")] }), options()).code,
    "MISSING_RESOURCE_CLAIM",
  );
});

test("rejects duplicate sessions and invalid persisted claim schema, mode, and timestamps", () => {
  const assertRegistryCorrupt = (candidate: ResourceHandoffSnapshot) => {
    assert.throws(
      () => validateResourceHandoff(candidate, options()),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
    );
  };

  assertRegistryCorrupt(snapshot({ sessions: [session("source"), session("source")] }));
  assertRegistryCorrupt(snapshot({ claims: [{ ...claim("source", "src/owned.ts"), schemaVersion: 2 as 3 }] }));
  assertRegistryCorrupt(
    snapshot({ claims: [{ ...claim("source", "src/owned.ts"), mode: "invalid" as ResourceClaim["mode"] }] }),
  );
  assertRegistryCorrupt(snapshot({ claims: [{ ...claim("source", "src/owned.ts"), createdAt: "not-a-timestamp" }] }));
});

test("retains unrelated destination claims as an integration invariant and rejects overlap", () => {
  const result = validateResourceHandoff(
    snapshot({ claims: [claim("source", "src/owned.ts"), claim("destination", "src/other.ts")] }),
    options(),
  );
  assert.equal(result.status, "allowed");

  const conflict = validateResourceHandoff(
    snapshot({ claims: [claim("source", "src/owned.ts"), claim("destination", "src/owned.ts", "exclusive-write")] }),
    options(),
  );
  assert.equal(conflict.status, "blocked");
  assert.equal(conflict.code, "RESOURCE_CLAIM_CONFLICT");
  assert.equal(conflict.blockers[0]?.ownerSessionId, "destination");
});

function fence(): ResourceHandoffFence {
  return {
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    sessionId: "source",
    operationId: "operation-1",
    epoch: 9,
    accepting: false,
    status: "fenced",
  };
}

function quiescence(status: ResourceHandoffQuiescence["status"] = "quiescent"): ResourceHandoffQuiescence {
  return {
    sessionId: "source",
    operationId: "operation-1",
    epoch: 9,
    status,
    activeExecutionIds: status === "active" ? ["exec-1"] : [],
    unknownExecutionIds: status === "unknown" ? ["pid-unknown"] : [],
  };
}

class FakeExecution implements ResourceHandoffFenceController {
  readonly calls: string[] = [];
  readonly result: ResourceHandoffQuiescence;

  constructor(result: ResourceHandoffQuiescence = quiescence()) {
    this.result = result;
  }

  fence(input: { readonly sessionId: string; readonly operationId: string }): ResourceHandoffFence {
    this.calls.push(`fence:${input.sessionId}:${input.operationId}`);
    return fence();
  }

  awaitQuiescence(input: ResourceHandoffFence): ResourceHandoffQuiescence {
    this.calls.push(`wait:${input.epoch}`);
    return this.result;
  }
}

class FakeAuthority implements ResourceHandoffAuthority {
  readonly calls: string[] = [];
  readonly snapshots: ResourceHandoffSnapshot[];
  commitInput: ResourceHandoffCommitInput | undefined;

  constructor(
    snapshots: ResourceHandoffSnapshot[],
    private readonly durabilityError = false,
    private readonly commitEvidence: unknown = undefined,
  ) {
    this.snapshots = snapshots;
  }

  readResourceHandoffSnapshot(): ResourceHandoffSnapshot {
    this.calls.push("read");
    return this.snapshots[
      Math.min(this.calls.filter((call) => call === "read").length - 1, this.snapshots.length - 1)
    ]!;
  }

  commitResourceHandoff(input: ResourceHandoffCommitInput) {
    this.calls.push("commit");
    this.commitInput = input;
    if (this.durabilityError) {
      throw new SessionRegistryError(
        "REGISTRY_DURABILITY_UNCERTAIN",
        "Registry rename may have committed but durability was not proven",
      );
    }
    if (this.commitEvidence !== undefined) return this.commitEvidence as ResourceHandoffCommitResult;
    return {
      status: "transferred" as const,
      operationId: input.normalized.operationId,
      claimSetGeneration: input.snapshot.registry.claimSetGeneration + 1,
      sourceClaim: null,
      destinationClaim: claim("destination", input.normalized.resource, input.normalized.mode),
    };
  }
}

test("malformed fences are typed unresolved outcomes and retain the source claim", async () => {
  for (const malformed of [null, {}, { sessionId: "source", operationId: "operation-1", epoch: Number.NaN }]) {
    const authority = new FakeAuthority([snapshot()]);
    const execution: ResourceHandoffFenceController = {
      fence: () => malformed as ResourceHandoffFence,
      awaitQuiescence: () => quiescence(),
    };
    const result = await handoffResources(authority, execution, options());
    assert.equal(result.status, "unresolved");
    assert.equal(result.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
    assert.equal(result.sourceClaim?.sessionId, "source");
    assert.deepEqual(authority.calls, ["read"]);
  }
});

test("malformed commit evidence is a controlled corruption outcome retaining the source claim", async () => {
  const authority = new FakeAuthority([snapshot(), snapshot()], false, null);
  const result = await handoffResources(authority, new FakeExecution(), options());
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "REGISTRY_CORRUPT");
  assert.equal(result.sourceClaim?.sessionId, "source");
  assert.deepEqual(authority.calls, ["read", "read", "commit"]);
});

test("fences, drains, revalidates, and commits through one atomic authority boundary", async () => {
  const authority = new FakeAuthority([snapshot(), snapshot()]);
  const execution = new FakeExecution();
  const result = await handoffResources(authority, execution, options());

  assert.equal(result.status, "transferred");
  assert.equal(result.code, "ALLOWED");
  assert.equal(result.sourceRetained, false);
  assert.deepEqual(execution.calls, ["fence:source:operation-1", "wait:9"]);
  assert.deepEqual(authority.calls, ["read", "read", "commit"]);
  assert.equal(authority.commitInput?.fence.epoch, 9);
  assert.equal(authority.commitInput?.quiescence.status, "quiescent");
});

test("active and unknown executions block or remain unresolved without releasing the source", async () => {
  const activeAuthority = new FakeAuthority([snapshot(), snapshot()]);
  const active = await handoffResources(activeAuthority, new FakeExecution(quiescence("active")), options());
  assert.equal(active.status, "blocked");
  assert.equal(active.code, "OPERATION_REJECTED");
  assert.equal(active.sourceRetained, true);
  assert.deepEqual(activeAuthority.calls, ["read"]);

  const unknownAuthority = new FakeAuthority([snapshot(), snapshot()]);
  const unknown = await handoffResources(unknownAuthority, new FakeExecution(quiescence("unknown")), options());
  assert.equal(unknown.status, "unresolved");
  assert.equal(unknown.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
  assert.equal(unknown.sourceRetained, true);
  assert.deepEqual(unknownAuthority.calls, ["read"]);
});

test("generation changes during drain are stale and never reach the atomic writer", async () => {
  const authority = new FakeAuthority([snapshot(), snapshot({ claimSetGeneration: 5 })]);
  const result = await handoffResources(authority, new FakeExecution(), options());
  assert.equal(result.status, "blocked");
  assert.equal(result.code, "STALE_CLAIM_SET");
  assert.equal(result.sourceRetained, true);
  assert.deepEqual(authority.calls, ["read", "read"]);
});

test("durability uncertainty is unresolved and retains the sender fact", async () => {
  const authority = new FakeAuthority([snapshot(), snapshot()], true);
  const result = await handoffResources(authority, new FakeExecution(), options());
  assert.equal(result.status, "unresolved");
  assert.equal(result.code, "REGISTRY_DURABILITY_UNCERTAIN");
  assert.equal(result.sourceRetained, true);
  assert.deepEqual(authority.calls, ["read", "read", "commit"]);
});

test("completed operation records make retries idempotent without refencing or writing", async () => {
  const retryOptions = options({
    operationId: canonicalResourceHandoffOperationId("source", "destination", "src/owned.ts", "write"),
  });
  const authority = new FakeAuthority([
    snapshot({
      completedOperations: [
        {
          operationId: retryOptions.operationId!,
          fromSessionId: "source",
          toSessionId: "destination",
          resource: "src/owned.ts",
          mode: "write",
          claimSetGeneration: 5,
        },
      ],
    }),
  ]);
  const execution = new FakeExecution();
  const result = await handoffResources(authority, execution, retryOptions);
  assert.equal(result.status, "idempotent");
  assert.equal(result.idempotent, true);
  assert.deepEqual(authority.calls, ["read"]);
  assert.deepEqual(execution.calls, []);
});

test("malformed required generation fails closed before any authority read", async () => {
  await assert.rejects(
    () => handoffResources(new FakeAuthority([snapshot()]), new FakeExecution(), options({ ifGeneration: null })),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_OPERATION",
  );
});

test("canonical operation IDs remain unambiguous for colon-containing fields", () => {
  const first = canonicalResourceHandoffOperationId("a:b", "c", "d", "write");
  const second = canonicalResourceHandoffOperationId("a", "b:c", "d", "write");
  assert.notEqual(first, second);
});
