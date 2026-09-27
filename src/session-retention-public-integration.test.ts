import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "./cli.js";
import { registerRepositoryLocator, repositoryKey } from "./control-repositories.js";
import { CONTROL_SERVER_HOST, CONTROL_TOKEN_HEADER, startControlServer, type ControlServer } from "./control-server.js";
import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import type { ImplementationExecutionScopeResolver } from "./domain/implementation-execution-scope-resolver.js";
import { LocalSessionBackend } from "./domain/session-backend.js";
import {
  reserveExecution,
  recordExecutionState,
  toPersistedSessionExecutionRecord,
} from "./domain/session-execution-record.js";
import { pinWorktreeProfile } from "./domain/worktree-profile-pinning.js";
import { resolveBuiltinWorktreeProfile } from "./domain/worktree-profile-builtins.js";
import { resolveWorktreeProfile } from "./domain/worktree-profile-catalog.js";
import { REGISTRY_FEATURES } from "./registry/runtime-records.js";
import { SessionRegistry } from "./session-registry.js";
import type { SessionActionIdentity, SessionActionToken } from "./domain/session-actions.js";
import type { SessionDiagnostic } from "./domain/session.js";
import { digestWorkingSetArtifact, type ImplementationExecutionScopeArtifact } from "./working-set.js";

type HttpResponse = { readonly status: number; readonly text: string; readonly body: unknown };
type HttpServer = ControlServer & { readonly token: string };

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function at(value: unknown, ...keys: readonly (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current as Record<string | number, unknown> | undefined)?.[key],
    value,
  );
}

function controlledCgroupFilesystem(): CgroupFileSystem {
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

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The cleanup below remains safe when the worktree was not created.
  }
}

function createFixture(): {
  readonly root: string;
  readonly repositoryPath: string;
  readonly otherWorktreePath: string;
  readonly cgroupFilesystem: CgroupFileSystem;
  readonly session: ReturnType<SessionRegistry["provision"]>;
  readonly executionScope: ImplementationExecutionScopeArtifact;
  readonly otherRegistry: SessionRegistry;
  readonly otherSession: ReturnType<SessionRegistry["create"]>;
  readonly cleanup: () => void;
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-retention-public-")));
  const repositoryPath = path.join(root, "repo");
  const targetWorktreePath = path.join(root, "target");
  const otherWorktreePath = path.join(root, "other");
  fs.mkdirSync(repositoryPath);
  const cgroupFilesystem = controlledCgroupFilesystem();
  let targetCreated = false;

  try {
    runGit(["init", "--quiet", "-b", "main"], repositoryPath);
    runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
    runGit(["config", "user.email", "tests@example.invalid"], repositoryPath);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "retention fixture\n");
    runGit(["add", "README.md"], repositoryPath);
    runGit(["commit", "--quiet", "-m", "initial"], repositoryPath);

    const builtin = resolveBuiltinWorktreeProfile({ profile: "minimal" });
    if (!builtin.ok) throw builtin.error;
    const profile = {
      ...builtin.value,
      id: "retention-public-test",
      extends: [],
      filesystem: {
        ...builtin.value.filesystem,
        readOnly: ["README.md"],
        write: ["README.md"],
        create: [],
        delete: [],
        deny: [],
        immutable: [],
      },
    };
    fs.writeFileSync(
      path.join(repositoryPath, "nawabari.profiles.json"),
      `${JSON.stringify({ profiles: [profile] })}\n`,
    );
    runGit(["add", "nawabari.profiles.json"], repositoryPath);
    runGit(["commit", "--quiet", "-m", "test: add retention profile"], repositoryPath);

    const repository = new SessionRegistry({
      cwd: repositoryPath,
      cgroupFilesystem,
      managedExecutionReadiness: () => ({ ready: true }),
    });
    const revision = runGit(["rev-parse", "HEAD"], repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: repository.repository.repositoryId };
    const executionScope: ImplementationExecutionScopeArtifact = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 700 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: { readOnly: ["README.md"], write: ["README.md"], create: [], delete: [], deny: [] },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-retention-public-test",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:retention", summary: "exercise retained ownership" },
          evidence: [{ artifact: "test", reference: "README.md" }],
        },
      ],
    };
    const session = repository.provision({
      branchName: "feature/retention-public-target",
      worktreePath: targetWorktreePath,
      claimEnforcement: true,
      initialClaims: [{ resource: "README.md", mode: "exclusive-write" }],
      executionScope,
      candidateWorkingSet,
    });
    targetCreated = true;

    const resolvedProfile = resolveWorktreeProfile({ profile: profile.id }, { profiles: [profile] });
    if (!resolvedProfile.ok) throw resolvedProfile.error;
    if (session.baseRevision === undefined) throw new Error("Target session has no base revision");
    const pinnedProfile = pinWorktreeProfile(resolvedProfile.value, {
      repository: { id: repository.repository.repositoryId, revision: session.baseRevision },
      base: { revision: session.baseRevision },
      catalog: {
        kind: "repository",
        path: "nawabari.profiles.json",
        blob_oid: runGit(["rev-parse", `${session.baseRevision}:nawabari.profiles.json`], repositoryPath),
      },
      selection: { profile: profile.id, parameters: {} },
    });
    installControlledPinAndAdmission(repository, session.sessionId, pinnedProfile);
    seedExitedExecution(repository, session.sessionId, pinnedProfile.digest);

    runGit(["worktree", "add", "--quiet", "-b", "feature/retention-public-other", otherWorktreePath], repositoryPath);
    const otherRegistry = new SessionRegistry({ cwd: otherWorktreePath, cgroupFilesystem });
    const otherSession = otherRegistry.create();

    return {
      root,
      repositoryPath,
      otherWorktreePath,
      cgroupFilesystem,
      session,
      executionScope,
      otherRegistry,
      otherSession,
      cleanup(): void {
        removeWorktree(repositoryPath, targetWorktreePath);
        removeWorktree(repositoryPath, otherWorktreePath);
        fs.rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    if (targetCreated) removeWorktree(repositoryPath, targetWorktreePath);
    removeWorktree(repositoryPath, otherWorktreePath);
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function installControlledPinAndAdmission(
  registry: SessionRegistry,
  sessionId: string,
  pinnedProfile: ReturnType<typeof pinWorktreeProfile>,
): void {
  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const currentFeatures = Array.isArray(persisted.required_features)
    ? persisted.required_features.filter((value): value is string => typeof value === "string")
    : [];
  const requiredFeatures = [...new Set([...currentFeatures, "pinned-profiles.v1", "runtime-sessions.v1"])].sort(
    (left, right) =>
      REGISTRY_FEATURES.indexOf(left as (typeof REGISTRY_FEATURES)[number]) -
      REGISTRY_FEATURES.indexOf(right as (typeof REGISTRY_FEATURES)[number]),
  );
  const pinnedProfiles = Array.isArray(persisted.pinned_profiles) ? persisted.pinned_profiles : [];
  const runtimeSessions = Array.isArray(persisted.runtime_sessions) ? persisted.runtime_sessions : [];
  fs.writeFileSync(
    registry.paths.registry,
    `${JSON.stringify(
      {
        ...persisted,
        required_features: requiredFeatures,
        pinned_profiles: [...pinnedProfiles, { ...pinnedProfile, session_id: sessionId }],
        runtime_sessions: [
          ...runtimeSessions,
          {
            kind: "session-admission",
            schema_version: 1,
            session_id: sessionId,
            admission: "open",
            runtime_epoch: persisted.runtime_epoch,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function seedExitedExecution(registry: SessionRegistry, sessionId: string, profileDigest: string): void {
  const runtime = registry.getSessionManagedRuntime(sessionId);
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const reserved = reserveExecution({
    session_id: sessionId,
    execution_id: "retention-public-exited-execution",
    cgroup_root: "/sys/fs/cgroup/user.slice/nawabari-retention-public-test.scope",
    profile_digest: profileDigest,
    filesystem_token: "a".repeat(64),
    runtime_epoch: runtime.runtime_epoch,
    boot_id: bootId,
    now: "2026-09-27T00:00:00.000Z",
  });
  if (!reserved.ok) throw reserved.error;
  registry.persistSessionExecution(toPersistedSessionExecutionRecord(reserved.value));
  const exited = recordExecutionState(reserved.value, { state: "exited", now: "2026-09-27T00:00:01.000Z" });
  if (!exited.ok) throw exited.error;
  registry.transitionSessionExecution(
    exited.value.execution_id,
    { state: "exited", now: exited.value.updated_at },
    toPersistedSessionExecutionRecord(exited.value),
  );
}

async function actionToken(
  backend: LocalSessionBackend,
  cwd: string,
  sessionId: string,
): Promise<{
  readonly identity: SessionActionIdentity;
  readonly token: SessionActionToken;
  readonly diagnostic: SessionDiagnostic;
}> {
  const session = await backend.getSession({ cwd }, sessionId);
  if (!session.ok) throw new Error(session.error.message);
  const identity: SessionActionIdentity = {
    session_id: session.value.session_id,
    repository: session.value.repository,
    worktree: session.value.worktree,
  };
  const snapshot = await backend.sessionActions({ cwd }).readSessionActionSnapshot(identity);
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  return { identity, token: snapshot.value.token, diagnostic: snapshot.value.diagnostic };
}

function request(
  server: Pick<HttpServer, "port" | "token">,
  pathname: string,
  options: { readonly method?: string; readonly body?: unknown; readonly authenticate?: boolean } = {},
): Promise<HttpResponse> {
  const headers: Record<string, string> = {
    host: `${CONTROL_SERVER_HOST}:${server.port}`,
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.method === "POST" ? { origin: `http://${CONTROL_SERVER_HOST}:${server.port}` } : {}),
    ...(options.authenticate === false ? {} : { [CONTROL_TOKEN_HEADER]: server.token }),
  };
  return new Promise((resolve, reject) => {
    const client = http.request(
      { host: CONTROL_SERVER_HOST, port: server.port, path: pathname, method: options.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = {};
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            // Keep the raw response text for assertion failures.
          }
          resolve({ status: response.statusCode ?? 0, text, body });
        });
      },
    );
    client.on("error", reject);
    if (options.body !== undefined) client.write(JSON.stringify(options.body));
    client.end();
  });
}

async function controlToken(server: HttpServer, key: string, sessionId: string): Promise<SessionActionToken> {
  const result = await request(server, `/api/v1/repositories/${key}/sessions/${sessionId}`);
  assert.equal(result.status, 200, result.text);
  return at(result.body, "action_snapshot", "token") as SessionActionToken;
}

function postAction(
  server: HttpServer,
  key: string,
  sessionId: string,
  actionId: "park-session" | "resume-session",
  token: SessionActionToken,
  operationId: string,
): Promise<HttpResponse> {
  return request(server, `/api/v1/repositories/${key}/sessions/${sessionId}/actions`, {
    method: "POST",
    body: { action_id: actionId, token, confirmation: { confirmed: true, operation_id: operationId } },
  });
}

test("CLI park survives backend restart and authenticated HTTP resume revalidates scope and claims", async () => {
  const fixture = createFixture();
  let server: HttpServer | undefined;
  try {
    const context = { cwd: fixture.repositoryPath };
    const initialBackend = new LocalSessionBackend({
      registry: { cgroupFilesystem: fixture.cgroupFilesystem },
      managedExecutionReadiness: () => ({ ready: true }),
    });
    const park = await actionToken(initialBackend, context.cwd, fixture.session.sessionId);
    assert.ok(
      park.diagnostic.park_resume_actions?.some((action) => action.actionId === "park-session"),
      JSON.stringify({
        lifecycle: park.diagnostic.lifecycle,
        physical_state: park.diagnostic.physical_state,
        blockers: park.diagnostic.blockers,
      }),
    );
    const output: string[] = [];
    const parkExitCode = await runCli(
      [
        "--json",
        "session",
        "action",
        "--session",
        fixture.session.sessionId,
        "--action",
        "park-session",
        "--token",
        JSON.stringify(park.token),
        "--confirm",
        "--operation-id",
        "retention-public-park-retry",
      ],
      {
        cwd: context.cwd,
        backend: initialBackend,
        io: { stdout: (line) => output.push(line), stderr: () => undefined },
      },
    );
    assert.equal(parkExitCode, 0, output.join("\n"));
    assert.equal(JSON.parse(output[0] ?? "{}").result.status, "parked");
    assert.equal(JSON.parse(output[0] ?? "{}").result.operationId, "retention-public-park-retry");

    const unconfiguredBackend = new LocalSessionBackend({
      registry: { cgroupFilesystem: fixture.cgroupFilesystem },
      managedExecutionReadiness: () => ({ ready: true }),
    });
    const unavailableToken = await actionToken(unconfiguredBackend, context.cwd, fixture.session.sessionId);
    const unavailableOutput: string[] = [];
    const unavailableExitCode = await runCli(
      [
        "--json",
        "session",
        "action",
        "--session",
        fixture.session.sessionId,
        "--action",
        "resume-session",
        "--token",
        JSON.stringify(unavailableToken.token),
        "--confirm",
      ],
      {
        cwd: context.cwd,
        backend: unconfiguredBackend,
        io: { stdout: (line) => unavailableOutput.push(line), stderr: () => undefined },
      },
    );
    assert.equal(unavailableExitCode, 4, unavailableOutput.join("\n"));
    const unavailableBody = JSON.parse(unavailableOutput[0] ?? "{}");
    assert.equal(unavailableBody.code, "BACKEND_UNAVAILABLE");
    const afterUnavailable = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    assert.equal(afterUnavailable.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(afterUnavailable.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(afterUnavailable.readRepositoryView().runtimeRecords.records.retentions?.length, 1);

    let latestScope: ImplementationExecutionScopeArtifact = fixture.executionScope;
    const resolutionRequests: Parameters<ImplementationExecutionScopeResolver["resolveLatest"]>[0][] = [];
    const resolver: ImplementationExecutionScopeResolver = {
      async resolveLatest(input) {
        resolutionRequests.push(input);
        return { status: "resolved", artifact: latestScope };
      },
    };
    const catalogPath = path.join(fixture.root, "control-repositories.json");
    const registered = registerRepositoryLocator(catalogPath, context.cwd);
    assert.equal(registered.ok, true, registered.ok ? "" : registered.error.message);
    assert.ok(registered.ok && registered.value !== null);
    const resumedBackend = new LocalSessionBackend({
      registry: { cgroupFilesystem: fixture.cgroupFilesystem },
      managedExecutionReadiness: () => ({ ready: true }),
      implementationExecutionScopeResolver: resolver,
    });
    const started = await startControlServer({
      port: 0,
      backend: resumedBackend,
      catalogPath,
      operationalDirectory: path.join(fixture.root, "control-server-operations"),
    });
    if (!started.ok) throw started.error;
    server = {
      ...started.value,
      token: fs.readFileSync(started.value.credentialFile, "utf8").trim(),
    };

    const key = repositoryKey(fixture.session.repositoryId);
    fixture.otherRegistry.claimResources({
      sessionId: fixture.otherSession.sessionId,
      claims: [{ resource: "README.md", mode: "exclusive-write" }],
    });
    const beforeClaimConflict = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    const conflictSnapshot = beforeClaimConflict.readRepositoryView();
    const conflictToken = await controlToken(server, key, fixture.session.sessionId);
    const conflict = await postAction(
      server,
      key,
      fixture.session.sessionId,
      "resume-session",
      conflictToken,
      "retention-public-resume-retry",
    );
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(at(conflict.body, "error", "code"), "RESOURCE_CLAIM_CONFLICT");
    assert.equal(at(conflict.body, "error", "details", "retention_code"), "CLAIM_CONFLICT");
    const afterClaimConflict = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    const conflictAfter = afterClaimConflict.readRepositoryView();
    assert.equal(afterClaimConflict.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(afterClaimConflict.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(conflictAfter.runtimeRecords.records.retentions?.length, 1);
    assert.equal(conflictAfter.claimSetGeneration, conflictSnapshot.claimSetGeneration);
    assert.equal(conflictAfter.registryRevision, conflictSnapshot.registryRevision);

    fixture.otherRegistry.releaseClaims({
      sessionId: fixture.otherSession.sessionId,
      resources: ["README.md"],
      expectedClaimSetGeneration: fixture.otherRegistry.readRepositoryView().claimSetGeneration,
    });
    latestScope = {
      ...fixture.executionScope,
      scope: { readOnly: ["README.md"], write: [], create: [], delete: [], deny: [] },
    };
    const narrowedArtifactDigest = digestWorkingSetArtifact(latestScope);
    const beforeScopeRejection = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    const scopeBefore = beforeScopeRejection.readRepositoryView();
    const scopeToken = await controlToken(server, key, fixture.session.sessionId);
    const denied = await postAction(
      server,
      key,
      fixture.session.sessionId,
      "resume-session",
      scopeToken,
      "retention-public-resume-retry",
    );
    assert.equal(denied.status, 409, denied.text);
    assert.equal(at(denied.body, "error", "code"), "OPERATION_REJECTED");
    assert.equal(at(denied.body, "error", "details", "retention_code"), "EXTERNAL_SCOPE_REJECTED");
    assert.notEqual(narrowedArtifactDigest, resolutionRequests[1]?.source.digest);
    const afterScopeRejection = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    const scopeAfter = afterScopeRejection.readRepositoryView();
    assert.equal(afterScopeRejection.get(fixture.session.sessionId)?.state, "parked");
    assert.equal(afterScopeRejection.listClaims(fixture.session.sessionId).length, 0);
    assert.equal(scopeAfter.runtimeRecords.records.retentions?.length, 1);
    assert.equal(scopeAfter.claimSetGeneration, scopeBefore.claimSetGeneration);
    assert.equal(scopeAfter.registryRevision, scopeBefore.registryRevision);

    latestScope = fixture.executionScope;
    const resumeToken = await controlToken(server, key, fixture.session.sessionId);
    const resumed = await postAction(
      server,
      key,
      fixture.session.sessionId,
      "resume-session",
      resumeToken,
      "retention-public-resume-retry",
    );
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(at(resumed.body, "result", "action_id"), "resume-session");
    assert.equal(at(resumed.body, "result", "result", "status"), "resumed");
    assert.equal(at(resumed.body, "result", "result", "operationId"), "retention-public-resume-retry");

    const finalRegistry = new SessionRegistry({ cwd: context.cwd, cgroupFilesystem: fixture.cgroupFilesystem });
    assert.equal(finalRegistry.get(fixture.session.sessionId)?.state, "active");
    assert.deepEqual(
      finalRegistry.listClaims(fixture.session.sessionId).map(({ resource, mode }) => ({ resource, mode })),
      [{ resource: "README.md", mode: "exclusive-write" }],
    );
    assert.deepEqual(
      finalRegistry.listClaims(fixture.otherSession.sessionId).map(({ resource }) => resource),
      [],
    );
    assert.equal(finalRegistry.readRepositoryView().runtimeRecords.records.retentions?.length ?? 0, 0);
    assert.equal(resolutionRequests.length, 3);
    for (const input of resolutionRequests) {
      assert.equal(input.source.producer?.repositoryHost, "local");
      assert.equal(input.source.producer?.repositoryId, fixture.session.repositoryId);
      assert.equal(input.source.producer?.number, 700);
      assert.equal(input.source.identity, "b".repeat(64));
      assert.match(input.source.digest, /^[a-f0-9]{64}$/u);
    }
  } finally {
    if (server !== undefined) await server.close();
    fixture.cleanup();
  }
});
