import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
} from "./session-execution-record.js";
import { builtinWorktreeProfileRevision, pinWorktreeProfile } from "./worktree-profile-pinning.js";
import { resolveBuiltinWorktreeProfile } from "./worktree-profile-builtins.js";
import { collectRepositoryRuntimeLifecycleObservation } from "./repository-runtime-lifecycle-collector.js";
import type { RepositoryRuntimeLifecycleObservation } from "../repository-runtime-observations.js";
import {
  parseRepositoryRuntimeObservations,
  REPOSITORY_LIFECYCLE_OBSERVATION_V2,
} from "../repository-runtime-observations.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import { REGISTRY_FEATURES } from "../registry/runtime-records.js";
import { parkSession } from "../session-retention.js";
import { SessionRegistry, type RepositoryRegistryView, type SessionDiagnostic } from "../session-registry.js";
import type { CgroupFileSystem } from "./cgroups-v2.js";

const FIXED_TIME = new Date("2026-09-27T00:00:00.000Z");
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

test("projects real active lifecycle evidence through the existing v2 parser without mutation", () => {
  const fixture = createFixture();
  try {
    const sourceBefore = fixture.registry.readRepositoryView();
    const persistedBefore = fs.readFileSync(fixture.registry.paths.registry);
    const rootStatusBefore = runGit(["status", "--porcelain=v1"], fixture.repositoryPath);
    const worktreeStatusBefore = runGit(["status", "--porcelain=v1"], fixture.worktreePath);
    const worktreesBefore = runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath);
    let clockCalls = 0;

    const observation = collectRepositoryRuntimeLifecycleObservation(fixture.registry, {
      now: () => {
        clockCalls += 1;
        return new Date(FIXED_TIME);
      },
    });

    assert.equal(observation.status, "available");
    assert.equal(clockCalls, 1);
    if (observation.status !== "available") return;
    assert.equal(observation.observed_at, FIXED_TIME.toISOString());
    const value = observation.value as unknown as {
      readonly contract_id: string;
      readonly schema_version: number;
      readonly sessions: readonly RepositoryRuntimeLifecycleObservation[];
    };
    assert.equal(value.contract_id, REPOSITORY_LIFECYCLE_OBSERVATION_V2);
    assert.equal(value.schema_version, 2);
    assert.deepEqual(value.sessions, [
      {
        session_id: fixture.session.sessionId,
        state: "close-ready",
        physical_state: "present",
        recoverable_work: "absent",
        integration: "proven",
        cleanup: "unknown",
        reason: null,
      },
    ]);
    assertLifecycleParses(fixture.registry, observation);

    const sourceAfter = fixture.registry.readRepositoryView();
    assert.equal(sourceAfter.repositoryId, sourceBefore.repositoryId);
    assert.equal(sourceAfter.registryRevision, sourceBefore.registryRevision);
    assert.equal(sourceAfter.claimSetGeneration, sourceBefore.claimSetGeneration);
    assert.deepEqual(sourceAfter.sessions, sourceBefore.sessions);
    assert.deepEqual(fs.readFileSync(fixture.registry.paths.registry), persistedBefore);
    assert.equal(runGit(["status", "--porcelain=v1"], fixture.repositoryPath), rootStatusBefore);
    assert.equal(runGit(["status", "--porcelain=v1"], fixture.worktreePath), worktreeStatusBefore);
    assert.equal(runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath), worktreesBefore);
    assert.equal(fs.existsSync(fixture.worktreePath), true);
  } finally {
    fixture.cleanup();
  }
});

test("observes actual recoverable Git work and missing worktree state without applying either", () => {
  const fixture = createFixture();
  try {
    const revision = fixture.registry.readRepositoryView().registryRevision;
    const sourceBytes = fs.readFileSync(fixture.registry.paths.registry);
    fs.writeFileSync(path.join(fixture.worktreePath, "recoverable.txt"), "uncommitted evidence\n");
    const dirtyStatus = runGit(["status", "--porcelain=v1"], fixture.worktreePath);
    const dirty = collectRepositoryRuntimeLifecycleObservation(fixture.registry, { now: () => new Date(FIXED_TIME) });

    assert.equal(dirty.status, "available");
    if (dirty.status !== "available") return;
    const dirtyRow = row(dirty, fixture.session.sessionId);
    assert.equal(dirtyRow.physical_state, "present");
    assert.equal(dirtyRow.recoverable_work, "present");
    assert.equal(dirtyRow.reason, "DIRTY_WORKTREE");
    assert.equal(fixture.registry.readRepositoryView().registryRevision, revision);
    assert.deepEqual(fs.readFileSync(fixture.registry.paths.registry), sourceBytes);
    assert.equal(runGit(["status", "--porcelain=v1"], fixture.worktreePath), dirtyStatus);

    runGit(["add", "recoverable.txt"], fixture.worktreePath);
    runGit(["commit", "-m", "test: create recoverable lifecycle evidence"], fixture.worktreePath);
    const committedHead = runGit(["rev-parse", "HEAD"], fixture.worktreePath).trim();
    assert.notEqual(committedHead, fixture.session.baseRevision);
    const committedStatus = runGit(["status", "--porcelain=v1"], fixture.worktreePath);
    const unintegrated = collectRepositoryRuntimeLifecycleObservation(fixture.registry, {
      now: () => new Date(FIXED_TIME),
    });
    assert.equal(unintegrated.status, "available");
    if (unintegrated.status !== "available") return;
    const unintegratedRow = row(unintegrated, fixture.session.sessionId);
    assert.equal(unintegratedRow.recoverable_work, "present");
    assert.equal(unintegratedRow.integration, "unproven");
    assert.equal(unintegratedRow.reason, "RECOVERABLE_COMMITS");
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktreePath).trim(), committedHead);
    assert.equal(runGit(["status", "--porcelain=v1"], fixture.worktreePath), committedStatus);
    const worktreesBeforeMissingObservation = runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath);
    fs.rmSync(fixture.worktreePath, { recursive: true, force: true });
    const worktreesAfterRemoval = runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath);
    assert.notEqual(worktreesAfterRemoval, worktreesBeforeMissingObservation);

    const missing = collectRepositoryRuntimeLifecycleObservation(fixture.registry, { now: () => new Date(FIXED_TIME) });
    assert.equal(missing.status, "available");
    if (missing.status !== "available") return;
    const missingRow = row(missing, fixture.session.sessionId);
    assert.equal(missingRow.physical_state, "missing");
    assert.equal(missingRow.recoverable_work, "present");
    assert.equal(fixture.registry.readRepositoryView().registryRevision, revision);
    assert.deepEqual(fs.readFileSync(fixture.registry.paths.registry), sourceBytes);
    assert.equal(fs.existsSync(fixture.worktreePath), false);
    assert.equal(runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath), worktreesAfterRemoval);
    assert.equal(runGit(["status", "--porcelain=v1"], fixture.repositoryPath), "");
  } finally {
    fixture.cleanup();
  }
});

test("reobserves durable closed lifecycle state after registry restart", () => {
  const fixture = createFixture();
  try {
    fixture.registry.close({ sessionId: fixture.session.sessionId });
    const first = collectRepositoryRuntimeLifecycleObservation(fixture.registry, { now: () => new Date(FIXED_TIME) });
    const restarted = new SessionRegistry({ cwd: fixture.repositoryPath, clock: () => new Date(FIXED_TIME) });
    const second = collectRepositoryRuntimeLifecycleObservation(restarted, { now: () => new Date(FIXED_TIME) });

    assert.equal(first.status, "available");
    assert.equal(second.status, "available");
    if (first.status !== "available" || second.status !== "available") return;
    assert.deepEqual(first.value, second.value);
    const closed = row(first, fixture.session.sessionId);
    assert.equal(closed.state, "closed");
    assert.equal(closed.physical_state, null);
    assert.equal(closed.cleanup, "unknown");
  } finally {
    fixture.cleanup();
  }
});

test(
  "projects a canonically parked session after registry restart",
  { skip: fs.existsSync(BOOT_ID_PATH) ? false : "parking proof fixture requires Linux boot identity" },
  () => {
    const fixture = createParkedFixture();
    try {
      const first = collectRepositoryRuntimeLifecycleObservation(fixture.registry, { now: () => new Date(FIXED_TIME) });
      const restarted = new SessionRegistry({
        cwd: fixture.repositoryPath,
        cgroupFilesystem: emptyCgroupFilesystem(),
        clock: () => new Date(FIXED_TIME),
      });
      const second = collectRepositoryRuntimeLifecycleObservation(restarted, {
        now: () => new Date(FIXED_TIME),
      });

      assert.equal(first.status, "available");
      assert.equal(second.status, "available");
      if (first.status !== "available" || second.status !== "available") return;
      assert.deepEqual(first.value, second.value);
      const parked = row(first, fixture.sessionId);
      assert.equal(parked.state, "parked");
      assert.equal(parked.physical_state, "present");
      assert.equal(parked.recoverable_work, "absent");
      assert.equal(parked.cleanup, "unknown");
    } finally {
      fixture.cleanup();
    }
  },
);

test("mixed source identity and missing canonical evidence remain explicitly unknown", () => {
  const fixture = createFixture();
  try {
    const wrongIdentitySource = {
      readRepositoryView: () => fixture.registry.readRepositoryView(),
      diagnose: (sessionId: string): SessionDiagnostic => ({
        ...fixture.registry.diagnose(sessionId),
        repositoryId: "other-repository",
      }),
    };
    assert.equal(collectRepositoryRuntimeLifecycleObservation(wrongIdentitySource).status, "unknown");

    const noLifecycleSource = {
      readRepositoryView: () => fixture.registry.readRepositoryView(),
      diagnose: (sessionId: string): SessionDiagnostic => ({
        ...fixture.registry.diagnose(sessionId),
        lifecycle: undefined,
      }),
    };
    assert.deepEqual(collectRepositoryRuntimeLifecycleObservation(noLifecycleSource), {
      status: "unknown",
      observed_at: null,
      reason: "lifecycle evidence unavailable",
    });

    const unsupportedPhysicalSource = {
      readRepositoryView: () => fixture.registry.readRepositoryView(),
      diagnose: (sessionId: string): SessionDiagnostic => {
        const diagnostic = fixture.registry.diagnose(sessionId);
        return {
          ...diagnostic,
          physicalState: "future-physical-state",
          lifecycle:
            diagnostic.lifecycle === undefined
              ? undefined
              : { ...diagnostic.lifecycle, physicalState: "future-physical-state" },
        };
      },
    };
    assert.deepEqual(collectRepositoryRuntimeLifecycleObservation(unsupportedPhysicalSource), {
      status: "unknown",
      observed_at: null,
      reason: "lifecycle evidence unavailable",
    });
  } finally {
    fixture.cleanup();
  }
});

test("a real registry revision change during collection invalidates the mixed sample", () => {
  const fixture = createFixture();
  try {
    let changed = false;
    const source = {
      readRepositoryView: () => fixture.registry.readRepositoryView(),
      diagnose: (sessionId: string): SessionDiagnostic => {
        const diagnostic = fixture.registry.diagnose(sessionId);
        if (!changed) {
          changed = true;
          fixture.registry.claimResources({
            sessionId,
            claims: [{ resource: "README.md", mode: "write" }],
          });
        }
        return diagnostic;
      },
    };

    const observation = collectRepositoryRuntimeLifecycleObservation(source);
    assert.deepEqual(observation, {
      status: "unknown",
      observed_at: null,
      reason: "lifecycle source changed during collection",
    });
    assert.equal(changed, true);
  } finally {
    fixture.cleanup();
  }
});

test("an over-bound registry returns unknown without truncating or diagnosing a prefix", () => {
  const fixture = createFixture();
  try {
    const source = fixture.registry.readRepositoryView();
    const session = source.sessions[0];
    assert.ok(session);
    const sessions = Array.from({ length: 1_025 }, (_, index) => ({
      ...session,
      sessionId: `bounded-session-${index.toString().padStart(4, "0")}`,
    }));
    let diagnostics = 0;
    const overBound = {
      readRepositoryView: () => ({ ...source, sessions }),
      diagnose: (sessionId: string): SessionDiagnostic => {
        diagnostics += 1;
        return fixture.registry.diagnose(sessionId);
      },
    };

    assert.deepEqual(collectRepositoryRuntimeLifecycleObservation(overBound), {
      status: "unknown",
      observed_at: null,
      reason: "lifecycle source exceeded the session bound",
    });
    assert.equal(diagnostics, 0);
  } finally {
    fixture.cleanup();
  }
});

function createFixture(): {
  readonly repositoryPath: string;
  readonly worktreePath: string;
  readonly registry: SessionRegistry;
  readonly session: ReturnType<SessionRegistry["provision"]>;
  cleanup(): void;
} {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-lifecycle-"));
  const worktreePath = `${repositoryPath}-worktree`;
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "lifecycle collector test\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "test: seed lifecycle collector repository"], repositoryPath);

  const registry = new SessionRegistry({ cwd: repositoryPath, clock: () => new Date(FIXED_TIME) });
  const session = registry.provision({
    branchName: "feature/lifecycle-collector",
    worktreePath,
  });
  return {
    repositoryPath,
    worktreePath,
    registry,
    session,
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
      } catch {
        // The fixture may already have removed its physical worktree.
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function createParkedFixture(): {
  readonly repositoryPath: string;
  readonly sessionId: string;
  readonly registry: SessionRegistry;
  cleanup(): void;
} {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-lifecycle-parked-"));
  const worktreePath = `${repositoryPath}-worktree`;
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "parked lifecycle collector test\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "test: seed parked lifecycle collector repository"], repositoryPath);

  const registry = new SessionRegistry({
    cwd: repositoryPath,
    cgroupFilesystem: emptyCgroupFilesystem(),
    clock: () => new Date(FIXED_TIME),
  });
  const session = registry.provision({ branchName: "feature/lifecycle-parked", worktreePath });
  const baseRevision = session.baseRevision;
  if (baseRevision === undefined) throw new Error("Parked fixture session is missing its base revision");
  const builtin = resolveBuiltinWorktreeProfile({ profile: "minimal" });
  if (!builtin.ok) throw builtin.error;
  const pinnedProfile = pinWorktreeProfile(builtin.value, {
    repository: { id: registry.repository.repositoryId, revision: baseRevision },
    base: { revision: baseRevision },
    catalog: {
      kind: "builtin",
      id: "minimal",
      revision: builtinWorktreeProfileRevision("minimal"),
    },
    selection: { profile: "minimal", parameters: {} },
  });

  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const currentFeatures = Array.isArray(persisted.required_features)
    ? persisted.required_features.filter((value): value is string => typeof value === "string")
    : [];
  const required = new Set([...currentFeatures, "pinned-profiles.v1", "runtime-sessions.v1"]);
  persisted.required_features = REGISTRY_FEATURES.filter((feature) => required.has(feature));
  persisted.pinned_profiles = [{ ...pinnedProfile, session_id: session.sessionId }];
  const runtimeEpoch = persisted.runtime_epoch;
  persisted.runtime_sessions = [
    {
      kind: "session-admission",
      schema_version: 1,
      session_id: session.sessionId,
      admission: "open",
      runtime_epoch: runtimeEpoch,
    },
  ];
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted, null, 2)}\n`);
  seedExitedExecution(registry, session.sessionId, pinnedProfile.digest);
  const result = parkSession(registry, {
    sessionId: session.sessionId,
    pinnedProfile,
    operationId: "lifecycle-observation-park",
    now: FIXED_TIME.toISOString(),
  });
  assert.equal(result.status, "parked");

  return {
    repositoryPath,
    sessionId: session.sessionId,
    registry,
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
      } catch {
        // The fixture cleanup below removes remaining temporary files.
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function seedExitedExecution(registry: SessionRegistry, sessionId: string, profileDigest: string): void {
  const runtime = registry.getSessionManagedRuntime(sessionId);
  const reserved = reserveExecution({
    session_id: sessionId,
    execution_id: "lifecycle-observation-drained-execution",
    cgroup_root: "/sys/fs/cgroup/user.slice/nawabari-lifecycle-observation-test.scope",
    profile_digest: profileDigest,
    filesystem_token: "a".repeat(64),
    runtime_epoch: runtime.runtime_epoch,
    boot_id: fs.readFileSync(BOOT_ID_PATH, "utf8").trim(),
    now: FIXED_TIME.toISOString(),
  });
  if (!reserved.ok) throw reserved.error;
  registry.persistSessionExecution(toPersistedSessionExecutionRecord(reserved.value));
  const exited = recordExecutionState(reserved.value, {
    state: "exited",
    now: new Date(FIXED_TIME.getTime() + 1_000).toISOString(),
  });
  if (!exited.ok) throw exited.error;
  registry.transitionSessionExecution(
    exited.value.execution_id,
    { state: "exited", now: exited.value.updated_at },
    toPersistedSessionExecutionRecord(exited.value),
  );
}

function emptyCgroupFilesystem(): CgroupFileSystem {
  return {
    statSync: () => ({ isDirectory: () => true, isFile: () => true }),
    realpathSync: (file) => file,
    readFileSync: (file) => {
      if (file.endsWith("cgroup.events")) return "populated 0\n";
      if (file.endsWith("cgroup.procs")) return "";
      return "0\n";
    },
    writeFileSync: () => undefined,
    mkdirSync: () => undefined,
    rmdirSync: () => undefined,
  };
}

function assertLifecycleParses(
  registry: SessionRegistry,
  lifecycle: ReturnType<typeof collectRepositoryRuntimeLifecycleObservation>,
): void {
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    registry: registry.readRepositoryView(),
    captured_at: FIXED_TIME.toISOString(),
    lifecycle,
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const parsed = parseRepositoryRuntimeObservations(snapshot.value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.lifecycle_unknown, false);
}

function row(
  observation: Extract<ReturnType<typeof collectRepositoryRuntimeLifecycleObservation>, { status: "available" }>,
  sessionId: string,
): RepositoryRuntimeLifecycleObservation {
  const value = observation.value as unknown as {
    readonly sessions: readonly RepositoryRuntimeLifecycleObservation[];
  };
  const selected = value.sessions.find((candidate) => candidate.session_id === sessionId);
  assert.ok(selected, `missing lifecycle row for ${sessionId}`);
  return selected;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}
