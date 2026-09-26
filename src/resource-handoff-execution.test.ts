import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deriveCgroupScopeName, type CgroupFileSystem } from "./domain/cgroups-v2.js";
import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
  type PersistedSessionExecutionRecord,
} from "./domain/session-execution-record.js";
import { LocalSessionBackend } from "./domain/session-backend.js";
import { createManagedResourceHandoffExecution } from "./resource-handoff-execution.js";
import type { ResourceHandoffFenceController, ResourceHandoffResult } from "./resource-handoff.js";
import { SessionRegistry } from "./session-registry.js";

const CGROUP_ROOT = "/sys/fs/cgroup/user.slice/handoff-test.scope";

type Occupancy = "empty" | "populated" | "missing";

interface HandoffFixture {
  readonly repositoryPath: string;
  readonly sourceId: string;
  readonly destinationId: string;
  readonly epoch: number;
  readonly registry: SessionRegistry;
  cleanup(): void;
}

function createHandoffFixture(
  executions: readonly PersistedSessionExecutionRecord[] | "none" = "none",
): HandoffFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-handoff-execution-"));
  const sourcePath = `${repositoryPath}-source`;
  const destinationPath = `${repositoryPath}-destination`;
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "user.email", "tests@example.invalid"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "handoff\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
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
      implementation: { ...identity, number: 626 },
      governedBodyDigest: "c".repeat(64),
    },
    repository: identity,
    base: { branch: "main", revision },
    scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
  };
  const candidateWorkingSet = {
    kind: "candidate-working-set",
    schemaVersion: 1,
    workingSetId: "candidate-626",
    repository: { ...identity, repository: "local/nawabari" },
    revision,
    entries: [
      {
        state: "required",
        target: { kind: "file", locator: "README.md" },
        reason: { id: "test:managed-handoff", summary: "managed handoff" },
        evidence: [],
      },
    ],
  };
  const source = registry.provision({
    worktreePath: sourcePath,
    branchName: "feature/handoff-execution-source",
    executionScope,
    candidateWorkingSet,
    initialClaims: [{ resource: "README.md", mode: "write" }],
  });
  const destination = registry.provision({
    worktreePath: destinationPath,
    branchName: "feature/handoff-execution-destination",
    executionScope,
    candidateWorkingSet,
  });
  const base = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const epoch = Number(base.runtime_epoch);
  const records =
    executions === "none" ? [] : executions.map((record) => ({ ...record, session_id: source.sessionId }));
  fs.writeFileSync(
    registry.paths.registry,
    `${JSON.stringify(
      {
        ...base,
        required_features: ["runtime-sessions.v1", "executions.v1"],
        runtime_sessions: [
          {
            kind: "session-admission",
            schema_version: 1,
            session_id: source.sessionId,
            admission: "open",
            runtime_epoch: epoch,
          },
        ],
        executions: records.map((record) => ({
          ...record,
          cgroup_identity: { ...record.cgroup_identity, session_id: source.sessionId },
        })),
      },
      null,
      2,
    )}\n`,
  );
  return {
    repositoryPath,
    sourceId: source.sessionId,
    destinationId: destination.sessionId,
    epoch,
    registry,
    cleanup(): void {
      for (const worktreePath of [sourcePath, destinationPath]) {
        try {
          runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
        } catch {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      }
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function execution(executionId: string, overrides: { readonly bootId?: string } = {}): PersistedSessionExecutionRecord {
  const starting = reserveExecution({
    session_id: "placeholder-session",
    execution_id: executionId,
    cgroup_root: CGROUP_ROOT,
    profile_digest: "a".repeat(64),
    filesystem_token: "b".repeat(64),
    runtime_epoch: 0,
    boot_id: overrides.bootId ?? currentBootId(),
    now: "2026-09-26T00:00:00.000Z",
  });
  if (!starting.ok) throw new Error("execution reservation fixture was rejected");
  const exited = recordExecutionState(starting.value, { state: "exited", now: "2026-09-26T00:00:01.000Z" });
  if (!exited.ok) throw new Error("execution transition fixture was rejected");
  return toPersistedSessionExecutionRecord(exited.value);
}

/** Hermetic cgroups v2 filesystem keyed by each owned execution scope name. */
function cgroupFilesystem(
  sessionId: string,
  occupancy: Readonly<Record<string, Occupancy>>,
  onRead: (file: string) => void = () => undefined,
): CgroupFileSystem {
  const stateFor = (file: string): Occupancy => {
    for (const [executionId, state] of Object.entries(occupancy)) {
      const scope = deriveCgroupScopeName({ session_id: sessionId, execution_id: executionId });
      if (file.includes(`/nawabari/${scope}/`)) return state;
    }
    return "missing";
  };
  return {
    statSync: () => ({ isDirectory: () => true, isFile: () => true }),
    realpathSync: (file: string) => file,
    readFileSync: (file: string) => {
      onRead(file);
      const state = stateFor(file);
      if (state === "missing") throw new Error("cgroup scope is unavailable");
      if (file.endsWith("cgroup.events")) return state === "populated" ? "populated 1\n" : "populated 0\n";
      if (file.endsWith("cgroup.procs")) return state === "populated" ? "4242\n" : "";
      throw new Error("unobserved cgroup file");
    },
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    rmdirSync: () => undefined,
  } as unknown as CgroupFileSystem;
}

function handoffOptions(fixture: HandoffFixture, operationId: string) {
  return {
    from_session_id: fixture.sourceId,
    to_session_id: fixture.destinationId,
    resource: "README.md",
    mode: "write" as const,
    if_generation: fixture.registry.listClaimsSnapshot().claimSetGeneration,
    operation_id: operationId,
  };
}

function admission(registry: SessionRegistry, sessionId: string) {
  return registry.getSessionLaunchAdmission(sessionId);
}

test("default LocalSessionBackend handoff transfers only after fully observed empty owned scopes", async () => {
  const fixture = createHandoffFixture([execution("exec-empty-a"), execution("exec-empty-b")]);
  try {
    const observedLockState: boolean[] = [];
    const backend = new LocalSessionBackend({
      registry: {
        cgroupFilesystem: cgroupFilesystem(
          fixture.sourceId,
          { "exec-empty-a": "empty", "exec-empty-b": "empty" },
          () => {
            observedLockState.push(fs.existsSync(fixture.registry.paths.lock));
          },
        ),
      },
    });
    const options = handoffOptions(fixture, "handoff-626-positive");
    const result = await backend.handoffResources({ cwd: fixture.repositoryPath }, options);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "transferred");
    assert.equal(result.value.fenceEpoch, fixture.epoch + 1);
    assert.equal(fixture.registry.listClaims(fixture.sourceId).length, 0);
    assert.equal(fixture.registry.listClaims(fixture.destinationId)[0]?.mode, "write");
    assert.deepEqual(admission(fixture.registry, fixture.sourceId), {
      kind: "session-admission",
      schema_version: 1,
      session_id: fixture.sourceId,
      admission: "closed",
      runtime_epoch: fixture.epoch + 1,
    });
    assert.ok(observedLockState.length > 0);
    assert.ok(
      observedLockState.every((held) => !held),
      "RepositoryLock must not be held while observing",
    );

    const retry = await backend.handoffResources({ cwd: fixture.repositoryPath }, options);
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.value.status, "idempotent");
    assert.equal(retry.value.idempotent, true);

    // The fenced source still drains and closes through the #403 lifecycle.
    const closed = await backend.closeSession({ cwd: fixture.repositoryPath }, { session_id: fixture.sourceId });
    assert.equal(closed.ok, true, closed.ok ? "" : JSON.stringify(closed.error));
    assert.equal(fixture.registry.get(fixture.sourceId)?.state, "closed");
  } finally {
    fixture.cleanup();
  }
});

test("zero durable execution records are unknown and retain the source claim", async () => {
  const fixture = createHandoffFixture();
  try {
    const backend = new LocalSessionBackend({ registry: { cgroupFilesystem: cgroupFilesystem(fixture.sourceId, {}) } });
    const result = await backend.handoffResources(
      { cwd: fixture.repositoryPath },
      handoffOptions(fixture, "handoff-626-empty-ledger"),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "unresolved");
    assert.equal(result.value.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
    assert.equal(result.value.sourceRetained, true);
    assert.equal(fixture.registry.listClaims(fixture.sourceId)[0]?.resource, "README.md");
    assert.equal(fixture.registry.listClaims(fixture.destinationId).length, 0);
    // Admission was still fenced before observation.
    assert.equal(admission(fixture.registry, fixture.sourceId)?.admission, "closed");
  } finally {
    fixture.cleanup();
  }
});

test("an owned populated execution is active and blocks with the source claim retained", async () => {
  const fixture = createHandoffFixture([execution("exec-busy"), execution("exec-idle")]);
  try {
    const backend = new LocalSessionBackend({
      registry: {
        cgroupFilesystem: cgroupFilesystem(fixture.sourceId, { "exec-busy": "populated", "exec-idle": "empty" }),
      },
    });
    const result = await backend.handoffResources(
      { cwd: fixture.repositoryPath },
      handoffOptions(fixture, "handoff-626-active"),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.status, "blocked");
    assert.equal(result.value.sourceRetained, true);
    assert.deepEqual(blockedExecutionIds(result.value), ["exec-busy"]);
    assert.equal(fixture.registry.listClaims(fixture.sourceId)[0]?.resource, "README.md");
    assert.equal(fixture.registry.listClaims(fixture.destinationId).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("unobservable, boot-mismatched, or rootless executions are unknown and fail closed", async () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly records: readonly PersistedSessionExecutionRecord[];
    readonly occupancy: Readonly<Record<string, Occupancy>>;
    readonly unknown: readonly string[];
  }> = [
    {
      name: "missing-scope",
      records: [execution("exec-gone"), execution("exec-clear")],
      occupancy: { "exec-clear": "empty" },
      unknown: ["exec-gone"],
    },
    {
      name: "boot-mismatch",
      records: [execution("exec-old-boot", { bootId: "00000000-0000-4000-8000-000000000000" })],
      occupancy: { "exec-old-boot": "empty" },
      unknown: ["exec-old-boot"],
    },
    {
      name: "legacy-rootless",
      // Legacy records without an exact scope root are parseable but unobservable.
      records: [{ ...execution("exec-rootless"), cgroup_root: null }],
      occupancy: { "exec-rootless": "empty" },
      unknown: ["exec-rootless"],
    },
  ];
  for (const candidate of cases) {
    const fixture = createHandoffFixture(candidate.records);
    try {
      const backend = new LocalSessionBackend({
        registry: { cgroupFilesystem: cgroupFilesystem(fixture.sourceId, candidate.occupancy) },
      });
      const result = await backend.handoffResources(
        { cwd: fixture.repositoryPath },
        handoffOptions(fixture, `handoff-626-${candidate.name}`),
      );
      assert.equal(result.ok, true, candidate.name);
      if (!result.ok) return;
      assert.equal(result.value.status, "unresolved", candidate.name);
      assert.equal(result.value.code, "PHYSICAL_OBSERVATION_UNAVAILABLE", candidate.name);
      assert.deepEqual(blockedExecutionIds(result.value), candidate.unknown, candidate.name);
      assert.equal(fixture.registry.listClaims(fixture.sourceId)[0]?.resource, "README.md", candidate.name);
      assert.equal(fixture.registry.listClaims(fixture.destinationId).length, 0, candidate.name);
    } finally {
      fixture.cleanup();
    }
  }
});

test("a malformed execution ledger is unknown rather than quiescent", async () => {
  const fixture = createHandoffFixture([execution("exec-valid")]);
  try {
    const document = JSON.parse(fs.readFileSync(fixture.registry.paths.registry, "utf8")) as Record<string, unknown>;
    const records = document.executions as Array<Record<string, unknown>>;
    const executions = createManagedResourceHandoffExecution({
      readSessionRuntimeEpoch: (sessionId) => fixture.registry.readSessionRuntimeEpoch(sessionId),
      closeSessionLaunchAdmission: (sessionId, expected) =>
        fixture.registry.closeSessionLaunchAdmission(sessionId, expected),
      getSessionLaunchAdmission: (sessionId) => fixture.registry.getSessionLaunchAdmission(sessionId),
      listSessionExecutions: (sessionId) => {
        const current = JSON.parse(fs.readFileSync(fixture.registry.paths.registry, "utf8")) as Record<string, unknown>;
        fs.writeFileSync(
          fixture.registry.paths.registry,
          `${JSON.stringify({ ...current, executions: [{ ...records[0], boot_id: 7 }] }, null, 2)}\n`,
        );
        return fixture.registry.listSessionExecutions(sessionId);
      },
      cgroupObservationFilesystem: cgroupFilesystem(fixture.sourceId, { "exec-valid": "empty" }),
    });
    const fence = await executions.fence({ sessionId: fixture.sourceId, operationId: "handoff-626-malformed" });
    const quiescence = await executions.awaitQuiescence(fence);
    assert.equal(quiescence.status, "unknown");
    assert.equal(quiescence.epoch, fence.epoch);
  } finally {
    fixture.cleanup();
  }
});

test("fence closes launch admission before any execution observation and binds the post-close epoch", async () => {
  const fixture = createHandoffFixture([execution("exec-ordered")]);
  try {
    const calls: string[] = [];
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      cgroupFilesystem: cgroupFilesystem(fixture.sourceId, { "exec-ordered": "empty" }, () => calls.push("observe")),
    });
    const controller = createManagedResourceHandoffExecution({
      readSessionRuntimeEpoch: (sessionId) => {
        calls.push("epoch");
        return registry.readSessionRuntimeEpoch(sessionId);
      },
      closeSessionLaunchAdmission: (sessionId, expected) => {
        calls.push(`close:${expected}`);
        return registry.closeSessionLaunchAdmission(sessionId, expected);
      },
      getSessionLaunchAdmission: (sessionId) => {
        calls.push("admission");
        return registry.getSessionLaunchAdmission(sessionId);
      },
      listSessionExecutions: (sessionId) => {
        calls.push("executions");
        return registry.listSessionExecutions(sessionId);
      },
      get cgroupObservationFilesystem() {
        return registry.cgroupObservationFilesystem;
      },
    });
    const fence = await controller.fence({ sessionId: fixture.sourceId, operationId: "handoff-626-order" });
    assert.deepEqual(calls, ["epoch", `close:${fixture.epoch}`]);
    assert.deepEqual(fence, {
      schemaVersion: 1,
      sessionId: fixture.sourceId,
      operationId: "handoff-626-order",
      epoch: fixture.epoch + 1,
      accepting: false,
      status: "fenced",
    });
    assert.equal(admission(registry, fixture.sourceId)?.admission, "closed");

    const quiescence = await controller.awaitQuiescence(fence);
    assert.equal(calls.indexOf("executions") > calls.indexOf(`close:${fixture.epoch}`), true);
    assert.equal(calls.indexOf("observe") > calls.indexOf("executions"), true);
    assert.deepEqual(quiescence, {
      sessionId: fixture.sourceId,
      operationId: "handoff-626-order",
      epoch: fence.epoch,
      status: "quiescent",
      activeExecutionIds: [],
      unknownExecutionIds: [],
    });
  } finally {
    fixture.cleanup();
  }
});

test("a stale fence runtime epoch prevents the handoff commit", async () => {
  const fixture = createHandoffFixture([execution("exec-stale-epoch")]);
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      cgroupFilesystem: cgroupFilesystem(fixture.sourceId, { "exec-stale-epoch": "empty" }),
    });
    const real = createManagedResourceHandoffExecution(registry);
    const controller: ResourceHandoffFenceController = {
      fence: async (input) => {
        const fence = await real.fence(input);
        // Another runtime authority advances the epoch after the fence closes admission.
        registry.closeSessionLaunchAdmission(fixture.sourceId, fence.epoch);
        return fence;
      },
      awaitQuiescence: (fence) => real.awaitQuiescence(fence),
    };
    const result = await registry.handoffResources(handoffOptions(fixture, "handoff-626-stale-epoch"), controller);
    assert.equal(result.status, "unresolved");
    assert.equal(result.sourceRetained, true);
    assert.equal(registry.listClaims(fixture.sourceId)[0]?.resource, "README.md");
    assert.equal(registry.listClaims(fixture.destinationId).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a claim-generation change during observation prevents the handoff commit", async () => {
  const fixture = createHandoffFixture([execution("exec-stale-generation")]);
  try {
    let mutated = false;
    const registry: SessionRegistry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      cgroupFilesystem: cgroupFilesystem(fixture.sourceId, { "exec-stale-generation": "empty" }, () => {
        if (mutated) return;
        mutated = true;
        registry.claimResources({
          sessionId: fixture.destinationId,
          claims: [{ resource: "src/other.ts", mode: "write" }],
        });
      }),
    });
    const result = await registry.handoffResources(
      handoffOptions(fixture, "handoff-626-stale-generation"),
      createManagedResourceHandoffExecution(registry),
    );
    assert.equal(mutated, true);
    assert.equal(result.status, "blocked");
    assert.equal(result.code, "STALE_CLAIM_SET");
    assert.equal(registry.listClaims(fixture.sourceId)[0]?.resource, "README.md");
  } finally {
    fixture.cleanup();
  }
});

test("an explicitly injected handoff controller overrides the managed runtime adapter", async () => {
  const fixture = createHandoffFixture();
  try {
    const calls: string[] = [];
    const injected: ResourceHandoffFenceController = {
      fence: ({ sessionId, operationId }) => {
        calls.push("fence");
        return { schemaVersion: 1, sessionId, operationId, epoch: 99, accepting: false, status: "fenced" };
      },
      awaitQuiescence: (fence) => {
        calls.push("quiescence");
        return {
          sessionId: fence.sessionId,
          operationId: fence.operationId,
          epoch: fence.epoch,
          status: "active",
          activeExecutionIds: ["injected-execution"],
          unknownExecutionIds: [],
        };
      },
    };
    const backend = new LocalSessionBackend({ resourceHandoffExecution: injected });
    const result = await backend.handoffResources(
      { cwd: fixture.repositoryPath },
      handoffOptions(fixture, "handoff-626-override"),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(calls, ["fence", "quiescence"]);
    assert.equal(result.value.status, "blocked");
    assert.equal(result.value.fenceEpoch, 99);
    assert.deepEqual(blockedExecutionIds(result.value), ["injected-execution"]);
    // The managed adapter was not used, so source admission is untouched.
    assert.equal(admission(fixture.registry, fixture.sourceId)?.admission, "open");
  } finally {
    fixture.cleanup();
  }
});

/** The producer reports retained execution IDs inside its bounded blocker reason. */
function blockedExecutionIds(result: ResourceHandoffResult): readonly string[] {
  const reason = result.blockers[0]?.reason ?? "";
  const match = /\((\{.*\})\)$/u.exec(reason);
  if (match === null) return [];
  return (JSON.parse(match[1] as string) as { executionIds: string[] }).executionIds;
}

function currentBootId(): string {
  return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
