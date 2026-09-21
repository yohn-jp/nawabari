import assert from "node:assert/strict";
import test from "node:test";

import { SessionRegistryError } from "../errors.js";
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
  assert.deepEqual(SUPPORTED_REGISTRY_FEATURES, ["recent-events.v1"]);
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
  const parsed = parseRuntimeRecords(
    {
      required_features: ["executions.v1"],
      executions: [{ execution_id: "exec-1", state: "starting" }],
    },
    ["executions.v1"],
  );
  assert.deepEqual(toPersistedRuntimeRecords(parsed), {
    executions: [{ execution_id: "exec-1", state: "starting" }],
  });
});

test("feature presence without a matching gate fails closed", () => {
  assert.throws(
    () => parseRuntimeRecords({ executions: [] }, ["executions.v1"]),
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
