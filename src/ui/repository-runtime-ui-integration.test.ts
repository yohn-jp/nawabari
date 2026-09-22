import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryRuntimeUiModel, runCli } from "../cli.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import type { RepositoryRegistryView } from "../session-registry.js";
import { success } from "../domain/errors.js";
import type { SessionBackend } from "../domain/session.js";
import type { SessionRecord } from "../domain/session.js";

test("CLI UI model consumes the canonical runtime snapshot and preserves its token", async () => {
  const registry: RepositoryRegistryView = {
    repositoryId: "repo-1",
    registrySchemaVersion: 2,
    registryRevision: 7,
    runtimeEpoch: 3,
    claimSetGeneration: 2,
    sessions: [],
    claims: [],
    runtimeRecords: { requiredFeatures: [], records: {} },
  };
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    registry,
    captured_at: "2026-01-02T03:04:05.006Z",
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const backend = { repositoryRuntimeSnapshot: async () => success(snapshot.value) } as unknown as SessionBackend;
  const model = await repositoryRuntimeUiModel({ backend, cwd: "/tmp/repo" });
  assert.equal(model.ok, true);
  if (!model.ok) return;
  assert.deepEqual(JSON.parse(model.value.snapshot_token as string), {
    repository_id: "repo-1",
    registry_revision: 7,
    runtime_epoch: 3,
    claim_set_generation: 2,
  });
  assert.deepEqual(model.value.sessions, []);
  assert.equal(model.value.truncated, true);
});

test("CLI action route delegates typed dispatch without executing command metadata", async () => {
  const session: SessionRecord = {
    schema_version: 1,
    session_id: "0190f1e0-0000-7000-8000-000000000001",
    repository: "/tmp/repository",
    worktree: "/tmp/worktree",
    branch: "feature/demo",
    state: "active",
    created_at: "2026-01-02T03:04:05.006Z",
    updated_at: "2026-01-02T03:04:05.006Z",
  };
  let dispatched = false;
  const backend = {
    getSession: async () => success(session),
    sessionActions: () => ({
      dispatchSessionAction: async (actionId: string) => {
        dispatched = true;
        assert.equal(actionId, "retain-session");
        return success({ action_id: "retain-session", status: "observed", token: {}, diagnostic: {} } as never);
      },
    }),
  } as unknown as SessionBackend;
  const output: string[] = [];
  const code = await runCli(
    [
      "--json",
      "session",
      "action",
      "--session",
      session.session_id,
      "--action",
      "retain-session",
      "--token",
      JSON.stringify({ schema_version: 1 }),
    ],
    { backend, cwd: "/tmp/repository", io: { stdout: (line) => output.push(line), stderr: () => undefined } },
  );
  assert.equal(code, 0);
  assert.equal(dispatched, true);
  assert.equal(output.join("").includes("session inspect"), false);
});

test("root ui routes the canonical snapshot reader through the bounded non-TTY terminal", async () => {
  const registry: RepositoryRegistryView = {
    repositoryId: "repo-ui",
    registrySchemaVersion: 2,
    registryRevision: 11,
    runtimeEpoch: 4,
    claimSetGeneration: 8,
    sessions: [],
    claims: [],
    runtimeRecords: { requiredFeatures: [], records: {} },
  };
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    registry,
    captured_at: "2026-01-02T03:04:05.006Z",
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const output: string[] = [];
  const code = await runCli(["--json", "ui"], {
    backend: { repositoryRuntimeSnapshot: async () => success(snapshot.value) } as unknown as SessionBackend,
    cwd: "/tmp/repository",
    io: { stdout: (line) => output.push(line), stderr: () => undefined },
  });
  assert.equal(code, 0);
  const rendered = JSON.parse(output.join("")) as Record<string, unknown>;
  assert.equal(rendered.ui, "repository");
  assert.equal(rendered.interactive, false);
  assert.equal(typeof rendered.snapshot_token, "string");
});
