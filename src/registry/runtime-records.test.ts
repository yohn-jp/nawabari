import assert from "node:assert/strict";
import test from "node:test";

import { SessionRegistryError } from "../errors.js";
import { BUILTIN_WORKTREE_PROFILE_IDS, resolveBuiltinWorktreeProfile } from "../domain/worktree-profile-builtins.js";
import { builtinWorktreeProfileRevision, pinWorktreeProfile } from "../domain/worktree-profile-pinning.js";
import {
  REGISTRY_FEATURES,
  SUPPORTED_REGISTRY_FEATURES,
  parseRuntimeRecords,
  toPersistedRuntimeRecords,
} from "./runtime-records.js";

test("registry optional areas are a finite feature-gated contract", () => {
  assert.deepEqual(REGISTRY_FEATURES, [
    "pinned-profiles.v1",
    "runtime-sessions.v1",
    "executions.v1",
    "retentions.v1",
    "recent-events.v1",
    "file-operations.v1",
  ]);
  assert.deepEqual(SUPPORTED_REGISTRY_FEATURES, [
    "pinned-profiles.v1",
    "runtime-sessions.v1",
    "executions.v1",
    "recent-events.v1",
  ]);
  assert.deepEqual(parseRuntimeRecords({}), { requiredFeatures: [], records: {} });
});

test("unsupported features expose bounded names without returning their payload", () => {
  const payload = { secret: "must not be copied into the error" };
  assert.throws(
    () => parseRuntimeRecords({ required_features: ["future.v1"], executions: [payload] }),
    (error: unknown) => {
      assert.ok(error instanceof SessionRegistryError);
      assert.equal(error.code, "REGISTRY_FEATURE_UNSUPPORTED");
      assert.deepEqual(error.details.unsupportedFeatures, ["future.v1"]);
      assert.equal(JSON.stringify(error.details).includes("must not be copied"), false);
      return true;
    },
  );
});

test("supported feature records require matching presence and round-trip as bounded JSON", () => {
  const profileId = BUILTIN_WORKTREE_PROFILE_IDS[0];
  assert.ok(profileId);
  const resolved = resolveBuiltinWorktreeProfile({ profile: profileId }, {});
  assert.ok(resolved.ok);
  const pinnedProfile = {
    ...pinWorktreeProfile(resolved.value, {
      repository: { id: "repo", revision: "a".repeat(40) },
      base: { revision: "a".repeat(40) },
      catalog: { kind: "builtin", id: profileId, revision: builtinWorktreeProfileRevision(profileId) },
      selection: { profile: profileId, parameters: {} },
    }),
    session_id: "session-1",
  };
  const parsed = parseRuntimeRecords(
    {
      required_features: ["pinned-profiles.v1", "executions.v1", "runtime-sessions.v1"],
      pinned_profiles: [pinnedProfile],
      executions: [{ execution_id: "exec-1", state: "starting" }],
      runtime_sessions: [
        {
          kind: "session-admission",
          schema_version: 1,
          session_id: "session-1",
          admission: "open",
          runtime_epoch: 0,
        },
      ],
    },
    SUPPORTED_REGISTRY_FEATURES,
  );
  assert.deepEqual(toPersistedRuntimeRecords(parsed), {
    pinned_profiles: [pinnedProfile],
    executions: [{ execution_id: "exec-1", state: "starting" }],
    runtime_sessions: [
      {
        kind: "session-admission",
        schema_version: 1,
        session_id: "session-1",
        admission: "open",
        runtime_epoch: 0,
      },
    ],
  });
});

test("feature presence without a matching gate fails closed", () => {
  assert.throws(
    () => parseRuntimeRecords({ executions: [] }, ["executions.v1"]),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
  );
});

test("runtime admission records reject unknown shape, invalid epochs, and duplicate owners", () => {
  const admission = {
    kind: "session-admission",
    schema_version: 1,
    session_id: "session-1",
    admission: "open",
    runtime_epoch: 0,
  };
  for (const invalid of [
    { ...admission, extra: true },
    { ...admission, kind: "future-admission" },
    { ...admission, schema_version: 2 },
    { ...admission, runtime_epoch: -1 },
    { ...admission, runtime_epoch: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () =>
        parseRuntimeRecords(
          { required_features: ["runtime-sessions.v1"], runtime_sessions: [invalid] },
          SUPPORTED_REGISTRY_FEATURES,
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
    );
  }
  assert.throws(
    () =>
      parseRuntimeRecords(
        { required_features: ["runtime-sessions.v1"], runtime_sessions: [admission, admission] },
        SUPPORTED_REGISTRY_FEATURES,
      ),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
  );
});

test("recent-event records accept only the frozen resource-handoff shape", () => {
  const parsed = parseRuntimeRecords(
    {
      required_features: ["recent-events.v1"],
      recent_events: [
        {
          kind: "resource-handoff",
          schema_version: 1,
          operation_id: "handoff-1",
          from_session_id: "session-a",
          to_session_id: "session-b",
          resource: "README.md",
          mode: "write",
          claim_set_generation: 2,
        },
      ],
    },
    SUPPORTED_REGISTRY_FEATURES,
  );
  assert.equal(parsed.records.recent_events?.[0]?.kind, "resource-handoff");
  assert.throws(
    () =>
      parseRuntimeRecords(
        {
          required_features: ["recent-events.v1"],
          recent_events: [{ kind: "unknown", schema_version: 1 }],
        },
        SUPPORTED_REGISTRY_FEATURES,
      ),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
  );
  assert.throws(
    () =>
      parseRuntimeRecords(
        {
          required_features: ["recent-events.v1"],
          recent_events: [
            {
              kind: "resource-handoff",
              schema_version: 2,
              operation_id: "handoff-1",
              from_session_id: "session-a",
              to_session_id: "session-b",
              resource: "README.md",
              mode: "write",
              claim_set_generation: 2,
            },
          ],
        },
        SUPPORTED_REGISTRY_FEATURES,
      ),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_CORRUPT",
  );
});
