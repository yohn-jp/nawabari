import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createResourceIntent } from "./resource-coordination.js";
import { SessionRegistry } from "./session-registry.js";

test("the registry composes real coordination producers into read-only public projections", () => {
  const registry = new SessionRegistry({ cwd: process.cwd() });
  const intent = createResourceIntent({
    sessionId: "coordination-integration-session",
    operation: "CREATE",
    selector: "src/new-file.ts",
  });

  const graph = registry.resourceCoordinationGraph([intent]);
  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.complete, true);
  assert.equal(graph.edges.length, 0);

  const snapshot = registry.resourceCoordinationSnapshot({ complete: true });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.contract.persisted, false);
  assert.equal(snapshot.contract.mutation, false);
  assert.deepEqual(snapshot.resources, []);
});

test("the registry persists completed handoff evidence for restart-safe idempotency", async () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const source = provisionBoundedSession(registry, fixture, "source", "feature/coordination-source", 500);
    const destinationRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const destination = provisionBoundedSession(
      destinationRegistry,
      fixture,
      "destination",
      "feature/coordination-destination",
      500,
    );
    const options = {
      fromSessionId: source.sessionId,
      toSessionId: destination.sessionId,
      resource: "README.md",
      mode: "write" as const,
      ifGeneration: registry.getClaimSetGeneration(),
      operationId: "handoff-restart-500",
    };

    const transferred = await registry.handoffResources(options);
    assert.equal(transferred.status, "transferred");
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      resource_handoff_operations?: readonly { operation_id: string }[];
    };
    assert.deepEqual(persisted.resource_handoff_operations?.map((operation) => operation.operation_id), [
      options.operationId,
    ]);

    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath });
    const retry = await restarted.handoffResources(options);
    assert.equal(retry.status, "idempotent");
    assert.equal(retry.code, "IDEMPOTENT");
  } finally {
    fixture.cleanup();
  }
});

test("claim deltas treat a changed sharing binding as a real update", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const firstSharing = { kind: "isolated-worktree" as const, groupId: "group-a" };
    const secondSharing = { kind: "isolated-worktree" as const, groupId: "group-b" };
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "write", sharing: firstSharing }],
    });

    const changed = registry.applyClaimDeltas({
      sessionId: session.sessionId,
      expectedClaimSetGeneration: 1,
      deltas: [{ kind: "upsert", resource: "README.md", mode: "write", sharing: secondSharing }],
    });
    assert.equal(changed.idempotent, false);
    assert.equal(changed.changed.length, 1);
    assert.deepEqual(changed.claims[0]?.sharing, secondSharing);
    assert.equal(changed.claimSetGeneration, 2);

    assert.throws(
      () =>
        registry.applyClaimDeltas({
          sessionId: session.sessionId,
          expectedClaimSetGeneration: 2,
          deltas: [
            { kind: "upsert", resource: "README.md", mode: "write", sharing: firstSharing },
            { kind: "upsert", resource: "README.md", mode: "write", sharing: secondSharing },
          ],
        }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "CONTRADICTORY_CLAIM",
    );
  } finally {
    fixture.cleanup();
  }
});

test("handoff commit revalidates destination scope after the unlocked drain", async () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const source = provisionBoundedSession(registry, fixture, "source", "feature/coordination-source", 501);
    const destinationRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const destination = provisionBoundedSession(
      destinationRegistry,
      fixture,
      "destination",
      "feature/coordination-destination",
      501,
    );
    const options = {
      fromSessionId: source.sessionId,
      toSessionId: destination.sessionId,
      resource: "README.md",
      mode: "write" as const,
      ifGeneration: registry.getClaimSetGeneration(),
      operationId: "handoff-commit-drift-501",
    };
    const registryWithDrift = registry as unknown as {
      readResourceHandoffSnapshot: () => unknown;
    };
    const readSnapshot = registryWithDrift.readResourceHandoffSnapshot.bind(registry);
    let reads = 0;
    registryWithDrift.readResourceHandoffSnapshot = () => {
      const snapshot = readSnapshot();
      reads += 1;
      if (reads === 2) {
        const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
          sessions: Array<{ session_id: string; working_set?: { scope?: { deny?: string[] } } }>;
        };
        const destinationRecord = persisted.sessions.find((record) => record.session_id === destination.sessionId);
        assert.ok(destinationRecord?.working_set?.scope);
        destinationRecord.working_set.scope.deny = ["README.md"];
        fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted)}\n`);
      }
      return snapshot;
    };

    const result = await registry.handoffResources(options);
    assert.equal(result.status, "unresolved");
    assert.equal(result.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
    assert.equal(result.sourceRetained, true);
    assert.equal(registry.listClaims(source.sessionId).length, 1);
    assert.equal(registry.listClaims(destination.sessionId).length, 0);
  } finally {
    fixture.cleanup();
  }
});

type CoordinationFixture = {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
};

function createRepositoryFixture(): CoordinationFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-coordination-"));
  const linkedWorktreePath = path.join(path.dirname(repositoryPath), `${path.basename(repositoryPath)}-linked`);
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  runGit(["worktree", "add", "-b", "feature/linked", linkedWorktreePath], repositoryPath);
  return {
    repositoryPath,
    linkedWorktreePath,
    cleanup(): void {
      const provisioned = [
        linkedWorktreePath,
        ...[500, 501].flatMap((number) => [
          path.join(path.dirname(repositoryPath), `nawabari-source-${number}`),
          path.join(path.dirname(repositoryPath), `nawabari-destination-${number}`),
        ]),
      ];
      for (const worktreePath of provisioned) {
        try {
          runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
        } catch {
          // The directory cleanup remains safe when Git metadata was already removed.
        }
      }
      fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function provisionBoundedSession(
  registry: SessionRegistry,
  fixture: CoordinationFixture,
  label: string,
  branchName: string,
  implementationNumber: number,
) {
  const revision = runGit(["rev-parse", "main"], fixture.repositoryPath);
  const repository = {
    repositoryHost: "local",
    repositoryId: registry.repository.repositoryId,
    repository: "local/nawabari",
  };
  const executionScope = {
    version: 1,
    kind: "implementation-execution-scope",
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: { ...repository, number: implementationNumber },
      governedBodyDigest: "b".repeat(64),
    },
    repository,
    base: { branch: "main", revision },
    scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
  };
  const candidateWorkingSet = {
    kind: "candidate-working-set",
    schemaVersion: 1,
    workingSetId: `candidate-${implementationNumber}-${label}`,
    repository,
    revision,
    entries: [
      {
        state: "required",
        target: { kind: "file", locator: "README.md" },
        reason: { id: "test:bootstrap", summary: "coordination integration" },
        evidence: [{ artifact: "test", reference: "README.md" }],
      },
    ],
  };
  return registry.provision({
    worktreePath: path.join(path.dirname(fixture.repositoryPath), `nawabari-${label}-${implementationNumber}`),
    branchName,
    baseRef: "main",
    initialClaims: label === "source" ? [{ resource: "README.md", mode: "write" as const }] : [],
    executionScope,
    candidateWorkingSet,
    workingSetRepository: repository,
  });
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    }),
  ).trim();
}
