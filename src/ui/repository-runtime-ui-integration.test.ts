import assert from "node:assert/strict";
import { test } from "node:test";
import { repositoryRuntimeUiModel } from "../cli.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import type { RepositoryRegistryView } from "../session-registry.js";
import { success } from "../domain/errors.js";
import type { SessionBackend } from "../domain/session.js";

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
  assert.equal(model.value.snapshot_token, "7:2");
  assert.deepEqual(model.value.sessions, []);
  assert.equal(model.value.truncated, true);
});
