import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

test("LocalSessionBackend handoff absence is fail-closed before registry mutation", async () => {
  const repositoryPath = createRepository();
  try {
    const { LocalSessionBackend } = await import("./domain/session-backend.js");
    const backend = new LocalSessionBackend();
    const result = await backend.handoffResources(
      { cwd: repositoryPath },
      {
        from_session_id: "source-session",
        to_session_id: "destination-session",
        resource: "README.md",
        mode: "write",
        if_generation: 0,
      },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "OPERATION_REJECTED");
    assert.deepEqual(result.error.details, { operation_code: "PHYSICAL_OBSERVATION_UNAVAILABLE" });
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
      registry_revision: number;
      runtime_epoch: number;
    };
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
    const options = {
      from_session_id: source.sessionId,
      to_session_id: destination.sessionId,
      resource: "README.md",
      mode: "write" as const,
      if_generation: registry.listClaimsSnapshot().claimSetGeneration,
      operation_id: "handoff-500",
    };
    const result = await registry.handoffResources(options, execution);
    assert.equal(result.status, "transferred");
    assert.equal(registry.listClaims(source.sessionId).length, 0);
    assert.equal(registry.listClaims(destination.sessionId)[0]?.mode, "write");
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      registry_revision: number;
      runtime_epoch: number;
      required_features: string[];
      recent_events: Array<Record<string, unknown>>;
    };
    assert.equal(persisted.registry_revision, before.registry_revision + 1);
    assert.equal(persisted.runtime_epoch, before.runtime_epoch);
    assert.deepEqual(persisted.required_features, ["recent-events.v1"]);
    assert.deepEqual(persisted.recent_events[0], {
      kind: "resource-handoff",
      schema_version: 1,
      operation_id: "handoff-500",
      from_session_id: source.sessionId,
      to_session_id: destination.sessionId,
      resource: "README.md",
      mode: "write",
      claim_set_generation: result.claimSetGeneration,
    });
    const retry = await new SessionRegistry({ cwd: repositoryPath }).handoffResources(options, execution);
    assert.equal(retry.status, "idempotent");
    assert.equal(retry.idempotent, true);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

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
