import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseRepositoryRuntimeObservations } from "../repository-runtime-observations.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import type { CgroupFileSystem } from "./cgroups-v2.js";
import { reserveExecution, toPersistedSessionExecutionRecord } from "./session-execution-record.js";
import {
  collectRepositoryRuntimeProcessObservation,
  type RepositoryRuntimeProcessCollectorOptions,
} from "./repository-runtime-process-collector.js";
import { defaultGit, type GitCommandRunner } from "../git.js";
import { SessionRegistry } from "../session-registry.js";

const BOOT_ID = "process-collector-test-boot";
const CGROUP_ROOT = "/sys/fs/cgroup/nawabari-test-root";
const CAPTURED_AT = new Date("2026-09-27T04:05:06.000Z");

type Population = "populated" | "empty" | "unavailable";

class ControlledCgroupFileSystem implements CgroupFileSystem {
  population: Population = "populated";
  writes = 0;
  mkdirs = 0;
  removals = 0;
  onRead: ((file: string) => void) | undefined;

  statSync(): { readonly isDirectory: () => boolean; readonly isFile: () => boolean } {
    return { isDirectory: () => true, isFile: () => true };
  }

  realpathSync(file: string): string {
    return file;
  }

  readFileSync(file: string): string {
    this.onRead?.(file);
    if (file.endsWith("cgroup.events")) {
      if (this.population === "unavailable") throw new Error("cgroup events unavailable");
      return this.population === "populated" ? "populated 1\n" : "populated 0\n";
    }
    if (file.endsWith("cgroup.procs")) {
      if (this.population === "unavailable") throw new Error("cgroup process list unavailable");
      return this.population === "populated" ? "4321\n" : "";
    }
    return "";
  }

  writeFileSync(): void {
    this.writes += 1;
    throw new Error("observation attempted a cgroup write");
  }

  mkdirSync(): void {
    this.mkdirs += 1;
    throw new Error("observation attempted cgroup creation");
  }

  rmdirSync(): void {
    this.removals += 1;
    throw new Error("observation attempted cgroup removal");
  }
}

interface RegistryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  readonly registry: SessionRegistry;
  gitCalls(): number;
  cleanup(): void;
}

function createRegistryFixture(filesystem = new ControlledCgroupFileSystem()): RegistryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-process-collector-"));
  const linkedWorktreePath = `${repositoryPath}-linked`;
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  runGit(["worktree", "add", "-b", "feature/linked", linkedWorktreePath], repositoryPath);

  let calls = 0;
  const git: GitCommandRunner = {
    run(args, cwd) {
      calls += 1;
      return defaultGit.run(args, cwd);
    },
    runRaw(args, cwd) {
      calls += 1;
      return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
    },
    runBuffer(args, cwd) {
      calls += 1;
      return defaultGit.runBuffer?.(args, cwd) ?? Buffer.from(defaultGit.run(args, cwd));
    },
  };
  const registry = new SessionRegistry({ cwd: repositoryPath, git, cgroupFilesystem: filesystem });
  return {
    repositoryPath,
    linkedWorktreePath,
    registry,
    gitCalls: () => calls,
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", linkedWorktreePath], repositoryPath);
      } catch {
        // Remove the directory below if Git no longer tracks the worktree.
      }
      fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
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

function createSession(
  registry: SessionRegistry,
  worktreePath = registry.repository.worktreePath,
  branchName = "main",
) {
  return registry.create({ worktreePath, branchName });
}

function openAdmissions(registry: SessionRegistry, sessionIds: readonly string[]): void {
  const document = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const runtimeEpoch = registry.runtimeEpoch;
  const requiredFeatures = new Set((document.required_features as string[] | undefined) ?? []);
  requiredFeatures.add("runtime-sessions.v1");
  document.required_features = [...requiredFeatures];
  document.runtime_sessions = sessionIds.map((session_id) => ({
    kind: "session-admission",
    schema_version: 1,
    session_id,
    admission: "open",
    runtime_epoch: runtimeEpoch,
  }));
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(document, null, 2)}\n`);
}

function persistExecution(
  registry: SessionRegistry,
  sessionId: string,
  executionId: string,
  cgroupRoot: string | null = CGROUP_ROOT,
): void {
  const record = reserveExecution({
    session_id: sessionId,
    execution_id: executionId,
    profile_digest: "a".repeat(64),
    filesystem_token: "b".repeat(64),
    runtime_epoch: registry.runtimeEpoch,
    boot_id: BOOT_ID,
    ...(cgroupRoot === null ? {} : { cgroup_root: cgroupRoot }),
    now: "2026-09-27T04:05:00.000Z",
  });
  if (!record.ok) throw record.error;
  registry.persistSessionExecution(toPersistedSessionExecutionRecord(record.value));
}

function collectOptions(
  now: () => Date = () => new Date(CAPTURED_AT),
  readBootId: () => string = () => BOOT_ID,
): RepositoryRuntimeProcessCollectorOptions {
  return { now, readBootId };
}

function processIndexes(
  registry: SessionRegistry,
  observation: ReturnType<typeof collectRepositoryRuntimeProcessObservation>,
) {
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    registry: registry.readRepositoryView(),
    captured_at: CAPTURED_AT.toISOString(),
    processes: observation,
  });
  if (!snapshot.ok) throw snapshot.error;
  const parsed = parseRepositoryRuntimeObservations(snapshot.value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

test("physical cgroup population changes the parser-accepted observation at an unchanged registry revision", () => {
  const cgroups = new ControlledCgroupFileSystem();
  const fixture = createRegistryFixture(cgroups);
  try {
    const session = createSession(fixture.registry);
    openAdmissions(fixture.registry, [session.sessionId]);
    persistExecution(fixture.registry, session.sessionId, "execution-population-change");

    const registryRevision = fixture.registry.readRepositoryView().registryRevision;
    const registryBytes = fs.readFileSync(fixture.registry.paths.registry, "utf8");
    const gitCalls = fixture.gitCalls();
    let capturedAt = new Date(CAPTURED_AT);
    const now = () => new Date(capturedAt);

    const active = collectRepositoryRuntimeProcessObservation(fixture.registry, collectOptions(now));
    assert.equal(active.status, "available");
    if (active.status !== "available") return;
    assert.equal(active.observed_at, CAPTURED_AT.toISOString());
    assert.equal(processIndexes(fixture.registry, active).processes.get(session.sessionId)?.status, "active");

    cgroups.population = "empty";
    capturedAt = new Date("2026-09-27T04:05:07.000Z");
    const inactive = collectRepositoryRuntimeProcessObservation(fixture.registry, collectOptions(now));
    assert.equal(inactive.status, "available");
    if (inactive.status !== "available") return;
    assert.equal(inactive.observed_at, capturedAt.toISOString());
    assert.equal(processIndexes(fixture.registry, inactive).processes.get(session.sessionId)?.status, "inactive");

    assert.equal(fixture.registry.readRepositoryView().registryRevision, registryRevision);
    assert.equal(fs.readFileSync(fixture.registry.paths.registry, "utf8"), registryBytes);
    assert.equal(fixture.gitCalls(), gitCalls);
    assert.equal(cgroups.writes, 0);
    assert.equal(cgroups.mkdirs, 0);
    assert.equal(cgroups.removals, 0);
  } finally {
    fixture.cleanup();
  }
});

test("missing execution records and cgroup leases remain unknown rather than inactive", () => {
  const cgroups = new ControlledCgroupFileSystem();
  const fixture = createRegistryFixture(cgroups);
  try {
    const missingRecordSession = createSession(fixture.registry);
    const missingLeaseSession = createSession(fixture.registry, fixture.linkedWorktreePath, "feature/linked");
    openAdmissions(fixture.registry, [missingRecordSession.sessionId, missingLeaseSession.sessionId]);
    persistExecution(fixture.registry, missingLeaseSession.sessionId, "execution-without-lease", null);

    const observation = collectRepositoryRuntimeProcessObservation(fixture.registry, collectOptions());
    assert.equal(observation.status, "available");
    const processes = processIndexes(fixture.registry, observation).processes;
    assert.equal(processes.get(missingRecordSession.sessionId)?.status, "unknown");
    assert.equal(processes.get(missingLeaseSession.sessionId)?.status, "unknown");
    assert.equal(cgroups.writes, 0);
    assert.equal(cgroups.mkdirs, 0);
    assert.equal(cgroups.removals, 0);
  } finally {
    fixture.cleanup();
  }
});

test("unavailable boot or cgroup observations remain unknown", () => {
  const cgroups = new ControlledCgroupFileSystem();
  const fixture = createRegistryFixture(cgroups);
  try {
    const session = createSession(fixture.registry);
    openAdmissions(fixture.registry, [session.sessionId]);
    persistExecution(fixture.registry, session.sessionId, "execution-unavailable-source");

    const unavailableBoot = collectRepositoryRuntimeProcessObservation(
      fixture.registry,
      collectOptions(
        () => new Date(CAPTURED_AT),
        () => {
          throw new Error("boot identity unavailable");
        },
      ),
    );
    assert.equal(unavailableBoot.status, "unknown");
    assert.equal(processIndexes(fixture.registry, unavailableBoot).processes_unknown, true);

    cgroups.population = "unavailable";
    const unavailableCgroup = collectRepositoryRuntimeProcessObservation(fixture.registry, collectOptions());
    assert.equal(unavailableCgroup.status, "available");
    assert.equal(
      processIndexes(fixture.registry, unavailableCgroup).processes.get(session.sessionId)?.status,
      "unknown",
    );
    assert.equal(cgroups.writes, 0);
    assert.equal(cgroups.mkdirs, 0);
    assert.equal(cgroups.removals, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a registry source change during collection invalidates the composed process observation", () => {
  const cgroups = new ControlledCgroupFileSystem();
  const fixture = createRegistryFixture(cgroups);
  try {
    const session = createSession(fixture.registry);
    openAdmissions(fixture.registry, [session.sessionId]);
    persistExecution(fixture.registry, session.sessionId, "execution-registry-change");

    let changed = false;
    cgroups.onRead = (file) => {
      if (!changed && file.endsWith("cgroup.events")) {
        changed = true;
        fixture.registry.closeSessionLaunchAdmission(session.sessionId, fixture.registry.runtimeEpoch);
      }
    };
    const observation = collectRepositoryRuntimeProcessObservation(fixture.registry, collectOptions());
    assert.equal(changed, true);
    assert.equal(observation.status, "unknown");
    assert.equal(processIndexes(fixture.registry, observation).processes_unknown, true);
    assert.equal(cgroups.writes, 0);
    assert.equal(cgroups.mkdirs, 0);
    assert.equal(cgroups.removals, 0);
  } finally {
    fixture.cleanup();
  }
});

test("session bounds produce an unknown section before partial collection", () => {
  const fixture = createRegistryFixture();
  try {
    const session = createSession(fixture.registry);
    const view = fixture.registry.readRepositoryView();
    const template = view.sessions[0] ?? session;
    const oversizedView = {
      ...view,
      sessions: Array.from({ length: 1_025 }, (_, index) => ({ ...template, sessionId: `bounded-session-${index}` })),
    };
    const boundedRegistry = {
      readRepositoryView: () => oversizedView,
      listSessionExecutions: () => {
        throw new Error("bounded observations must not be sampled partially");
      },
      cgroupObservationFilesystem: undefined,
    } as unknown as SessionRegistry;

    const observation = collectRepositoryRuntimeProcessObservation(boundedRegistry, collectOptions());
    assert.equal(observation.status, "unknown");
    assert.match(observation.reason, /session bound/u);
  } finally {
    fixture.cleanup();
  }
});
