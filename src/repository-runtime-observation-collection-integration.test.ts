import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { repositoryRuntimeUiModel } from "./cli.js";
import { registerRepositoryLocator, repositoryKey } from "./control-repositories.js";
import { CONTROL_SERVER_HOST, CONTROL_TOKEN_HEADER, startControlServer, type ControlServer } from "./control-server.js";
import type { DomainResult } from "./domain/errors.js";
import { createLocalSessionBackend } from "./domain/session-backend.js";
import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
} from "./domain/session-execution-record.js";
import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import { builtinWorktreeProfileRevision, pinWorktreeProfile } from "./domain/worktree-profile-pinning.js";
import { resolveBuiltinWorktreeProfile } from "./domain/worktree-profile-builtins.js";
import { parseRepositoryRuntimeObservations } from "./repository-runtime-observations.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import { REGISTRY_FEATURES } from "./registry/runtime-records.js";
import { parkSession } from "./session-retention.js";
import { SessionRegistry } from "./session-registry.js";
import type { RepositoryScreenModel } from "./ui/repository-screen.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const FIXED_TIME = new Date("2026-09-27T00:00:00.000Z");
type TestControlServer = ControlServer & { readonly token: string };

test(
  "real backend collection reobserves worktree changes and preserves parked state without mutation",
  { skip: fs.existsSync(BOOT_ID_PATH) ? false : "canonical parked fixture requires Linux boot identity" },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-r5-observation-integration-"));
    const repositoryPath = path.join(root, "repository");
    const activeWorktreePath = path.join(root, "active-worktree");
    const parkedWorktreePath = path.join(root, "parked-worktree");
    const cgroupFilesystem = emptyCgroupFilesystem();
    let controlServer: TestControlServer | undefined;

    try {
      fs.mkdirSync(repositoryPath, { recursive: true });
      runGit(["init", "-b", "main"], repositoryPath);
      runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
      runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
      fs.writeFileSync(path.join(repositoryPath, "README.md"), "R5 observation integration fixture\n");
      runGit(["add", "README.md"], repositoryPath);
      runGit(["commit", "-m", "test: seed repository observation integration"], repositoryPath);

      const registry = new SessionRegistry({
        cwd: repositoryPath,
        cgroupFilesystem,
        clock: () => new Date(FIXED_TIME),
      });
      const active = registry.provision({ branchName: "feature/observation-active", worktreePath: activeWorktreePath });
      const parked = registry.provision({ branchName: "feature/observation-parked", worktreePath: parkedWorktreePath });
      const baseRevision = active.baseRevision;
      assert.ok(baseRevision);
      assert.equal(parked.baseRevision, baseRevision);

      const builtin = resolveBuiltinWorktreeProfile({ profile: "minimal" });
      if (!builtin.ok) throw builtin.error;
      const profile = pinWorktreeProfile(builtin.value, {
        repository: { id: registry.repository.repositoryId, revision: baseRevision },
        base: { revision: baseRevision },
        catalog: {
          kind: "builtin",
          id: "minimal",
          revision: builtinWorktreeProfileRevision("minimal"),
        },
        selection: { profile: "minimal", parameters: {} },
      });
      persistProfilePins(registry, [active.sessionId, parked.sessionId], profile);

      seedExitedExecution(registry, parked.sessionId, profile.digest);
      const parkedResult = parkSession(registry, {
        sessionId: parked.sessionId,
        pinnedProfile: profile,
        operationId: "r5-observation-integration-park",
        now: FIXED_TIME.toISOString(),
      });
      assert.equal(parkedResult.status, "parked");
      assert.equal(registry.get(parked.sessionId)?.state, "parked");

      const backend = createLocalSessionBackend({
        registry: { cgroupFilesystem },
        managedExecutionReadiness: () => ({ ready: false }),
      });
      const controlCatalogPath = path.join(root, "control-repositories.json");
      const locator = registerRepositoryLocator(controlCatalogPath, repositoryPath);
      assert.equal(locator.ok, true, locator.ok ? "" : locator.error.message);
      assert.ok(locator.ok && locator.value !== null);
      const controlKey = repositoryKey(locator.value.repository_id);
      const initialCanonicalState = captureCanonicalState(registry, [
        repositoryPath,
        activeWorktreePath,
        parkedWorktreePath,
      ]);
      const initialResult = await backend.repositoryRuntimeSnapshot?.({ cwd: repositoryPath });
      assert.ok(initialResult);
      const initialSnapshot = requireSnapshot(initialResult);
      const initialParsed = assertSnapshotContracts(initialSnapshot);
      const initialRevision = initialSnapshot.registry.revision;
      const activeLifecycleBefore = initialParsed.lifecycle.get(active.sessionId);
      assert.ok(activeLifecycleBefore);
      const parkedLifecycle = initialParsed.lifecycle.get(parked.sessionId);
      assert.ok(parkedLifecycle);
      assert.equal(parkedLifecycle.state, "parked");
      assert.deepEqual(
        captureCanonicalState(registry, [repositoryPath, activeWorktreePath, parkedWorktreePath]),
        initialCanonicalState,
      );

      const initialUiResult = await repositoryRuntimeUiModel({ backend, cwd: repositoryPath });
      if (!initialUiResult.ok) throw initialUiResult.error;
      assert.equal(initialUiResult.value.snapshot_token, snapshotToken(initialSnapshot));
      assertExplicitCoordinationUnavailable(initialUiResult.value);

      controlServer = await startSnapshotServer(root, backend, controlCatalogPath);
      const unauthenticated = await callSnapshot(controlServer, `/api/v1/repositories/${controlKey}/snapshot`, null);
      assert.equal(unauthenticated.status, 401);
      const initialHttp = await callSnapshot(controlServer, `/api/v1/repositories/${controlKey}/snapshot`);
      assert.equal(initialHttp.status, 200, JSON.stringify(initialHttp.body));
      const initialHttpSnapshot = responseSnapshot(initialHttp.body);
      const initialHttpView = responseView(initialHttp.body);
      assert.equal(initialHttpSnapshot.contract_id, initialSnapshot.contract_id);
      assert.equal(initialHttpSnapshot.repository_id, initialSnapshot.repository_id);
      assert.equal(initialHttpSnapshot.registry.revision, initialSnapshot.registry.revision);
      assert.equal(initialHttpSnapshot.observations.coordination.status, "available");
      if (initialHttpSnapshot.observations.coordination.status === "available") {
        const rawCoordination = initialHttpSnapshot.observations.coordination.value as Record<string, unknown>;
        assert.equal(rawCoordination.schemaVersion, 1);
        assert.equal(rawCoordination.complete, false, "the raw source's incomplete status remains explicit");
      }
      assert.equal(initialHttpView.snapshot_token, initialUiResult.value.snapshot_token);
      assert.deepEqual(
        initialHttpView,
        initialUiResult.value,
        "HTTP and CLI/TUI must project the same backend snapshot",
      );
      assertExplicitCoordinationUnavailable(initialHttpView);
      assert.deepEqual(
        captureCanonicalState(registry, [repositoryPath, activeWorktreePath, parkedWorktreePath]),
        initialCanonicalState,
      );

      const revisionBeforeWorktreeChange = registry.readRepositoryView().registryRevision;
      fs.writeFileSync(path.join(activeWorktreePath, "new-worktree-evidence.txt"), "fresh physical evidence\n");
      const changedCanonicalState = captureCanonicalState(registry, [
        repositoryPath,
        activeWorktreePath,
        parkedWorktreePath,
      ]);
      const changedResult = await backend.repositoryRuntimeSnapshot?.({ cwd: repositoryPath });
      assert.ok(changedResult);
      const changedSnapshot = requireSnapshot(changedResult);
      const changedParsed = assertSnapshotContracts(changedSnapshot);
      assert.equal(changedSnapshot.registry.revision, revisionBeforeWorktreeChange);
      const activeLifecycleAfter = changedParsed.lifecycle.get(active.sessionId);
      assert.ok(activeLifecycleAfter);
      assert.equal(activeLifecycleAfter.recoverable_work, "present");
      assert.notDeepEqual(activeLifecycleAfter, activeLifecycleBefore);
      assert.equal(changedParsed.processes.get(active.sessionId)?.status, "unknown");
      assert.deepEqual(
        captureCanonicalState(registry, [repositoryPath, activeWorktreePath, parkedWorktreePath]),
        changedCanonicalState,
      );

      const changedUiResult = await repositoryRuntimeUiModel({ backend, cwd: repositoryPath });
      if (!changedUiResult.ok) throw changedUiResult.error;
      assert.equal(changedUiResult.value.snapshot_token, snapshotToken(changedSnapshot));
      assertExplicitCoordinationUnavailable(changedUiResult.value);
      const changedHttp = await callSnapshot(controlServer, `/api/v1/repositories/${controlKey}/snapshot`);
      assert.equal(changedHttp.status, 200, JSON.stringify(changedHttp.body));
      const changedHttpSnapshot = responseSnapshot(changedHttp.body);
      const changedHttpView = responseView(changedHttp.body);
      const changedHttpParsed = assertSnapshotContracts(changedHttpSnapshot);
      assert.equal(changedHttpSnapshot.registry.revision, revisionBeforeWorktreeChange);
      assert.equal(changedHttpParsed.lifecycle.get(active.sessionId)?.recoverable_work, "present");
      assert.equal(changedHttpParsed.lifecycle.get(parked.sessionId)?.state, "parked");
      assert.equal(changedHttpView.snapshot_token, changedUiResult.value.snapshot_token);
      assert.deepEqual(
        changedHttpView,
        changedUiResult.value,
        "HTTP and CLI/TUI must project the same changed evidence",
      );
      assertExplicitCoordinationUnavailable(changedHttpView);
      assert.deepEqual(
        captureCanonicalState(registry, [repositoryPath, activeWorktreePath, parkedWorktreePath]),
        changedCanonicalState,
      );

      await new Promise((resolve) => setTimeout(resolve, 10));
      const restartedBackend = createLocalSessionBackend({
        registry: { cgroupFilesystem },
        managedExecutionReadiness: () => ({ ready: false }),
      });
      const priorControlToken = controlServer.token;
      await controlServer.close();
      controlServer = await startSnapshotServer(root, restartedBackend, controlCatalogPath);
      assert.notEqual(controlServer.token, priorControlToken);
      const restartedResult = await restartedBackend.repositoryRuntimeSnapshot?.({ cwd: repositoryPath });
      assert.ok(restartedResult);
      const restartedSnapshot = requireSnapshot(restartedResult);
      const restartedParsed = assertSnapshotContracts(restartedSnapshot);
      assert.equal(restartedSnapshot.registry.revision, revisionBeforeWorktreeChange);
      assert.equal(restartedParsed.lifecycle.get(active.sessionId)?.recoverable_work, "present");
      assert.equal(restartedParsed.lifecycle.get(parked.sessionId)?.state, "parked");
      assert.notEqual(restartedSnapshot.captured_at, changedSnapshot.captured_at);
      const restartedUiResult = await repositoryRuntimeUiModel({ backend: restartedBackend, cwd: repositoryPath });
      if (!restartedUiResult.ok) throw restartedUiResult.error;
      assert.equal(restartedUiResult.value.snapshot_token, snapshotToken(restartedSnapshot));
      assertExplicitCoordinationUnavailable(restartedUiResult.value);
      const restartedHttp = await callSnapshot(controlServer, `/api/v1/repositories/${controlKey}/snapshot`);
      assert.equal(restartedHttp.status, 200, JSON.stringify(restartedHttp.body));
      const restartedHttpSnapshot = responseSnapshot(restartedHttp.body);
      assert.notEqual(restartedHttpSnapshot.captured_at, changedHttpSnapshot.captured_at);
      assert.equal(restartedHttpSnapshot.registry.revision, revisionBeforeWorktreeChange);
      assert.equal(
        assertSnapshotContracts(restartedHttpSnapshot).lifecycle.get(active.sessionId)?.recoverable_work,
        "present",
      );
      const restartedHttpView = responseView(restartedHttp.body);
      assert.equal(assertSnapshotContracts(restartedHttpSnapshot).lifecycle.get(parked.sessionId)?.state, "parked");
      assert.deepEqual(restartedHttpView, restartedUiResult.value);
      assertExplicitCoordinationUnavailable(restartedHttpView);
      assert.deepEqual(
        captureCanonicalState(registry, [repositoryPath, activeWorktreePath, parkedWorktreePath]),
        changedCanonicalState,
      );
    } finally {
      await controlServer?.close();
      try {
        runGit(["worktree", "remove", "--force", activeWorktreePath], repositoryPath);
      } catch {
        // Temporary fixture cleanup handles partially initialized worktrees.
      }
      try {
        runGit(["worktree", "remove", "--force", parkedWorktreePath], repositoryPath);
      } catch {
        // Temporary fixture cleanup handles partially initialized worktrees.
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

function persistProfilePins(
  registry: SessionRegistry,
  sessionIds: readonly string[],
  profile: ReturnType<typeof pinWorktreeProfile>,
): void {
  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const currentFeatures = Array.isArray(persisted.required_features)
    ? persisted.required_features.filter((value): value is string => typeof value === "string")
    : [];
  const required = new Set([...currentFeatures, "pinned-profiles.v1", "runtime-sessions.v1"]);
  persisted.required_features = REGISTRY_FEATURES.filter((feature) => required.has(feature));
  persisted.pinned_profiles = sessionIds.map((session_id) => ({ ...profile, session_id }));
  const runtimeEpoch = persisted.runtime_epoch;
  assert.equal(typeof runtimeEpoch, "number");
  persisted.runtime_sessions = sessionIds.map((session_id) => ({
    kind: "session-admission",
    schema_version: 1,
    session_id,
    admission: "open",
    runtime_epoch: runtimeEpoch,
  }));
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted, null, 2)}\n`);
  registry.readRepositoryView();
}

function seedExitedExecution(registry: SessionRegistry, sessionId: string, profileDigest: string): void {
  const runtime = registry.getSessionManagedRuntime(sessionId);
  const reserved = reserveExecution({
    session_id: sessionId,
    execution_id: "r5-observation-parked-execution",
    cgroup_root: "/sys/fs/cgroup/user.slice/nawabari-r5-observation-test.scope",
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

function assertSnapshotContracts(snapshot: RepositoryRuntimeSnapshot) {
  assert.equal(snapshot.contract_id, "nawabari.repository-runtime-snapshot.v1");
  assert.equal(snapshot.schema_version, 1);
  for (const [name, observation] of Object.entries(snapshot.observations)) {
    if (observation.status === "available") {
      assert.match(observation.observed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, name);
    } else {
      assert.equal(observation.observed_at, null);
      assert.ok(observation.reason.length > 0);
      assert.equal(snapshot.complete, false);
    }
  }
  const parsed = parseRepositoryRuntimeObservations(snapshot);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function requireSnapshot(result: DomainResult<RepositoryRuntimeSnapshot>): RepositoryRuntimeSnapshot {
  if (!result.ok) throw result.error;
  return result.value;
}

async function startSnapshotServer(
  root: string,
  backend: ReturnType<typeof createLocalSessionBackend>,
  catalogPath: string,
): Promise<TestControlServer> {
  const started = await startControlServer({
    port: 0,
    backend,
    catalogPath,
    operationalDirectory: path.join(root, "control-server-operations"),
  });
  if (!started.ok) throw started.error;
  return {
    ...started.value,
    token: fs.readFileSync(started.value.credentialFile, "utf8").trim(),
  };
}

function callSnapshot(
  server: TestControlServer,
  pathname: string,
  token: string | null = server.token,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const headers: Record<string, string> = { host: `${CONTROL_SERVER_HOST}:${server.port}` };
  if (token !== null) headers[CONTROL_TOKEN_HEADER] = token;
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: CONTROL_SERVER_HOST, port: server.port, path: pathname, method: "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch (error: unknown) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function responseSnapshot(body: unknown): RepositoryRuntimeSnapshot {
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  const snapshot = (body as Record<string, unknown>).snapshot;
  assert.ok(snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot));
  return snapshot as RepositoryRuntimeSnapshot;
}

function responseView(body: unknown): RepositoryScreenModel {
  assert.ok(body !== null && typeof body === "object" && !Array.isArray(body));
  const view = (body as Record<string, unknown>).view;
  assert.ok(view !== null && typeof view === "object" && !Array.isArray(view));
  return view as RepositoryScreenModel;
}

function assertExplicitCoordinationUnavailable(model: RepositoryScreenModel): void {
  const sections = model.unavailable_sections as Record<string, unknown> | undefined;
  assert.ok(sections !== undefined);
  for (const section of ["files", "conflicts", "attention", "runtime"]) {
    const value = sections[section] as Record<string, unknown> | undefined;
    assert.equal(value?.status, "unavailable", `${section} must not infer a clean or empty result`);
  }
  assert.deepEqual(model.files, []);
  assert.deepEqual(model.conflicts, []);
}

function snapshotToken(snapshot: RepositoryRuntimeSnapshot): string {
  return JSON.stringify({
    repository_id: snapshot.repository_id,
    registry_revision: snapshot.registry.revision,
    runtime_epoch: snapshot.registry.runtime_epoch,
    claim_set_generation: snapshot.registry.claim_set_generation,
  });
}

function captureCanonicalState(registry: SessionRegistry, worktrees: readonly string[]): unknown {
  const view = registry.readRepositoryView();
  return {
    registry: fs.readFileSync(registry.paths.registry, "utf8"),
    registryDirectoryEntries: fs.readdirSync(registry.paths.directory).sort(),
    view,
    worktreeList: runGit(["worktree", "list", "--porcelain"], registry.repository.worktreePath),
    git: worktrees.map((worktree) => ({
      head: runGit(["rev-parse", "HEAD"], worktree),
      branch: runGit(["symbolic-ref", "--short", "HEAD"], worktree),
      status: runGit(["status", "--porcelain=v1", "--untracked-files=all"], worktree),
    })),
  };
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
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
  });
}
