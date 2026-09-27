import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_RUNTIME_RECORDS } from "./registry/runtime-records.js";
import { SessionRegistry } from "./session-registry.js";

test("SessionRegistry composes coordination graph, transaction, preview, and snapshot producers", () => {
  const repositoryPath = createRepository();
  const linkedWorktreePath = `${repositoryPath}-linked`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const source = registry.create({ label: "source" });
    const destination = registry.provision({
      worktreePath: linkedWorktreePath,
      branchName: "feature/coordination-destination",
      label: "destination",
    });
    registry.claimResources({ sessionId: source.sessionId, claims: [{ resource: "README.md", mode: "write" }] });

    const graph = registry.resourceCoordinationGraph([]);
    assert.equal(graph.edges.length, 0);

    const transaction = registry.applyCoordinationTransaction({
      kind: "acquire",
      sessionId: destination.sessionId,
      claims: [{ resource: "src/new.ts", mode: "write" }],
      force: true,
    });
    assert.equal(transaction.idempotent, false);
    assert.equal(registry.listClaims(destination.sessionId)[0]?.resource, "src/new.ts");
    registry.claimResources({ sessionId: destination.sessionId, claims: [{ resource: "README.md", mode: "read" }] });

    const preview = registry.coordinationPreview({
      left_session_id: source.sessionId,
      right_session_id: destination.sessionId,
      path: "README.md",
    });
    assert.equal(preview.operation, "coordination-preview");
    assert.equal(preview.patch, null);

    const snapshot = registry.resourceCoordinationSnapshot({
      resourceIntents: [{ sessionId: source.sessionId, mode: "write", resource: "README.md" }],
      observedChanges: [],
      mergeability: [],
      complete: true,
    });
    assert.equal(snapshot.contract.mutation, false);
    assert.equal(snapshot.registry.claimSetGeneration, registry.listClaimsSnapshot().claimSetGeneration);
  } finally {
    removeWorktree(repositoryPath, linkedWorktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("default LocalSessionBackend handoff uses managed runtime evidence and fails closed without admission", async () => {
  const repositoryPath = createRepository();
  try {
    const { LocalSessionBackend } = await import("./domain/session-backend.js");
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const { source, destination } = provisionHandoffSessions(registry, repositoryPath, 626);
    const before = fs.readFileSync(registry.paths.registry, "utf8");
    const result = await new LocalSessionBackend().handoffResources(
      { cwd: repositoryPath },
      {
        from_session_id: source.sessionId,
        to_session_id: destination.sessionId,
        resource: "README.md",
        mode: "write",
        if_generation: registry.listClaimsSnapshot().claimSetGeneration,
        operation_id: "handoff-626-untracked",
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // No caller-injected controller: the untracked source admission cannot be
    // fenced, so the real adapter never fabricates quiescence.
    assert.equal(result.value.status, "unresolved");
    assert.equal(result.value.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
    assert.equal(result.value.sourceRetained, true);
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), before);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource handoff persists one atomic retry receipt and retries idempotently", async () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: registry.repository.repositoryId };
    const executionScope = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 500 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-500",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:handoff", summary: "bounded handoff" },
          evidence: [],
        },
      ],
    };
    const source = registry.provision({
      branchName: "feature/handoff-source",
      executionScope,
      candidateWorkingSet,
      initialClaims: [{ resource: "README.md", mode: "write" }],
    });
    const destination = registry.provision({
      branchName: "feature/handoff-destination",
      executionScope,
      candidateWorkingSet,
    });
    const before = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
    };
    const executionCalls: string[] = [];
    const execution = {
      fence: ({ sessionId, operationId }: { sessionId: string; operationId: string }) => {
        executionCalls.push(`fence:${sessionId}:${operationId}`);
        return {
          schemaVersion: 1 as const,
          sessionId,
          operationId,
          epoch: 1,
          accepting: false as const,
          status: "fenced" as const,
        };
      },
      awaitQuiescence: (fence: { sessionId: string; operationId: string; epoch: number }) => ({
        sessionId: fence.sessionId,
        operationId: fence.operationId,
        epoch: fence.epoch,
        status: "quiescent" as const,
        activeExecutionIds: [],
        unknownExecutionIds: [],
      }),
    };
    const options = {
      from_session_id: source.sessionId,
      to_session_id: destination.sessionId,
      resource: "README.md",
      mode: "write" as const,
      if_generation: registry.listClaimsSnapshot().claimSetGeneration,
      operation_id: "handoff-500",
    };
    // Model a lost operation response: the caller ignores the committed result
    // and recognizes it through the durable receipt after constructing a new registry.
    await registry.handoffResources(options, execution);
    assert.equal(registry.listClaims(source.sessionId).length, 0);
    assert.equal(registry.listClaims(destination.sessionId)[0]?.mode, "write");
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    assert.equal(persisted.registry_revision, before.registry_revision + 1);
    assert.equal(persisted.claim_set_generation, before.claim_set_generation + 1);
    assert.equal(persisted.runtime_epoch, before.runtime_epoch);
    assert.deepEqual(persisted.required_features, ["recent-events.v1", "session-history.v1"]);
    assert.deepEqual(
      persisted.recent_events.filter((record) => record.kind === "resource-handoff"),
      [
        {
          kind: "resource-handoff",
          schema_version: 1,
          operation_id: "handoff-500",
          from_session_id: source.sessionId,
          to_session_id: destination.sessionId,
          resource: "README.md",
          mode: "write",
          claim_set_generation: before.claim_set_generation + 1,
        },
      ],
    );
    const retry = await new SessionRegistry({ cwd: repositoryPath }).handoffResources(options, execution);
    assert.equal(retry.status, "idempotent");
    assert.equal(retry.idempotent, true);
    assert.deepEqual(executionCalls, [`fence:${source.sessionId}:handoff-500`]);
    const afterRetry = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
    };
    assert.equal(afterRetry.registry_revision, persisted.registry_revision);
    assert.equal(afterRetry.claim_set_generation, persisted.claim_set_generation);

    const changedIntent = await new SessionRegistry({ cwd: repositoryPath }).handoffResources(
      { ...options, resource: "src/changed.ts" },
      execution,
    );
    assert.equal(changedIntent.status, "blocked");
    assert.equal(changedIntent.code, "OPERATION_REJECTED");
    assert.deepEqual(executionCalls, [`fence:${source.sessionId}:handoff-500`]);
    const afterChangedIntent = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
    };
    assert.equal(afterChangedIntent.registry_revision, persisted.registry_revision);
    assert.equal(afterChangedIntent.claim_set_generation, persisted.claim_set_generation);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource handoff prunes history under pressure without evicting receipts", async () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const { source, destination } = provisionHandoffSessions(registry, repositoryPath, 672);
    const before = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    const priorHistory = before.recent_events.filter((event) => event.kind !== "resource-handoff");
    assert.ok(priorHistory.length >= 2);
    const retainedHistory = priorHistory.slice(-2);
    const priorReceipts = Array.from({ length: MAX_RUNTIME_RECORDS - retainedHistory.length }, (_, index) => ({
      kind: "resource-handoff",
      schema_version: 1,
      operation_id: `handoff-672-history-${index}`,
      from_session_id: source.sessionId,
      to_session_id: destination.sessionId,
      resource: "README.md",
      mode: "write",
      claim_set_generation: index + 1,
    }));
    const seededClaimSetGeneration = Math.max(before.claim_set_generation, priorReceipts.length);
    fs.writeFileSync(
      registry.paths.registry,
      JSON.stringify(
        {
          ...before,
          claim_set_generation: seededClaimSetGeneration,
          recent_events: [...priorReceipts, ...retainedHistory],
        },
        null,
        2,
      ) + "\n",
    );

    const current = new SessionRegistry({ cwd: repositoryPath });
    const options = handoffOptions(current, source.sessionId, destination.sessionId, "handoff-672-pressure");
    const result = await current.handoffResources(options, successfulHandoffExecution());
    assert.equal(result.status, "transferred");

    const after = JSON.parse(fs.readFileSync(current.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    assert.equal(after.registry_revision, before.registry_revision + 1);
    assert.equal(after.claim_set_generation, seededClaimSetGeneration + 1);
    assert.equal(after.runtime_epoch, before.runtime_epoch);
    assert.deepEqual(after.required_features, ["recent-events.v1", "session-history.v1"]);
    assert.equal(after.recent_events.length, MAX_RUNTIME_RECORDS);
    const receipts = after.recent_events.filter((event) => event.kind === "resource-handoff");
    assert.equal(receipts.length, priorReceipts.length + 1);
    assert.deepEqual(
      receipts.slice(0, priorReceipts.length).map((event) => event.operation_id),
      priorReceipts.map((event) => event.operation_id),
    );
    assert.deepEqual(
      after.recent_events.filter((event) => event.kind !== "resource-handoff"),
      [retainedHistory.at(-1)],
    );
    const historySession = current.create({ label: "history-under-receipt-pressure" });
    const afterHistoryWrite = JSON.parse(fs.readFileSync(current.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    assert.equal(afterHistoryWrite.registry_revision, after.registry_revision + 1);
    assert.equal(afterHistoryWrite.claim_set_generation, after.claim_set_generation);
    assert.deepEqual(afterHistoryWrite.required_features, ["recent-events.v1", "session-history.v1"]);
    assert.equal(
      afterHistoryWrite.recent_events.filter((event) => event.kind === "resource-handoff").length,
      priorReceipts.length + 1,
    );
    assert.deepEqual(
      afterHistoryWrite.recent_events
        .filter((event) => event.kind !== "resource-handoff")
        .map((event) => event.session_id),
      [historySession.sessionId],
    );
    const reloaded = new SessionRegistry({ cwd: repositoryPath }).readRepositoryView();
    assert.equal(
      reloaded.runtimeRecords.records.recent_events?.filter((event) => event.kind === "resource-handoff").length,
      priorReceipts.length + 1,
    );
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource handoff fails closed at receipt capacity without changing claims or revisions", async () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const { source, destination } = provisionHandoffSessions(registry, repositoryPath, 673);
    const before = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
    };
    const receipts = Array.from({ length: MAX_RUNTIME_RECORDS }, (_, index) => ({
      kind: "resource-handoff",
      schema_version: 1,
      operation_id: `handoff-673-full-${index}`,
      from_session_id: source.sessionId,
      to_session_id: destination.sessionId,
      resource: "README.md",
      mode: "write",
      claim_set_generation: index + 1,
    }));
    const seededClaimSetGeneration = Math.max(before.claim_set_generation, MAX_RUNTIME_RECORDS);
    fs.writeFileSync(
      registry.paths.registry,
      JSON.stringify({
        ...before,
        claim_set_generation: seededClaimSetGeneration,
        required_features: ["recent-events.v1"],
        recent_events: receipts,
      }) + "\n",
    );

    const current = new SessionRegistry({ cwd: repositoryPath });
    const beforeFailure = fs.readFileSync(current.paths.registry, "utf8");
    const options = handoffOptions(current, source.sessionId, destination.sessionId, "handoff-673-capacity");
    const result = await current.handoffResources(options, successfulHandoffExecution());
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "OPERATION_REJECTED");
    assert.equal(result.sourceRetained, true);
    assert.match(result.blockers[0]?.reason ?? "", /"maximum":256/u);
    assert.match(result.blockers[0]?.reason ?? "", /"receiptCount":256/u);
    assert.match(result.blockers[0]?.reason ?? "", /"historyCount":0/u);
    assert.match(result.blockers[0]?.reason ?? "", /"sourceRetained":true/u);
    assert.equal(fs.readFileSync(current.paths.registry, "utf8"), beforeFailure);
    assert.equal(current.listClaims(source.sessionId).length, 1);
    assert.equal(current.listClaims(destination.sessionId).length, 0);
    const after = JSON.parse(fs.readFileSync(current.paths.registry, "utf8")) as {
      claim_set_generation: number;
      registry_revision: number;
      runtime_epoch: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    assert.equal(after.registry_revision, before.registry_revision);
    assert.equal(after.claim_set_generation, seededClaimSetGeneration);
    assert.equal(after.runtime_epoch, before.runtime_epoch);
    assert.deepEqual(after.required_features, ["recent-events.v1"]);
    assert.equal(after.recent_events.length, MAX_RUNTIME_RECORDS);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource handoff rejects a destination conflict without changing claims or persistence", async () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: registry.repository.repositoryId };
    const executionScope = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 500 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-500-conflict",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:handoff-conflict", summary: "bounded handoff conflict" },
          evidence: [],
        },
      ],
    };
    const source = registry.provision({
      worktreePath: `${repositoryPath}-handoff-conflict-source`,
      branchName: "feature/handoff-conflict-source",
      executionScope,
      candidateWorkingSet,
      initialClaims: [
        { resource: "README.md", mode: "write", sharing: { kind: "isolated-worktree", groupId: "group-500" } },
      ],
    });
    const retained = registry.provision({
      worktreePath: `${repositoryPath}-handoff-conflict-retained`,
      branchName: "feature/handoff-conflict-retained",
      executionScope,
      candidateWorkingSet,
      initialClaims: [
        { resource: "README.md", mode: "write", sharing: { kind: "isolated-worktree", groupId: "group-500" } },
      ],
    });
    const destination = registry.provision({
      worktreePath: `${repositoryPath}-handoff-conflict-destination`,
      branchName: "feature/handoff-conflict-destination",
      executionScope,
      candidateWorkingSet,
    });
    const beforeRegistry = fs.readFileSync(registry.paths.registry, "utf8");
    const beforeGeneration = registry.listClaimsSnapshot().claimSetGeneration;
    const execution = {
      fence: ({ sessionId, operationId }: { sessionId: string; operationId: string }) => ({
        schemaVersion: 1 as const,
        sessionId,
        operationId,
        epoch: 1,
        accepting: false as const,
        status: "fenced" as const,
      }),
      awaitQuiescence: (fence: { sessionId: string; operationId: string; epoch: number }) => ({
        sessionId: fence.sessionId,
        operationId: fence.operationId,
        epoch: fence.epoch,
        status: "quiescent" as const,
        activeExecutionIds: [],
        unknownExecutionIds: [],
      }),
    };

    const result = await registry.handoffResources(
      {
        from_session_id: source.sessionId,
        to_session_id: destination.sessionId,
        resource: "README.md",
        mode: "exclusive-write",
        if_generation: beforeGeneration,
        operation_id: "handoff-500-conflict",
      },
      execution,
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.code, "RESOURCE_CLAIM_CONFLICT");
    assert.equal(result.sourceRetained, true);
    assert.equal(registry.listClaims(source.sessionId).length, 1);
    assert.equal(registry.listClaims(retained.sessionId).length, 1);
    assert.equal(registry.listClaims(destination.sessionId).length, 0);
    assert.equal(registry.listClaimsSnapshot().claimSetGeneration, beforeGeneration);
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), beforeRegistry);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function provisionHandoffSessions(registry: SessionRegistry, repositoryPath: string, issue: number) {
  const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
  const identity = { repositoryHost: "local", repositoryId: registry.repository.repositoryId };
  const executionScope = {
    version: 1,
    kind: "implementation-execution-scope",
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: { ...identity, number: issue },
      governedBodyDigest: "b".repeat(64),
    },
    repository: identity,
    base: { branch: "main", revision },
    scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
  };
  const candidateWorkingSet = {
    kind: "candidate-working-set",
    schemaVersion: 1,
    workingSetId: `candidate-${issue}`,
    repository: { ...identity, repository: "local/nawabari" },
    revision,
    entries: [
      {
        state: "required",
        target: { kind: "file", locator: "README.md" },
        reason: { id: "test:handoff", summary: "bounded handoff" },
        evidence: [],
      },
    ],
  };
  const source = registry.provision({
    branchName: `feature/handoff-source-${issue}`,
    executionScope,
    candidateWorkingSet,
    initialClaims: [{ resource: "README.md", mode: "write" }],
  });
  const destination = registry.provision({
    branchName: `feature/handoff-destination-${issue}`,
    executionScope,
    candidateWorkingSet,
  });
  return { source, destination };
}

function handoffOptions(registry: SessionRegistry, fromSessionId: string, toSessionId: string, operationId: string) {
  return {
    from_session_id: fromSessionId,
    to_session_id: toSessionId,
    resource: "README.md",
    mode: "write" as const,
    if_generation: registry.listClaimsSnapshot().claimSetGeneration,
    operation_id: operationId,
  };
}

function successfulHandoffExecution() {
  return {
    fence: ({ sessionId, operationId }: { sessionId: string; operationId: string }) => ({
      schemaVersion: 1 as const,
      sessionId,
      operationId,
      epoch: 1,
      accepting: false as const,
      status: "fenced" as const,
    }),
    awaitQuiescence: (fence: { sessionId: string; operationId: string; epoch: number }) => ({
      sessionId: fence.sessionId,
      operationId: fence.operationId,
      epoch: fence.epoch,
      status: "quiescent" as const,
      activeExecutionIds: [],
      unknownExecutionIds: [],
    }),
  };
}

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-coordination-"));
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "user.email", "tests@example.invalid"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "coordination\n");
  fs.mkdirSync(path.join(repositoryPath, "src"));
  runGit(["add", "README.md", "src"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
}
