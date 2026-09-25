import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
} from "./domain/session-execution-record.js";
import { SESSION_EXECUTION_CONTROL_CONTRACT_ID } from "./domain/session-execution-control.js";
import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import { resolveRepositoryContext } from "./git.js";
import { RepositoryLock } from "./registry/lock.js";
import { DomainError } from "./domain/errors.js";
import { sandboxDoctorReport, type SandboxProbe } from "./domain/sandbox.js";
import {
  SessionRegistry,
  toPersistedSessionRecord,
  type ManagedExecutionReadinessRequest,
  type PersistedRegistry,
} from "./session-registry.js";
import { withDirectoryFsyncFailure, withRegistryTempFileFsyncFailure } from "./testing/fs-fault-injection.js";

test("round-trips session metadata through common Git state", () => {
  const fixture = createRepositoryFixture();
  try {
    const clock = () => new Date("2026-01-02T03:04:05.006Z");
    const mainRegistry = new SessionRegistry({ cwd: fixture.repositoryPath, clock });
    const linkedRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath, clock });

    const mainSession = mainRegistry.create({ label: "same human label" });
    const linkedSession = linkedRegistry.create({ label: "same human label" });

    assert.equal(mainSession.schemaVersion, 1);
    assert.equal(mainSession.state, "active");
    assert.equal(mainSession.repositoryId, mainRegistry.repository.repositoryId);
    assert.equal(mainSession.worktreePath, fixture.repositoryPath);
    assert.equal(mainSession.worktreeId, mainSession.worktreePath);
    assert.equal(mainSession.branchId, "refs/heads/main");
    assert.equal(mainSession.branchName, "main");
    assert.equal(mainSession.createdAt, "2026-01-02T03:04:05.006Z");
    assert.equal(mainSession.updatedAt, mainSession.createdAt);
    assert.equal(linkedSession.branchId, "refs/heads/feature/linked");

    assert.equal(mainRegistry.paths.registry, linkedRegistry.paths.registry);
    assert.deepEqual(
      mainRegistry.list().map((record) => record.sessionId),
      [mainSession.sessionId, linkedSession.sessionId],
    );
    assert.equal(linkedRegistry.resolveCurrentSession().sessionId, linkedSession.sessionId);
    assert.equal(mainRegistry.get(mainSession.sessionId)?.label, "same human label");

    const persisted = readJson(mainRegistry.paths.registry) as PersistedRegistry;
    assert.equal(persisted.schema_version, 2);
    assert.equal(persisted.registry_revision, 2);
    assert.equal(persisted.runtime_epoch, 2);
    assert.deepEqual(persisted.required_features, []);
    assert.equal(persisted.repository_id, mainRegistry.repository.repositoryId);
    assert.equal(persisted.sessions.length, 2);
    assert.equal(persisted.sessions[0].session_id, mainSession.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("expands a governed working set atomically with revision CAS and claim checks", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-expansion");
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);
    const identity = {
      repositoryHost: "github.com",
      repositoryId: "1329799765",
      repository: "yohn-jp/nawabari",
    };
    assert.notEqual(identity.repositoryId, repository.repositoryId);
    const executionScope = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 376 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: {
        readOnly: ["README.md", "src/**"],
        write: ["src/new.ts"],
        create: [],
        delete: [],
        deny: ["src/secret.ts"],
      },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-376",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:bootstrap", summary: "bounded fixture" },
          evidence: [],
        },
      ],
    };
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/expansion",
      executionScope,
      candidateWorkingSet,
      initialClaims: [{ resource: "src/new.ts", mode: "write" }],
    });
    const expandedRead = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 1,
      executionScope,
      entries: [{ path: "src/new.ts", operation: "READONLY", reason: "legitimate read context" }],
    });
    assert.equal(expandedRead.status, "granted");
    assert.equal(expandedRead.revision, 2);
    assert.ok(expandedRead.workingSet.scope.readOnly.includes("src/new.ts"));

    const deniedMutation = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 2,
      executionScope,
      entries: [{ path: "src/other.ts", operation: "WRITE", reason: "outside authorized write scope" }],
    });
    assert.equal(deniedMutation.status, "denied");
    assert.equal(deniedMutation.outcomes[0]?.status, "denied");
    assert.equal(deniedMutation.revision, 2);
    assert.equal(registry.get(session.sessionId)?.workingSet?.revision, 2);

    assertRegistryError(
      () =>
        registry.expandWorkingSet({
          sessionId: session.sessionId,
          repository: { ...identity, repositoryId: "987654321" },
          currentRevision: 2,
          executionScope,
          entries: [{ path: "src/new.ts", operation: "READONLY", reason: "foreign repository" }],
        }),
      "REPOSITORY_MISMATCH",
    );
    assert.equal(registry.get(session.sessionId)?.workingSet?.revision, 2);

    const expandedMutation = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 2,
      executionScope,
      entries: [{ path: "src/new.ts", operation: "WRITE", reason: "authorized mutation context" }],
    });
    assert.equal(expandedMutation.status, "granted");
    assert.equal(expandedMutation.revision, 3);
    assert.deepEqual(expandedMutation.workingSet.scope.write, ["src/new.ts"]);

    assertRegistryError(
      () =>
        registry.expandWorkingSet({
          sessionId: session.sessionId,
          repository: identity,
          currentRevision: 2,
          executionScope,
          entries: [{ path: "src/other.ts", operation: "READONLY", reason: "stale" }],
        }),
      "STALE_REGISTRY",
    );
    const denied = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 3,
      executionScope,
      entries: [{ path: "src/secret.ts", operation: "READONLY", reason: "denied" }],
    });
    assert.equal(denied.status, "denied");
    assert.equal(denied.revision, 3);
    assert.equal(registry.get(session.sessionId)?.workingSet?.revision, 3);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    fixture.cleanup();
  }
});

test("keeps human labels separate from session identity", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "worker" });
    const second = registry.create({
      worktreePath: fixture.linkedWorktreePath,
      branchName: "feature/linked",
      label: "worker",
    });

    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(first.label, second.label);
    assert.equal(registry.list().length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("resource-claim enforcement defaults to disabled and persists an explicit opt-in across registry instances", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const claimLessWorktree = `${fixture.repositoryPath}-claim-less`;
    const enforcedWorktree = `${fixture.repositoryPath}-claim-enforced`;
    try {
      const claimLess = registry.provision({ worktreePath: claimLessWorktree, branchName: "feature/claim-less" });
      assert.equal(claimLess.claimEnforcement, undefined);

      const enforced = registry.provision({
        worktreePath: enforcedWorktree,
        branchName: "feature/claim-enforced",
        claimEnforcement: true,
      });
      assert.equal(enforced.claimEnforcement, true);

      const reopened = new SessionRegistry({ cwd: fixture.repositoryPath });
      assert.equal(reopened.get(claimLess.sessionId)?.claimEnforcement, undefined);
      assert.equal(reopened.get(enforced.sessionId)?.claimEnforcement, true);
    } finally {
      for (const worktreePath of [claimLessWorktree, enforcedWorktree]) {
        try {
          runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
        } catch {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test("rejects an empty label before writing unreadable registry state", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assertRegistryError(() => registry.create({ label: "" }), "INVALID_SESSION_RECORD");
    assert.deepEqual(registry.list(), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an empty label through register before writing unreadable registry state", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = makeDirectory("nawabari-register-label-");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const candidate = {
      ...session,
      sessionId: "01936f5e-7b00-7abc-8def-0123456789ab",
      worktreeId: worktreePath,
      worktreePath,
      branchId: "refs/heads/feature/register-label",
      branchName: "feature/register-label",
      label: "",
    };

    assertRegistryError(() => registry.register(candidate), "INVALID_SESSION_RECORD");
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.label, undefined);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("rejects duplicate worktree, branch, and session ownership", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "first" });

    assertRegistryError(() => registry.create({ branchName: "feature/other" }), "BRANCH_MISMATCH");
    const second = registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/linked" });
    assertRegistryError(
      () => registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/other" }),
      "BRANCH_MISMATCH",
    );
    assertRegistryError(
      () => registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/linked" }),
      "DUPLICATE_WORKTREE_OWNERSHIP",
    );

    const duplicateIdRegistry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      idGenerator: () => first.sessionId,
    });
    assertRegistryError(
      () => duplicateIdRegistry.create({ worktreePath: fixture.repositoryPath, branchName: "main" }),
      "SESSION_ID_COLLISION",
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for corrupt, unsupported, and repository-mismatched state", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    fs.mkdirSync(registry.paths.directory, { recursive: true });

    fs.writeFileSync(registry.paths.registry, "{not json\n");
    assertRegistryError(() => registry.list(), "REGISTRY_CORRUPT");

    writeRegistry(registry, {
      schema_version: 999,
      repository_id: registry.repository.repositoryId,
      sessions: [],
    } as unknown as PersistedRegistry);
    assertRegistryError(() => registry.list(), "UNSUPPORTED_SCHEMA_VERSION");

    writeRegistry(registry, {
      schema_version: 1 as const,
      repository_id: path.join(registry.repository.commonGitDirectory, "different-repository"),
      sessions: [],
    });
    assertRegistryError(() => registry.list(), "REGISTRY_REPOSITORY_MISMATCH");
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when persisted records contain duplicate ownership", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "first" });
    const persisted = toPersistedSessionRecord(first);
    writeRegistry(registry, {
      schema_version: 1 as const,
      repository_id: registry.repository.repositoryId,
      sessions: [persisted, { ...persisted, session_id: "01936f5e-7b00-7abc-8def-0123456789ab" }],
    });

    assertRegistryError(() => registry.list(), "DUPLICATE_WORKTREE_OWNERSHIP");
  } finally {
    fixture.cleanup();
  }
});

test("migrates a legacy registry without changing session ownership or claim mode", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const claim = registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "write" }],
    }).claims[0];
    assert.ok(claim);

    const legacy = readJson(registry.paths.registry) as Record<string, unknown>;
    legacy.schema_version = 1;
    delete legacy.registry_revision;
    delete legacy.runtime_epoch;
    delete legacy.required_features;
    delete legacy.runtime_sessions;
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(legacy)}\n`);

    const result = registry.migrate();
    assert.equal(result.migrated, true);
    const migrated = readJson(registry.paths.registry) as PersistedRegistry;
    assert.equal(migrated.schema_version, 2);
    assert.equal(migrated.claims_schema_version, 2);
    assert.equal(migrated.sessions[0]?.session_id, session.sessionId);
    assert.equal((migrated.claims?.[0] as { mode?: string } | undefined)?.mode, "write");
    assert.equal(registry.listClaims()[0]?.sessionId, session.sessionId);
    assert.equal(registry.listClaims()[0]?.mode, "write");
  } finally {
    fixture.cleanup();
  }
});

test("managed close, discard, and claim release reject direct calls without drain finalization", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "write" }] });
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const epoch = Number(base.runtime_epoch);
    writeRegistry(registry, {
      ...base,
      required_features: ["runtime-sessions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: session.sessionId,
          admission: "open",
          runtime_epoch: epoch,
        },
      ],
    } as unknown as PersistedRegistry);

    const managed = new SessionRegistry({ cwd: fixture.repositoryPath });
    assertRegistryError(() => managed.close(session.sessionId), "OPERATION_REJECTED");
    assertRegistryError(() => managed.discard(session.sessionId), "OPERATION_REJECTED");
    assertRegistryError(
      () => managed.releaseClaims({ sessionId: session.sessionId, all: true, force: true }),
      "OPERATION_REJECTED",
    );
    assert.equal(managed.get(session.sessionId)?.state, "active");
    assert.equal(managed.listClaims(session.sessionId).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("epoch writes preserve closed gates and reject stale execution reservations", () => {
  const fixture = createRepositoryFixture();
  const extraWorktreePath = `${fixture.repositoryPath}-epoch-trigger`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const openSession = registry.create({ worktreePath: fixture.repositoryPath, branchName: "main" });
    const closedSession = registry.create({
      worktreePath: fixture.linkedWorktreePath,
      branchName: "feature/linked",
    });
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const epoch = Number(base.runtime_epoch);
    writeRegistry(registry, {
      ...base,
      required_features: ["runtime-sessions.v1", "executions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: openSession.sessionId,
          admission: "open",
          runtime_epoch: epoch,
        },
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: closedSession.sessionId,
          admission: "closed",
          runtime_epoch: epoch,
        },
      ],
      executions: [],
    } as unknown as PersistedRegistry);

    const stale = reserveExecution({
      session_id: openSession.sessionId,
      execution_id: "stale-after-epoch-write",
      profile_digest: "a".repeat(64),
      filesystem_token: "b".repeat(64),
      runtime_epoch: epoch,
      boot_id: "epoch-write-boot",
      now: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(stale.ok, true);
    if (!stale.ok) return;

    runGit(["worktree", "add", "-b", "feature/epoch-trigger", extraWorktreePath], fixture.repositoryPath);
    registry.create({ worktreePath: extraWorktreePath, branchName: "feature/epoch-trigger" });
    const advanced = registry.runtimeEpoch;
    const openAdmission = registry.getSessionManagedRuntime(openSession.sessionId).admission;
    const closedAdmission = registry.getSessionManagedRuntime(closedSession.sessionId).admission;
    assert.equal(openAdmission?.admission, "open");
    assert.equal(openAdmission?.runtime_epoch, advanced);
    assert.equal(closedAdmission?.admission, "closed");
    assert.equal(closedAdmission?.runtime_epoch, epoch);
    assert.throws(
      () => registry.persistSessionExecution(toPersistedSessionExecutionRecord(stale.value)),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        error.message.includes("Session launch admission is not open at the current epoch"),
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", extraWorktreePath], fixture.repositoryPath);
    } catch {
      // Remove the directory below when Git did not register the worktree.
    }
    fs.rmSync(extraWorktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("managed finalization treats a tracked admission with no execution records as unknown", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const admissionEpoch = Number(base.runtime_epoch) + 1;
    writeRegistry(registry, {
      ...base,
      runtime_epoch: admissionEpoch,
      required_features: ["runtime-sessions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: session.sessionId,
          admission: "closed",
          runtime_epoch: admissionEpoch,
        },
      ],
    } as unknown as PersistedRegistry);

    const finalization = {
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: 1 as const,
      session_id: session.sessionId,
      fence_id: "test-fence",
      operation: "close" as const,
      expected_epoch: admissionEpoch - 1,
      admission_epoch: admissionEpoch,
      admission: "closed" as const,
      status: "ready" as const,
      next_action: "finalize-lifecycle" as const,
    };
    assert.throws(
      () => new SessionRegistry({ cwd: fixture.repositoryPath }).close(session.sessionId, finalization),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        error.message.includes("No owned execution records are available"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("managed finalization rejects a stale locked admission epoch", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const currentAdmissionEpoch = Number(base.runtime_epoch) + 2;
    writeRegistry(registry, {
      ...base,
      runtime_epoch: currentAdmissionEpoch,
      required_features: ["runtime-sessions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: session.sessionId,
          admission: "closed",
          runtime_epoch: currentAdmissionEpoch,
        },
      ],
    } as unknown as PersistedRegistry);

    const finalization = {
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: 1 as const,
      session_id: session.sessionId,
      fence_id: "stale-fence",
      operation: "close" as const,
      expected_epoch: currentAdmissionEpoch - 2,
      admission_epoch: currentAdmissionEpoch - 1,
      admission: "closed" as const,
      status: "ready" as const,
      next_action: "finalize-lifecycle" as const,
    };
    assert.throws(
      () => new SessionRegistry({ cwd: fixture.repositoryPath }).close(session.sessionId, finalization),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        error.message.includes("Runtime drain admission fence is stale"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("managed finalization reobserves owned cgroup occupancy under the registry lock", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const starting = reserveExecution({
      session_id: session.sessionId,
      execution_id: "locked-finalization-check",
      profile_digest: "a".repeat(64),
      filesystem_token: "b".repeat(64),
      runtime_epoch: registry.runtimeEpoch,
      boot_id: bootId,
      now: "2026-01-02T03:04:05.006Z",
    });
    assert.equal(starting.ok, true);
    if (!starting.ok) return;
    const terminal = recordExecutionState(starting.value, {
      state: "exited",
      now: "2026-01-02T03:04:06.006Z",
    });
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const admissionEpoch = Number(base.runtime_epoch) + 1;
    writeRegistry(registry, {
      ...base,
      runtime_epoch: admissionEpoch,
      required_features: ["runtime-sessions.v1", "executions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: session.sessionId,
          admission: "closed",
          runtime_epoch: admissionEpoch,
        },
      ],
      executions: [toPersistedSessionExecutionRecord(terminal.value)],
    } as unknown as PersistedRegistry);

    const populatedFilesystem = {
      statSync: () => ({ isDirectory: () => true, isFile: () => true }),
      realpathSync: (file: string) => file,
      readFileSync: (file: string) => {
        if (file.endsWith("cgroup.events")) return "populated 1\n";
        if (file.endsWith("cgroup.procs")) return "";
        throw new Error("unobserved cgroup file");
      },
      writeFileSync: () => undefined,
      mkdirSync: () => undefined,
      rmdirSync: () => undefined,
    } as unknown as CgroupFileSystem;
    const managed = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: populatedFilesystem });
    const finalization = {
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: 1 as const,
      session_id: session.sessionId,
      fence_id: "test-fence",
      operation: "close" as const,
      expected_epoch: admissionEpoch - 1,
      admission_epoch: admissionEpoch,
      admission: "closed" as const,
      status: "ready" as const,
      next_action: "finalize-lifecycle" as const,
    };
    assert.throws(
      () => managed.close(session.sessionId, finalization),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "OPERATION_REJECTED" &&
        error.message.includes("Owned execution scope is not proven empty") &&
        error.details.population === "populated",
    );
    assert.equal(managed.get(session.sessionId)?.state, "active");
  } finally {
    fixture.cleanup();
  }
});

test("claim release reopens managed admission only after locked empty-scope proof", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "write" }] });
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const base = readJson(registry.paths.registry) as Record<string, unknown>;
    const epoch = Number(base.runtime_epoch);
    writeRegistry(registry, {
      ...base,
      required_features: ["runtime-sessions.v1", "executions.v1"],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: session.sessionId,
          admission: "open",
          runtime_epoch: epoch,
        },
      ],
      executions: [],
    } as unknown as PersistedRegistry);

    const starting = reserveExecution({
      session_id: session.sessionId,
      execution_id: "claim-release-finalization",
      profile_digest: "a".repeat(64),
      filesystem_token: "b".repeat(64),
      runtime_epoch: epoch,
      boot_id: bootId,
      now: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(starting.ok, true);
    if (!starting.ok) return;
    registry.persistSessionExecution(toPersistedSessionExecutionRecord(starting.value));
    const terminal = recordExecutionState(starting.value, {
      state: "exited",
      now: "2026-09-22T00:00:01.000Z",
    });
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    registry.transitionSessionExecution(
      terminal.value.execution_id,
      { state: "exited", now: terminal.value.updated_at },
      toPersistedSessionExecutionRecord(terminal.value),
    );
    const closed = registry.closeSessionLaunchAdmission(session.sessionId, epoch);

    const emptyFilesystem = {
      statSync: () => ({ isDirectory: () => true, isFile: () => true }),
      realpathSync: (file: string) => file,
      readFileSync: (file: string) => {
        if (file.endsWith("cgroup.events")) return "populated 0\n";
        if (file.endsWith("cgroup.procs")) return "";
        throw new Error("unobserved cgroup file");
      },
      writeFileSync: () => undefined,
      mkdirSync: () => undefined,
      rmdirSync: () => undefined,
    } as unknown as CgroupFileSystem;
    const managed = new SessionRegistry({ cwd: fixture.repositoryPath, cgroupFilesystem: emptyFilesystem });
    const finalization = {
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: 1 as const,
      session_id: session.sessionId,
      fence_id: "claim-release-fence",
      operation: "release-claims" as const,
      expected_epoch: epoch,
      admission_epoch: closed.runtimeEpoch,
      admission: "closed" as const,
      status: "ready" as const,
      next_action: "finalize-lifecycle" as const,
    };
    const released = managed.releaseClaims(
      { sessionId: session.sessionId, all: true, force: true },
      undefined,
      finalization,
    );
    assert.equal(released.released.length, 1);
    assert.equal(managed.listClaims(session.sessionId).length, 0);
    const reopened = managed.getSessionManagedRuntime(session.sessionId).admission;
    assert.equal(reopened?.admission, "open");
    assert.equal(reopened?.runtime_epoch, managed.runtimeEpoch);
    assert.ok(managed.runtimeEpoch > closed.runtimeEpoch);
  } finally {
    fixture.cleanup();
  }
});

test("close increments registry revision for both lifecycle writes", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-close-revision`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/close-revision" });
    const before = readJson(registry.paths.registry) as PersistedRegistry;

    const result = registry.close(session.sessionId);
    const after = readJson(registry.paths.registry) as PersistedRegistry;

    assert.equal(result.session.state, "closed");
    assert.equal(registryRevision(after), registryRevision(before) + 2);
    assert.equal(registry.get(session.sessionId)?.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("discard increments registry revision for both lifecycle writes", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-discard-revision`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/discard-revision" });
    const before = readJson(registry.paths.registry) as PersistedRegistry;

    const result = registry.discard(session.sessionId);
    const after = readJson(registry.paths.registry) as PersistedRegistry;

    assert.equal(result.session.state, "closed");
    assert.equal(registryRevision(after), registryRevision(before) + 2);
    assert.equal(registry.get(session.sessionId)?.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc assigns distinct monotonic revisions across multiple prunable candidates", () => {
  const fixture = createRepositoryFixture();
  const firstWorktreePath = `${fixture.repositoryPath}-gc-revision-first`;
  const secondWorktreePath = `${fixture.repositoryPath}-gc-revision-second`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.provision({ worktreePath: firstWorktreePath, branchName: "feature/gc-revision-first" });
    const second = registry.provision({
      worktreePath: secondWorktreePath,
      branchName: "feature/gc-revision-second",
    });
    const before = readJson(registry.paths.registry) as PersistedRegistry;

    fs.rmSync(firstWorktreePath, { recursive: true, force: true });
    fs.rmSync(secondWorktreePath, { recursive: true, force: true });

    const result = registry.garbageCollect({ apply: true });
    const after = readJson(registry.paths.registry) as PersistedRegistry;

    assert.deepEqual(
      new Set(result.cleaned.map((record) => record.sessionId)),
      new Set([first.sessionId, second.sessionId]),
    );
    assert.deepEqual(result.blocked, []);
    assert.equal(registryRevision(after), registryRevision(before) + 6);
    assert.equal(registry.get(first.sessionId)?.state, "closed");
    assert.equal(registry.get(second.sessionId)?.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, firstWorktreePath);
    removeWorktree(fixture.repositoryPath, secondWorktreePath);
    fixture.cleanup();
  }
});

test("does not rewrite a registry containing an unsupported feature", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    registry.create();
    const unsupported = readJson(registry.paths.registry) as Record<string, unknown>;
    unsupported.required_features = ["future.v1"];
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(unsupported)}\n`);
    const before = fs.readFileSync(registry.paths.registry, "utf8");

    assertRegistryError(() => registry.create(), "REGISTRY_FEATURE_UNSUPPORTED");
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("toPersistedSessionRecord validates against the caller's expected repository", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    assertRegistryError(
      () =>
        toPersistedSessionRecord({ ...session, repositoryId: `${session.repositoryId}-other` }, session.repositoryId),
      "REGISTRY_REPOSITORY_MISMATCH",
    );
  } finally {
    fixture.cleanup();
  }
});

test("recovers a stale session lock only when local process identity proves it dead", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      lockTimeoutMs: 50,
      lockStaleAfterMs: 0,
      lockMetadataGraceMs: 0,
    });
    fs.mkdirSync(registry.paths.directory, { recursive: true });
    fs.mkdirSync(registry.paths.lock, { recursive: true });
    fs.writeFileSync(
      path.join(registry.paths.lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        pid: process.pid,
        hostname: os.hostname(),
        processStartTime: "0",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      })}\n`,
    );

    const session = registry.create({ label: "recovered" });
    assert.equal(session.label, "recovered");
    assert.equal(fs.existsSync(registry.paths.lock), false);
  } finally {
    fixture.cleanup();
  }
});

test("does not steal a stale session lock whose owner cannot be verified dead", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      lockTimeoutMs: 0,
      lockStaleAfterMs: 0,
      lockMetadataGraceMs: 0,
    });
    fs.mkdirSync(registry.paths.directory, { recursive: true });
    fs.mkdirSync(registry.paths.lock, { recursive: true });
    fs.writeFileSync(
      path.join(registry.paths.lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "remote-owner",
        pid: 1,
        hostname: `${os.hostname()}-remote`,
        processStartTime: "1",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      })}\n`,
    );

    assertRegistryError(() => registry.create(), "REGISTRY_LOCK_TIMEOUT");
    assert.equal(fs.existsSync(registry.paths.lock), true);
  } finally {
    fixture.cleanup();
  }
});

test("shares the repository lock format with the generic mutation boundary", async () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath, lockTimeoutMs: 0 });
    const externalLock = new RepositoryLock({
      lockPath: registry.paths.lock,
      staleAfterMs: 60_000,
      acquireTimeoutMs: 0,
    });
    const lease = await externalLock.acquire();
    try {
      assertRegistryError(() => registry.create(), "REGISTRY_LOCK_TIMEOUT");
    } finally {
      await lease.release();
    }
    assert.equal(registry.create().state, "active");
  } finally {
    fixture.cleanup();
  }
});

test("serializes concurrent creates without losing updates or duplicating ownership", { timeout: 30_000 }, async () => {
  const fixture = createRepositoryFixture();
  const worktreePaths = Array.from({ length: 8 }, (_, index) =>
    path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-concurrent-${index}`),
  );
  try {
    for (const [index, worktreePath] of worktreePaths.entries()) {
      runGit(["worktree", "add", "-b", `feature/concurrent-${index}`, worktreePath], fixture.repositoryPath);
    }
    const workerPath = fileURLToPath(new URL("../scripts/session-registry-worker.mjs", import.meta.url));
    const results = await Promise.all(
      worktreePaths.map((worktreePath, index) =>
        runWorker(workerPath, [fixture.repositoryPath, worktreePath, `feature/concurrent-${index}`, "25000"]),
      ),
    );
    assert.equal(new Set(results).size, worktreePaths.length);

    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const records = registry.list();
    assert.equal(records.length, worktreePaths.length);
    assert.equal(new Set(records.map((record) => record.worktreeId)).size, records.length);
    assert.equal(new Set(records.map((record) => record.branchId)).size, records.length);
  } finally {
    for (const worktreePath of worktreePaths) {
      try {
        runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
      } catch {
        // The directory cleanup below is sufficient if creation failed.
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    fixture.cleanup();
  }
});

test("does not resolve a closed record as the current owner", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const session = registry.create();
    const persisted = toPersistedSessionRecord({ ...session, state: "closed", updatedAt: "2026-01-01T00:00:01.000Z" });
    writeRegistry(registry, {
      schema_version: 1,
      repository_id: registry.repository.repositoryId,
      sessions: [persisted],
    });

    assertRegistryError(() => registry.resolveCurrentSession(), "SESSION_NOT_FOUND");
  } finally {
    fixture.cleanup();
  }
});

test("an unexpected post-rename directory-sync failure is reported durability-uncertain, not an ordinary IO failure", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assert.throws(
      () => withDirectoryFsyncFailure(registry.paths.directory, "EIO", () => registry.create()),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );
    // The rename already committed the document; the failure only means
    // directory durability could not be proven, not that nothing happened.
    assert.equal(new SessionRegistry({ cwd: fixture.repositoryPath }).list().length, 1);
    assert.equal(fs.existsSync(registry.paths.registry), true);
  } finally {
    fixture.cleanup();
  }
});

test("a known unsupported directory-fsync condition does not fail an ordinary mutation", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = withDirectoryFsyncFailure(registry.paths.directory, "EINVAL", () => registry.create());
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get(session.sessionId)?.sessionId, session.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("an unexpected pre-rename write failure never produces a successful mutation", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    // Targets only the registry's own temporary-file fsync: an unconditional
    // override would also fail RepositoryLock.acquireSync()'s owner.json
    // write, which happens first, and the resulting lock failure would
    // incidentally normalize to the same REGISTRY_IO_FAILURE code without
    // ever exercising writeUnsafe()'s pre-rename path at all.
    assertRegistryError(
      () => withRegistryTempFileFsyncFailure(registry.paths.directory, "EIO", () => registry.create()),
      "REGISTRY_IO_FAILURE",
    );
    assert.deepEqual(registry.list(), []);
    assert.equal(fs.existsSync(registry.paths.registry), false);
  } finally {
    fixture.cleanup();
  }
});

const READY_SANDBOX_PROBE: SandboxProbe = Object.freeze({
  platform: () => "linux" as NodeJS.Platform,
  uid: () => 1000,
  gid: () => 1000,
  hasBubblewrap: () => true,
  hasNamespaceSupport: () => true,
  hasCgroupsV2: () => true,
  hasLandlock: () => true,
  hasSeccomp: () => true,
  hasCapabilities: () => true,
});

function ownershipSnapshot(registry: SessionRegistry, repositoryPath: string, branch: string, worktree: string) {
  return {
    registry: fs.existsSync(registry.paths.registry) ? fs.readFileSync(registry.paths.registry, "utf8") : null,
    branch: runGit(["branch", "--list", branch], repositoryPath),
    worktrees: runGit(["worktree", "list", "--porcelain"], repositoryPath),
    worktreeExists: fs.existsSync(worktree),
  };
}

test("required process tracking fails closed without a managed readiness authority despite a ready sandbox", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-mr`);
  const branchName = "feature/managed-readiness-absent";
  try {
    assert.equal(sandboxDoctorReport(READY_SANDBOX_PROBE).ready, true);
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath, sandboxProbe: READY_SANDBOX_PROBE });
    const before = ownershipSnapshot(registry, fixture.repositoryPath, branchName, worktreePath);
    assert.throws(
      () => registry.provision({ branchName, worktreePath, profile: { selection: { profile: "builtin:minimal" } } }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "SANDBOX_CAPABILITY_UNAVAILABLE" &&
        error.exitCode === 4 &&
        error.details?.managed_execution_authority === "absent",
    );
    assert.deepEqual(ownershipSnapshot(registry, fixture.repositoryPath, branchName, worktreePath), before);
    assert.equal(before.registry, null);
    assert.equal(before.branch, "");
    assert.equal(before.worktreeExists, false);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("managed readiness preflight runs before ownership mutation and a negative answer changes nothing", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-mr`);
  const branchName = "feature/managed-readiness-negative";
  const seed = new SessionRegistry({ cwd: fixture.repositoryPath }).create({ label: "seed" });
  try {
    const requests: ManagedExecutionReadinessRequest[] = [];
    let observedDuringPreflight: ReturnType<typeof ownershipSnapshot> | undefined;
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      sandboxProbe: READY_SANDBOX_PROBE,
      managedExecutionReadiness: (request) => {
        requests.push(request);
        observedDuringPreflight = ownershipSnapshot(registry, fixture.repositoryPath, branchName, worktreePath);
        return { ready: false };
      },
    });
    const before = ownershipSnapshot(registry, fixture.repositoryPath, branchName, worktreePath);
    assert.throws(
      () => registry.provision({ branchName, worktreePath, profile: { selection: { profile: "builtin:minimal" } } }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "SANDBOX_CAPABILITY_UNAVAILABLE" &&
        error.details?.managed_execution_authority === "not_ready",
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.processTracking, "required");
    assert.equal(requests[0]?.profile.id, "minimal");
    assert.match(requests[0]?.profile.digest ?? "", /^[0-9a-f]{64}$/u);
    assert.deepEqual(observedDuringPreflight, before);
    assert.deepEqual(ownershipSnapshot(registry, fixture.repositoryPath, branchName, worktreePath), before);
    assert.deepEqual(
      registry.list().map((record) => record.sessionId),
      [seed.sessionId],
    );
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("missing profile material fails with its typed error before managed readiness is consulted", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-mr`);
  const branchName = "feature/managed-readiness-material";
  try {
    let consulted = false;
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      managedExecutionReadiness: () => {
        consulted = true;
        return { ready: true };
      },
    });
    assert.throws(
      () =>
        registry.provision({
          branchName,
          worktreePath,
          profile: { selection: { profile: "builtin:standard-shell" } },
        }),
      (error: unknown) => error instanceof DomainError && error.code === "RUNTIME_MATERIALIZATION_MISSING",
    );
    assert.equal(consulted, false);
    assert.equal(fs.existsSync(registry.paths.registry), false);
    assert.equal(runGit(["branch", "--list", branchName], fixture.repositoryPath), "");
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("an explicit managed readiness authority authorizes bootstrap without changing the pinned profile", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-mr`);
  const branchName = "feature/managed-readiness-ready";
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      managedExecutionReadiness: () => ({ ready: true }),
    });
    const session = registry.provision({
      branchName,
      worktreePath,
      profile: { selection: { profile: "builtin:minimal" } },
    });
    assert.equal(session.branchName, branchName);
    const persisted = readJson(registry.paths.registry) as {
      pinned_profiles?: readonly { resolved?: { id?: string; execution?: { processTracking?: string } } }[];
    };
    assert.equal(persisted.pinned_profiles?.length, 1);
    assert.equal(persisted.pinned_profiles?.[0]?.resolved?.id, "minimal");
    assert.equal(persisted.pinned_profiles?.[0]?.resolved?.execution?.processTracking, "required");
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
    } catch {
      // Directory cleanup below remains safe when Git never created the worktree.
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("omitted-profile provisioning does not consult managed readiness", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-mr`);
  try {
    let consulted = false;
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      managedExecutionReadiness: () => {
        consulted = true;
        return { ready: false };
      },
    });
    const session = registry.provision({ branchName: "feature/omitted-profile", worktreePath });
    assert.equal(session.branchName, "feature/omitted-profile");
    assert.equal(consulted, false);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
    } catch {
      // Directory cleanup below remains safe when Git never created the worktree.
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-registry-"));
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
      try {
        runGit(["worktree", "remove", "--force", linkedWorktreePath], repositoryPath);
      } catch {
        // The directory cleanup remains safe when Git metadata was already removed.
      }
      fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function writeRegistry(registry: SessionRegistry, value: PersistedRegistry): void {
  fs.mkdirSync(registry.paths.directory, { recursive: true });
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(value, null, 2)}\n`);
}

function registryRevision(value: PersistedRegistry): number {
  if (!("registry_revision" in value)) throw new Error("Expected a registry v2 document");
  return value.registry_revision;
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The directory cleanup remains safe when Git metadata was already removed.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runWorker(workerPath: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...arguments_], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`registry worker exited with ${exitCode}: ${stderr}`));
      }
    });
  });
}
