import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../cli.js";
import { resolveRepositoryContext } from "../git.js";
import { SessionRegistry } from "../session-registry.js";
import type { CgroupFileSystem } from "./cgroups-v2.js";
import { withDirectoryFsyncFailure } from "../testing/fs-fault-injection.js";
import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
} from "./session-execution-record.js";
import type { SandboxProbe } from "./sandbox.js";
import { LocalSessionBackend } from "./session-backend.js";
import { resolveBuiltinWorktreeProfile } from "./worktree-profile-builtins.js";
import type { SessionHookMaterialAuthority } from "../session-registry.js";

test("local session backend passes the same explicit hook material authority to every registry", () => {
  const repositoryPath = createRepository();
  try {
    const authority: SessionHookMaterialAuthority = () => ({ available: false });
    const backend = new LocalSessionBackend({ hookMaterialAuthority: authority });
    const first = backend["registryFor"]({ cwd: repositoryPath });
    const second = backend["registryFor"]({ cwd: repositoryPath });
    assert.equal(first.hookMaterialAuthority, authority);
    assert.equal(second.hookMaterialAuthority, authority);
    assert.equal(new LocalSessionBackend()["registryFor"]({ cwd: repositoryPath }).hookMaterialAuthority, undefined);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local session backend binds default managed readiness to protected sandbox and cgroup scope authority", async () => {
  const repositoryPath = createRepository();
  const profile = installBoundedManagedProfile(repositoryPath);
  const worktreePath = `${repositoryPath}-domain-managed-readiness`;
  const readySandbox: SandboxProbe = {
    platform: () => "linux",
    uid: () => 1000,
    gid: () => 1000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => true,
    hasLandlock: () => true,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
  };
  const options = {
    branch: "feature/domain-managed-readiness",
    worktree: worktreePath,
    label: null,
    base: null,
    ...boundedReadinessArtifacts(repositoryPath),
    profile: { selection: { profile } },
  };
  const unusableCgroups = readinessCgroupFixture({ failDelegation: true });
  const usableCgroups = readinessCgroupFixture();
  try {
    const registryPath = new SessionRegistry({ cwd: repositoryPath }).paths.registry;
    const unavailable = await new LocalSessionBackend({
      sandboxProbe: readySandbox,
      cgroupRoot: unusableCgroups.root,
      registry: { cgroupFilesystem: unusableCgroups.filesystem },
    }).createSession({ cwd: repositoryPath }, options);
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) {
      assert.equal(unavailable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
      assert.equal(unavailable.error.exitCode, 4);
    }
    assert.equal(unusableCgroups.scopeCreateCount, 0);
    assert.equal(fs.existsSync(registryPath), false);
    assert.equal(runGit(["branch", "--list", options.branch], repositoryPath), "");
    assert.equal(fs.existsSync(worktreePath), false);

    const authorized = await new LocalSessionBackend({
      sandboxProbe: readySandbox,
      cgroupRoot: usableCgroups.root,
      registry: { cgroupFilesystem: usableCgroups.filesystem },
    }).createSession({ cwd: repositoryPath }, options);
    assert.equal(authorized.ok, true);
    if (authorized.ok) assert.equal(authorized.value.branch, options.branch);
    assert.equal(usableCgroups.scopeCreateCount, 1);
    assert.equal(usableCgroups.scopeCleanupCount, 1);
    assert.equal(usableCgroups.activeScopeCount, 0);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local backend exposes the single cgroup root retained for managed readiness", () => {
  const cgroups = readinessCgroupFixture();
  const backend = new LocalSessionBackend({
    cgroupRoot: cgroups.root,
    registry: { cgroupFilesystem: cgroups.filesystem },
  });
  const first = backend.getManagedCgroupRoot();
  assert.equal(first.ok, true);
  assert.equal(backend.getManagedCgroupRoot(), first);
});

test("local managed readiness fails closed on cgroup observation or cleanup uncertainty", async () => {
  for (const failure of ["observation", "cleanup"] as const) {
    const repositoryPath = createRepository();
    const worktreePath = `${repositoryPath}-domain-managed-readiness-${failure}`;
    const cgroups = readinessCgroupFixture({
      ...(failure === "observation" ? { failObservation: true } : { failCleanup: true }),
    });
    const branch = `feature/domain-managed-readiness-${failure}`;
    try {
      const result = await new LocalSessionBackend({
        cgroupRoot: cgroups.root,
        sandboxProbe: {
          platform: () => "linux",
          uid: () => 1000,
          gid: () => 1000,
          hasBubblewrap: () => true,
          hasNamespaceSupport: () => true,
          hasCgroupsV2: () => true,
          hasLandlock: () => true,
          hasSeccomp: () => true,
          hasCapabilities: () => true,
        },
        registry: { cgroupFilesystem: cgroups.filesystem },
      }).createSession(
        { cwd: repositoryPath },
        {
          branch,
          worktree: worktreePath,
          label: null,
          base: null,
          profile: { selection: { profile: "builtin:minimal" } },
        },
      );
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
      assert.equal(cgroups.scopeCreateCount, 1);
      assert.equal(fs.existsSync(new SessionRegistry({ cwd: repositoryPath }).paths.registry), false);
      assert.equal(runGit(["branch", "--list", branch], repositoryPath), "");
      assert.equal(fs.existsSync(worktreePath), false);
    } finally {
      removeWorktree(repositoryPath, worktreePath);
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    }
  }
});

test("local session backend preserves an explicitly injected managed readiness authority", async () => {
  const repositoryPath = createRepository();
  const profile = installBoundedManagedProfile(repositoryPath);
  const worktreePath = `${repositoryPath}-domain-managed-readiness-injected`;
  const unusableCgroups = readinessCgroupFixture({ failDelegation: true });
  let readinessCalls = 0;
  try {
    const result = await new LocalSessionBackend({
      cgroupRoot: unusableCgroups.root,
      managedExecutionReadiness: () => {
        readinessCalls += 1;
        return { ready: true };
      },
      registry: { cgroupFilesystem: unusableCgroups.filesystem },
    }).createSession(
      { cwd: repositoryPath },
      {
        branch: "feature/domain-managed-readiness-injected",
        worktree: worktreePath,
        label: null,
        base: null,
        ...boundedReadinessArtifacts(repositoryPath),
        profile: { selection: { profile } },
      },
    );
    assert.equal(result.ok, true);
    assert.equal(readinessCalls, 1);
    assert.equal(unusableCgroups.scopeCreateCount, 0);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local session backend provisions through the domain contract", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-domain-session`;
  try {
    const backend = new LocalSessionBackend();
    const result = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/domain", worktree: worktreePath, label: "domain", base: null },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.branch, "feature/domain");
    assert.equal(result.value.worktree, fs.realpathSync.native(worktreePath));
    assert.equal(result.value.label, "domain");
    assert.equal(result.value.state, "active");
    const managedRuntime = await backend.getSessionManagedRuntime({ cwd: repositoryPath }, result.value.session_id);
    assert.equal(managedRuntime.ok, true);
    if (managedRuntime.ok) {
      assert.equal(managedRuntime.value.admission, null);
      assert.equal(managedRuntime.value.profile, null);
    }
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local session backend provisions initial claims in the same registry mutation", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-domain-initial-claims`;
  try {
    const backend = new LocalSessionBackend();
    const result = await backend.createSession(
      { cwd: repositoryPath },
      {
        branch: "feature/domain-initial-claims",
        worktree: worktreePath,
        label: null,
        base: null,
        claims: [{ resource: "README.md", mode: "write" }],
      },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const registry = new SessionRegistry({ cwd: repositoryPath });
    assert.deepEqual(
      registry.listClaims(result.value.session_id).map((claim) => claim.mode),
      ["write"],
    );
    assert.equal(registry.listClaims(result.value.session_id)[0]?.resource, "README.md");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("same-ID execution transitions persist through the backend and survive restart", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-managed-execution-ledger`;
  try {
    const context = { cwd: repositoryPath };
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(context, {
      branch: "feature/managed-execution-ledger",
      worktree: worktreePath,
      label: null,
      base: null,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const registry = new SessionRegistry({ cwd: repositoryPath });
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
    const runtimeEpoch = Number(persisted.runtime_epoch);
    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify({
        ...persisted,
        required_features: ["runtime-sessions.v1", "executions.v1"],
        runtime_sessions: [
          {
            kind: "session-admission",
            schema_version: 1,
            session_id: created.value.session_id,
            admission: "open",
            runtime_epoch: runtimeEpoch,
          },
        ],
        executions: [],
      })}\n`,
    );

    const reserved = reserveExecution({
      session_id: created.value.session_id,
      execution_id: "managed-ledger-execution",
      profile_digest: "a".repeat(64),
      filesystem_token: "b".repeat(64),
      runtime_epoch: runtimeEpoch,
      boot_id: "managed-ledger-boot",
      now: "2026-09-22T00:00:00.000Z",
    });
    assert.equal(reserved.ok, true);
    if (!reserved.ok) return;

    const starting = await backend.persistSessionExecution(context, toPersistedSessionExecutionRecord(reserved.value));
    assert.equal(starting.ok, true);
    if (!starting.ok) return;

    const attached = recordExecutionState(reserved.value, {
      state: "attached",
      supervisor: { pid: process.pid, starttime: "1" },
      now: "2026-09-22T00:00:01.000Z",
    });
    assert.equal(attached.ok, true);
    if (!attached.ok) return;
    const attachedWrite = await backend.persistSessionExecution(
      context,
      toPersistedSessionExecutionRecord(attached.value),
    );
    assert.equal(attachedWrite.ok, true);
    if (!attachedWrite.ok) return;

    const releasing = recordExecutionState(attached.value, {
      state: "running",
      release_attempt: {
        attempt: 1,
        outcome: "unresolved",
        attempted_at: "2026-09-22T00:00:02.000Z",
        reason: "test evidence",
      },
      now: "2026-09-22T00:00:02.000Z",
    });
    assert.equal(releasing.ok, true);
    if (!releasing.ok) return;
    const releaseWrite = await backend.persistSessionExecution(
      context,
      toPersistedSessionExecutionRecord(releasing.value),
    );
    assert.equal(releaseWrite.ok, true);
    if (!releaseWrite.ok) return;

    const terminal = recordExecutionState(releasing.value, {
      state: "exited",
      now: "2026-09-22T00:00:03.000Z",
    });
    assert.equal(terminal.ok, true);
    if (!terminal.ok) return;
    const terminalWrite = await backend.persistSessionExecution(
      context,
      toPersistedSessionExecutionRecord(terminal.value),
    );
    assert.equal(terminalWrite.ok, true);
    if (!terminalWrite.ok) return;

    const conflictingIdentity = {
      ...terminal.value,
      filesystem_token: "c".repeat(64),
    };
    const rejected = await backend.persistSessionExecution(
      context,
      toPersistedSessionExecutionRecord(conflictingIdentity),
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "OPERATION_REJECTED");

    const restarted = new LocalSessionBackend();
    const restored = await restarted.listSessionExecutions(context, created.value.session_id);
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.value.length, 1);
      assert.equal(restored.value[0]?.execution_id, "managed-ledger-execution");
      assert.equal(restored.value[0]?.state, "exited");
      assert.equal(restored.value[0]?.release_attempt?.attempt, 1);
      assert.equal(restored.value[0]?.supervisor_pid, process.pid);
    }
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local session backend exposes deterministic bootstrap retry evidence without adopting an owner", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-domain-bootstrap-retry`;
  const options = {
    branch: "feature/domain-bootstrap-retry",
    worktree: worktreePath,
    label: "bootstrap-retry",
    base: null,
    claims: [{ resource: "README.md", mode: "write" as const }],
  };
  try {
    const backend = new LocalSessionBackend();
    const registry = new SessionRegistry({ cwd: repositoryPath });
    assert.throws(
      () =>
        withDirectoryFsyncFailure(registry.paths.directory, "EIO", () =>
          registry.provision({
            branchName: options.branch,
            worktreePath: options.worktree,
            label: options.label,
            initialClaims: options.claims,
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "SessionRegistryError" &&
        (error as { code?: string }).code === "REGISTRY_DURABILITY_UNCERTAIN",
    );

    const retry = await backend.createSession({ cwd: repositoryPath }, options);
    assert.equal(retry.ok, false);
    if (retry.ok) return;
    assert.equal(retry.error.code, "WORKTREE_OWNED_BY_OTHER_SESSION");
    const retryEvidence = retry.error.details?.bootstrap_retry as Record<string, unknown>;
    assert.equal(retryEvidence.classification, "already-established");
    assert.equal(retryEvidence.exact_identity_proven, true);
    assert.equal(typeof retryEvidence.session_id, "string");
    assert.equal(retryEvidence.next_action, "inspect-established-session");

    const unrelated = await backend.createSession(
      { cwd: repositoryPath },
      { ...options, claims: [{ resource: "README.md", mode: "read" as const }] },
    );
    assert.equal(unrelated.ok, false);
    if (unrelated.ok) return;
    assert.equal(unrelated.error.code, "WORKTREE_OWNED_BY_OTHER_SESSION");
    const unrelatedEvidence = unrelated.error.details?.bootstrap_retry as Record<string, unknown>;
    assert.deepEqual(unrelatedEvidence, {
      classification: "owner-conflict",
      exact_identity_proven: false,
      next_action: "inspect-blocking-session",
    });
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("status exposes the resolved managed root and bounded history selection", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-status-root`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/status-root", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const status = await backend.status({ cwd: repositoryPath });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(
      status.value.managed_worktree_root,
      path.join(path.dirname(fs.realpathSync.native(repositoryPath)), ".nawabari", "worktrees"),
    );
    assert.equal(status.value.history_included, false);
    assert.equal(
      status.value.sessions.some((session) => session.session_id === created.value.session_id),
      true,
    );
    const statusSession = status.value.sessions.find((session) => session.session_id === created.value.session_id);
    const inspected = await backend.sessionDiagnostic(
      { cwd: repositoryPath },
      { session_id: created.value.session_id, integrated_revision: null },
    );
    assert.equal(inspected.ok, true);
    if (!inspected.ok || statusSession === undefined) return;
    assert.equal(statusSession.lifecycle_state, inspected.value.lifecycle_state);
    assert.deepEqual(statusSession.lifecycle, inspected.value.lifecycle);
    assert.deepEqual(statusSession.next_actions, inspected.value.next_actions);

    const closed = await backend.closeSession({ cwd: repositoryPath }, { session_id: created.value.session_id });
    assert.equal(closed.ok, true);
    const bounded = await backend.status({ cwd: repositoryPath });
    assert.equal(bounded.ok, true);
    if (!bounded.ok) return;
    assert.equal(
      bounded.value.sessions.some((session) => session.session_id === created.value.session_id),
      false,
    );
    const history = await backend.status({ cwd: repositoryPath }, { include_closed: true });
    assert.equal(history.ok, true);
    if (!history.ok) return;
    assert.equal(history.value.history_included, true);
    assert.equal(
      history.value.sessions.find((session) => session.session_id === created.value.session_id)?.state,
      "closed",
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("local backend migrates legacy claim state and restores ordinary reads", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-migration`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/migration", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const registry = new SessionRegistry({ cwd: repositoryPath });
    registry.claimResources({
      sessionId: created.value.session_id,
      claims: [{ resource: "README.md", mode: "read" }],
    });
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claims_schema_version: number;
      claims: Array<{ schema_version: number }>;
    };
    persisted.claims_schema_version = 2;
    for (const claim of persisted.claims) claim.schema_version = 2;
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted)}\n`);

    const readable = await backend.status({ cwd: worktreePath });
    assert.equal(readable.ok, true);

    const migrationOutput: string[] = [];
    const migrationExitCode = await runCli(["migrate", "--json"], {
      cwd: worktreePath,
      io: { stdout: (line) => migrationOutput.push(line), stderr: () => undefined },
    });
    assert.equal(migrationExitCode, 0);
    assert.deepEqual(JSON.parse(migrationOutput[0] ?? ""), {
      ok: true,
      command: "migrate",
      migrated: true,
      registry_schema_version: 1,
      claim_schema_version: 3,
    });

    const status = await backend.status({ cwd: worktreePath });
    assert.equal(status.ok, true);
    const after = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      claims_schema_version: number;
      claims: Array<{ schema_version: number }>;
    };
    assert.equal(after.claims_schema_version, 3);
    assert.equal(after.claims[0]?.schema_version, 3);

    const retry = await backend.migrate({ cwd: worktreePath });
    assert.deepEqual(retry, {
      ok: true,
      value: { migrated: false, registry_schema_version: 1, claim_schema_version: 3 },
    });
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource claims expose canonical machine fields through the backend and CLI", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-claim-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/claim-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const claimed = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "read" }],
      },
    );
    assert.equal(claimed.ok, true, claimed.ok ? "claim succeeded" : JSON.stringify(claimed.error));
    if (!claimed.ok) return;
    assert.equal(claimed.value.claims.length, 1);
    assert.equal(claimed.value.claims[0]?.schema_version, 3);
    assert.match(claimed.value.claims[0]?.claim_id ?? "", /^claim-[0-9a-f]{64}$/u);
    assert.equal(claimed.value.claims[0]?.resource, "README.md");
    assert.equal(claimed.value.claims[0]?.mode, "read");
    assert.equal(claimed.value.claim_set_generation, 1);

    const omittedForce = await backend.updateClaims(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "write" }],
      },
    );
    assert.equal(omittedForce.ok, false);
    if (omittedForce.ok) return;
    assert.equal(omittedForce.error.code, "INVALID_OPERATION");

    const omittedRelease = await backend.releaseClaims(
      { cwd: worktreePath },
      { session_id: created.value.session_id, claim_ids: null },
    );
    assert.equal(omittedRelease.ok, false);
    if (omittedRelease.ok) return;
    assert.equal(omittedRelease.error.code, "INVALID_OPERATION");

    const forcedUpdate = await backend.updateClaims(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "write" }],
        force: true,
      },
    );
    assert.equal(forcedUpdate.ok, true);
    if (!forcedUpdate.ok) return;
    assert.equal(forcedUpdate.value.claim_set_generation, 2);

    const staleUpdate = await backend.updateClaims(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [],
        expected_claim_set_generation: 1,
      },
    );
    assert.equal(staleUpdate.ok, false);
    if (staleUpdate.ok) return;
    assert.equal(staleUpdate.error.code, "STALE_CLAIM_SET");
    assert.ok(staleUpdate.error.details);
    assert.equal(staleUpdate.error.details.expectedClaimSetGeneration, 1);
    assert.equal(staleUpdate.error.details.actualClaimSetGeneration, 2);

    const stdout: string[] = [];
    const exitCode = await runCli(["session", "claims", "--session", created.value.session_id, "--json"], {
      cwd: worktreePath,
      io: { stdout: (line) => stdout.push(line), stderr: () => undefined },
    });
    assert.equal(exitCode, 0);
    const listed = JSON.parse(stdout[0] ?? "") as {
      ok: boolean;
      command: string;
      claims: Array<{ resource: string; mode: string }>;
      claim_set_generation: number;
    };
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "session claims");
    assert.equal(listed.claim_set_generation, 2);
    assert.deepEqual(
      listed.claims.map((claim) => [claim.resource, claim.mode]),
      [["README.md", "write"]],
    );

    const released = await backend.releaseClaims(
      { cwd: worktreePath },
      { session_id: created.value.session_id, claim_ids: null, expected_claim_set_generation: 2 },
    );
    assert.equal(released.ok, true);
    if (!released.ok) return;
    assert.equal(released.value.released.length, 1);
    assert.equal(released.value.remaining.length, 0);
    assert.equal(released.value.claim_set_generation, 3);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("additive contradictory claims expose one projected recovery action that the public transition executes", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-recovery-action`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/recovery-action", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const initial = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [
          { resource: "README.md", mode: "write" },
          { resource: "unrelated.txt", mode: "read" },
        ],
      },
    );
    assert.equal(initial.ok, true);
    if (!initial.ok) return;

    const rejected = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "exclusive-write" }],
      },
    );
    assert.equal(rejected.ok, false);
    if (rejected.ok) return;
    assert.equal(rejected.error.code, "CONTRADICTORY_CLAIM");
    const action = rejected.error.details?.recoveryAction as {
      actionId: string;
      command: string;
      resource: string;
      mode: string;
      claimSetGeneration: number;
    };
    assert.equal(action.actionId, "transition-exact-resource");
    assert.equal(action.resource, "README.md");
    assert.equal(action.mode, "exclusive-write");
    assert.equal(action.claimSetGeneration, initial.value.claim_set_generation);
    assert.match(action.command, /session transition/u);
    assert.match(action.command, /--if-generation 1\b/u);

    const jsonOutput: string[] = [];
    const jsonExitCode = await runCli(
      [
        "--json",
        "session",
        "claim",
        "--session",
        created.value.session_id,
        "--resource",
        "README.md",
        "--mode",
        "exclusive-write",
      ],
      { cwd: worktreePath, io: { stdout: (line) => jsonOutput.push(line), stderr: () => undefined } },
    );
    assert.equal(jsonExitCode, 3);
    const machine = JSON.parse(jsonOutput[0] ?? "") as {
      code: string;
      details: { recoveryAction: typeof action };
    };
    assert.equal(machine.code, "CONTRADICTORY_CLAIM");
    assert.deepEqual(machine.details.recoveryAction, action);

    const humanOutput: string[] = [];
    const humanExitCode = await runCli(
      [
        "session",
        "claim",
        "--session",
        created.value.session_id,
        "--resource",
        "README.md",
        "--mode",
        "exclusive-write",
      ],
      { cwd: worktreePath, io: { stdout: () => undefined, stderr: (line) => humanOutput.push(line) } },
    );
    assert.equal(humanExitCode, 3);
    const human = humanOutput.join("\n");
    assert.match(human, /recoveryAction:/u);
    assert.match(human, /actionId: transition-exact-resource/u);
    assert.match(human, /claimSetGeneration: 1/u);

    const transitioned = await runCli(
      [
        "--json",
        "session",
        "transition",
        "--session",
        created.value.session_id,
        "--resource",
        action.resource,
        "--mode",
        action.mode,
        "--if-generation",
        String(action.claimSetGeneration),
      ],
      { cwd: worktreePath, io: { stdout: (line) => jsonOutput.push(line), stderr: () => undefined } },
    );
    assert.equal(transitioned, 0);
    const transitionResult = JSON.parse(jsonOutput.at(-1) ?? "") as {
      changed: Array<{ resource: string; after: { mode: string } }>;
      claims: Array<{ resource: string; mode: string }>;
      claim_set_generation: number;
    };
    assert.equal(transitionResult.changed[0]?.resource, "README.md");
    assert.equal(transitionResult.changed[0]?.after.mode, "exclusive-write");
    assert.deepEqual(
      transitionResult.claims.map((claim) => [claim.resource, claim.mode]),
      [
        ["README.md", "exclusive-write"],
        ["unrelated.txt", "read"],
      ],
    );
    assert.equal(transitionResult.claim_set_generation, 2);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("backend release exposes selected resources and explicit all with CAS", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-selected-release`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/selected-release", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const claimed = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [
          { resource: "selected.txt", mode: "write" },
          { resource: "unrelated.txt", mode: "read" },
        ],
      },
    );
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;

    const selected = await backend.releaseClaims(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        resources: ["selected.txt", "missing.txt"],
        expected_claim_set_generation: claimed.value.claim_set_generation,
      },
    );
    assert.equal(selected.ok, true, selected.ok ? "selected release succeeded" : JSON.stringify(selected.error));
    if (!selected.ok) return;
    assert.deepEqual(
      selected.value.released.map((claim) => claim.resource),
      ["selected.txt"],
    );
    assert.deepEqual(
      selected.value.remaining.map((claim) => claim.resource),
      ["unrelated.txt"],
    );
    assert.equal(selected.value.claim_set_generation, 2);

    const stale = await backend.releaseClaims(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        resources: ["unrelated.txt"],
        expected_claim_set_generation: 1,
      },
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, "STALE_CLAIM_SET");

    const all = await backend.releaseClaims(
      { cwd: worktreePath },
      { session_id: created.value.session_id, all: true, force: true },
    );
    assert.equal(all.ok, true, all.ok ? "all release succeeded" : JSON.stringify(all.error));
    if (!all.ok) return;
    assert.equal(all.value.released.length, 1);
    assert.equal(all.value.remaining.length, 0);
    assert.equal(all.value.claim_set_generation, 3);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("backend maps atomic claim deltas with typed before/after projections", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-delta-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/delta-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const acquired = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "read" }],
      },
    );
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;

    const changed = await backend.applyClaimDeltas(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        expected_claim_set_generation: acquired.value.claim_set_generation,
        deltas: [
          { kind: "upsert", resource: "README.md", mode: "write" },
          { kind: "upsert", resource: "src/new.ts", mode: "read" },
        ],
      },
    );
    assert.equal(changed.ok, true, changed.ok ? "delta succeeded" : JSON.stringify(changed.error));
    if (!changed.ok) return;
    assert.equal(changed.value.previous_claim_set_generation, 1);
    assert.equal(changed.value.claim_set_generation, 2);
    assert.equal(changed.value.changed.length, 1);
    assert.equal(changed.value.changed[0]?.before.mode, "read");
    assert.equal(changed.value.changed[0]?.after.mode, "write");
    assert.deepEqual(
      changed.value.claims.map((claim) => [claim.resource, claim.mode]),
      [
        ["README.md", "write"],
        ["src/new.ts", "read"],
      ],
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("backend exposes exact upsert transitions for every mode without rebuilding unrelated claims", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-transition-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/transition-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const unrelated = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "unrelated.txt", mode: "read" }],
      },
    );
    assert.equal(unrelated.ok, true);
    if (!unrelated.ok) return;

    const transition = async (mode: "read" | "write" | "exclusive-write", expected: number) =>
      backend.applyClaimDeltas(
        { cwd: worktreePath },
        {
          session_id: created.value.session_id,
          repository: created.value.repository,
          deltas: [{ kind: "upsert", resource: "target.txt", mode }],
          expected_claim_set_generation: expected,
        },
      );

    const acquired = await transition("read", unrelated.value.claim_set_generation);
    assert.equal(acquired.ok, true);
    if (!acquired.ok) return;
    assert.equal(acquired.value.added[0]?.mode, "read");
    assert.equal(acquired.value.claim_set_generation, 2);

    const changedToWrite = await transition("write", acquired.value.claim_set_generation);
    assert.equal(changedToWrite.ok, true);
    if (!changedToWrite.ok) return;
    assert.equal(changedToWrite.value.changed[0]?.before.mode, "read");
    assert.equal(changedToWrite.value.changed[0]?.after.mode, "write");
    assert.equal(changedToWrite.value.claim_set_generation, 3);

    const changedToExclusive = await transition("exclusive-write", changedToWrite.value.claim_set_generation);
    assert.equal(changedToExclusive.ok, true);
    if (!changedToExclusive.ok) return;
    assert.equal(changedToExclusive.value.changed[0]?.after.mode, "exclusive-write");
    assert.equal(changedToExclusive.value.claim_set_generation, 4);

    const sameMode = await transition("exclusive-write", changedToExclusive.value.claim_set_generation);
    assert.equal(sameMode.ok, true);
    if (!sameMode.ok) return;
    assert.equal(sameMode.value.idempotent, true);
    assert.equal(sameMode.value.unchanged[0]?.kind, "upsert");
    assert.equal(sameMode.value.claim_set_generation, 4);

    const stale = await transition("read", 0);
    assert.equal(stale.ok, false);
    if (stale.ok) return;
    assert.equal(stale.error.code, "STALE_CLAIM_SET");

    const listed = await backend.listClaims({ cwd: worktreePath }, created.value.session_id);
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    assert.equal(listed.value.claim_set_generation, 4);
    assert.deepEqual(
      listed.value.claims.map((claim) => [claim.resource, claim.mode]),
      [
        ["target.txt", "exclusive-write"],
        ["unrelated.txt", "read"],
      ],
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the CLI create command uses the local backend and emits stable JSON", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-cli-session`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture v2\n");
    runGit(["add", "README.md"], repositoryPath);
    runGit(["commit", "-m", "second"], repositoryPath);
    const baseRef = runGit(["rev-parse", "HEAD"], repositoryPath);
    const exitCode = await runCli(
      ["session", "create", "--branch", "feature/cli", "--worktree", worktreePath, "--base", baseRef, "--json"],
      {
        cwd: repositoryPath,
        io: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    const response = JSON.parse(stdout[0]) as {
      ok: boolean;
      command: string;
      session_id: string;
      branch: string;
      worktree: string;
    };
    assert.equal(response.ok, true);
    assert.equal(response.command, "session create");
    assert.match(response.session_id, /^[0-9a-f-]{36}$/u);
    assert.equal(response.branch, "feature/cli");
    assert.equal(response.worktree, fs.realpathSync.native(worktreePath));
    assert.equal(runGit(["rev-parse", "HEAD"], worktreePath), baseRef);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the CLI gc path recovers a prunable worktree before branch reuse", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-cli-prunable`;
  const branchName = "feature/cli-prunable";
  try {
    const created = await runJsonCli<{
      ok: boolean;
      command: string;
      session_id: string;
      state: string;
    }>(repositoryPath, ["session", "create", "--branch", branchName, "--worktree", worktreePath]);
    assert.equal(created.ok, true);
    assert.equal(created.command, "session create");
    assert.equal(created.state, "active");

    fs.rmSync(worktreePath, { recursive: true, force: true });
    const worktreeList = runGit(["worktree", "list", "--porcelain"], repositoryPath).split(/\r?\n/u);
    assert.equal(worktreeList.includes(`worktree ${worktreePath}`), true);
    assert.equal(
      worktreeList.some((line) => line.startsWith("prunable ")),
      true,
    );

    const dryRun = await runJsonCli<{
      ok: boolean;
      command: string;
      apply: boolean;
      candidates: Array<{
        session_id: string;
        suspicion: string;
        suspicion_reason: string;
        destructive_eligibility: string;
        destructive_eligibility_reason: string;
        physical_state: string;
      }>;
      eligible: Array<{ session_id: string }>;
      cleaned: unknown[];
      blocked: unknown[];
    }>(repositoryPath, ["gc", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.command, "gc");
    assert.equal(dryRun.apply, false);
    assert.deepEqual(
      dryRun.candidates.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.equal(dryRun.candidates[0]?.suspicion, "physical");
    assert.equal(dryRun.candidates[0]?.suspicion_reason, "missing-worktree");
    assert.equal(dryRun.candidates[0]?.destructive_eligibility, "eligible");
    assert.equal(dryRun.candidates[0]?.destructive_eligibility_reason, "prunable-missing-worktree");
    assert.equal(dryRun.candidates[0]?.physical_state, "prunable-missing");
    assert.deepEqual(
      dryRun.eligible.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.deepEqual(dryRun.cleaned, []);
    assert.deepEqual(dryRun.blocked, []);

    const applied = await runJsonCli<{
      ok: boolean;
      command: string;
      apply: boolean;
      candidates: Array<{ session_id: string; state: string }>;
      eligible: Array<{ session_id: string }>;
      cleaned: Array<{ session_id: string; state: string }>;
      blocked: unknown[];
    }>(repositoryPath, ["gc", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.command, "gc");
    assert.equal(applied.apply, true);
    assert.deepEqual(
      applied.candidates.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.deepEqual(
      applied.eligible.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.equal(applied.cleaned.length, 1);
    assert.equal(applied.cleaned[0]?.session_id, created.session_id);
    assert.equal(applied.cleaned[0]?.state, "closed");
    assert.deepEqual(applied.blocked, []);

    const listed = await runJsonCli<{
      sessions: Array<{ session_id: string; state: string }>;
    }>(repositoryPath, ["session", "list", "--all"]);
    assert.equal(listed.sessions.find((session) => session.session_id === created.session_id)?.state, "closed");

    const reused = await runJsonCli<{
      ok: boolean;
      session_id: string;
      branch: string;
      state: string;
    }>(repositoryPath, ["session", "create", "--branch", branchName, "--worktree", worktreePath]);
    assert.equal(reused.ok, true);
    assert.notEqual(reused.session_id, created.session_id);
    assert.equal(reused.branch, branchName);
    assert.equal(reused.state, "active");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the local backend preserves unexpected error diagnostics", async () => {
  const repositoryPath = createRepository();
  const expectedError = new TypeError("injected backend failure");
  try {
    const backend = new LocalSessionBackend({
      registry: {
        idGenerator: () => {
          throw expectedError;
        },
      },
    });
    const result = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "main", worktree: repositoryPath, label: null, base: null },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INTERNAL_ERROR");
    assert.equal(result.error.details?.cause, "TypeError: injected backend failure");
    assert.equal(result.error.cause, expectedError);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the local backend exposes close and gc as stable automation results", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-lifecycle-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/lifecycle-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const closed = await backend.closeSession({ cwd: worktreePath }, { session_id: null });
    assert.equal(closed.ok, true, closed.ok ? "close succeeded" : JSON.stringify(closed.error));
    if (!closed.ok) return;
    assert.equal(closed.value.session.session_id, created.value.session_id);
    assert.equal(closed.value.session.state, "closed");
    assert.equal(closed.value.worktree_removed, true);
    assert.equal(closed.value.branch_removed, true);

    const output: string[] = [];
    const exitCode = await runCli(["gc", "--dry-run", "--json"], {
      cwd: repositoryPath,
      io: { stdout: (line) => output.push(line), stderr: () => undefined },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(output[0]), {
      ok: true,
      command: "gc",
      apply: false,
      candidates: [],
      eligible: [],
      cleaned: [],
      blocked: [],
    });
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-domain-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
  runGit(["config", "tag.gpgsign", "false"], repositoryPath);
  runGit(["config", "core.hooksPath", "/dev/null"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
}

function installBoundedManagedProfile(repositoryPath: string): string {
  const builtin = resolveBuiltinWorktreeProfile({ profile: "minimal" });
  if (!builtin.ok) throw builtin.error;
  const profileId = "repository:managed-readiness-test";
  fs.writeFileSync(
    path.join(repositoryPath, "nawabari.profiles.json"),
    `${JSON.stringify(
      {
        profiles: [
          {
            ...builtin.value,
            id: "managed-readiness-test",
            extends: [],
            filesystem: {
              ...builtin.value.filesystem,
              readOnly: ["README.md"],
              write: [],
              create: [],
              delete: [],
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  runGit(["add", "nawabari.profiles.json"], repositoryPath);
  runGit(["commit", "-m", "test: add bounded managed profile"], repositoryPath);
  return profileId;
}

function boundedReadinessArtifacts(repositoryPath: string) {
  const repository = resolveRepositoryContext({ cwd: repositoryPath });
  const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
  const identity = { repositoryHost: "local", repositoryId: repository.repositoryId };
  return {
    execution_scope: {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 607 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: { readOnly: ["README.md"], write: [], create: [], delete: [], deny: [] },
    },
    candidate_working_set: {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-607-managed-readiness",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:managed-readiness", summary: "bounded bootstrap fixture" },
          evidence: [{ artifact: "test", reference: "README.md" }],
        },
      ],
    },
  };
}

function readinessCgroupFixture(
  options: {
    readonly failDelegation?: boolean;
    readonly failObservation?: boolean;
    readonly failCleanup?: boolean;
  } = {},
): {
  readonly root: string;
  readonly filesystem: CgroupFileSystem;
  readonly scopeCreateCount: number;
  readonly scopeCleanupCount: number;
  readonly activeScopeCount: number;
} {
  const root = "/sys/fs/cgroup/nawabari-621-fixture";
  const directories = new Set([root]);
  const files = new Map<string, string>([[path.join(root, "cgroup.controllers"), "cpu memory pids\n"]]);
  const scopes = new Set<string>();
  let scopeCreateCount = 0;
  let scopeCleanupCount = 0;
  const filesystem: CgroupFileSystem = {
    statSync: (file) => ({
      isDirectory: () => directories.has(file),
      isFile: () => files.has(file),
    }),
    realpathSync: (file) => {
      if (!directories.has(file)) throw new Error(`missing directory: ${file}`);
      return file;
    },
    readFileSync: (file) => {
      if (options.failObservation && scopes.has(path.dirname(file)) && path.basename(file) === "cgroup.events") {
        throw new Error("cgroup population observation unavailable");
      }
      const value = files.get(file);
      if (value === undefined) throw new Error(`missing file: ${file}`);
      return value;
    },
    writeFileSync: (file, value) => {
      if (options.failDelegation && path.basename(file) === "cgroup.subtree_control") {
        throw new Error("cgroup delegation unavailable");
      }
      files.set(file, value);
    },
    mkdirSync: (file) => {
      if (directories.has(file)) throw Object.assign(new Error(`already exists: ${file}`), { code: "EEXIST" });
      if (!directories.has(path.dirname(file))) throw new Error(`missing parent: ${file}`);
      directories.add(file);
      if (path.basename(file) === "nawabari") {
        files.set(path.join(file, "cgroup.subtree_control"), "");
      } else if (path.basename(file).startsWith("nawabari-")) {
        scopeCreateCount += 1;
        scopes.add(file);
        files.set(path.join(file, "cgroup.events"), "populated 0\n");
        files.set(path.join(file, "cgroup.procs"), "");
      }
    },
    rmdirSync: (file) => {
      if (scopes.has(file)) {
        scopeCleanupCount += 1;
        if (options.failCleanup) throw new Error("cgroup scope cleanup unavailable");
        scopes.delete(file);
        for (const candidate of files.keys()) {
          if (candidate.startsWith(`${file}${path.sep}`)) files.delete(candidate);
        }
      }
      directories.delete(file);
    },
  };
  return {
    root,
    filesystem,
    get scopeCreateCount() {
      return scopeCreateCount;
    },
    get scopeCleanupCount() {
      return scopeCleanupCount;
    },
    get activeScopeCount() {
      return [...scopes].filter((scope) => directories.has(scope)).length;
    },
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The directory cleanup below is sufficient when Git never created it.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

async function runJsonCli<T>(cwd: string, args: readonly string[]): Promise<T> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([...args, "--json"], {
    cwd,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  });
  assert.equal(exitCode, 0, stderr.join("\n"));
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0]) as T;
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
