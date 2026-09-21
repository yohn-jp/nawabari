import assert from "node:assert/strict";
import test from "node:test";

import {
  closeSessionWithRuntimeDrain,
  discardSessionWithRuntimeDrain,
  releaseSessionClaimsWithRuntimeDrain,
  type SessionRuntimeLifecycleSnapshot,
} from "./session-runtime-lifecycle.js";
import {
  SESSION_EXECUTION_RECORD_CONTRACT_ID,
  SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  type SessionExecutionRecord,
} from "./domain/session-execution-record.js";
import {
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  type OwnedExecutionObservation,
} from "./domain/session-process-observation.js";
import type { SessionDrainExecution } from "./domain/session-execution-control.js";

const durableRecord = (id: string): SessionExecutionRecord => ({
  contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
  schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  session_id: "session-1",
  execution_id: id,
  state: "running",
  profile_digest: "profile",
  filesystem_token: "filesystem",
  runtime_epoch: 4,
  boot_id: "boot",
  supervisor_pid: 42,
  supervisor_starttime: "10",
  cgroup_identity: { session_id: "session-1", execution_id: id },
  release_attempt: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const ownedObservation = (id: string, state: OwnedExecutionObservation["state"]): OwnedExecutionObservation => ({
  contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  session_id: "session-1",
  execution_id: id,
  boot_id: "boot",
  state,
  cgroups: null,
});

const snapshot = (state: OwnedExecutionObservation["state"], epoch = 4): SessionRuntimeLifecycleSnapshot => {
  const execution: SessionDrainExecution = {
    record: durableRecord("execution-1"),
    observation: ownedObservation("execution-1", state),
  };
  return {
    session_id: "session-1",
    runtime_epoch: epoch,
    executions: [execution],
    kernel_empty: state === "empty",
  };
};

test("close waits outside the canonical mutation when a process is active", async () => {
  const events: string[] = [];
  const result = await closeSessionWithRuntimeDrain(
    {
      observe: () => {
        events.push("observe");
        return snapshot("active");
      },
      mutate: () => {
        events.push("mutate");
        return "closed";
      },
    },
    "session-1",
    4,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "waiting");
  assert.equal(result.value.next_action, "wait-for-drain");
  assert.deepEqual(events, ["observe"]);
});

test("explicit terminate runs only the caller supplied ownership operation, then revalidates before mutation", async () => {
  const events: string[] = [];
  const result = await discardSessionWithRuntimeDrain(
    {
      observe: () => {
        events.push("observe");
        return snapshot(events.length < 2 ? "active" : "empty");
      },
      terminate: () => {
        events.push("terminate");
        return { observed_epoch: 4, executions: [snapshot("empty").executions[0]!], kernel_empty: true };
      },
      mutate: ({ fence }) => {
        events.push(`mutate:${fence.status}`);
        return "discarded";
      },
    },
    "session-1",
    4,
    "terminate",
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "completed");
  assert.deepEqual(events, ["observe", "terminate", "observe", "mutate:ready"]);
});

test("claim release is blocked by unknown occupancy and never reaches mutation", async () => {
  let mutated = false;
  const result = await releaseSessionClaimsWithRuntimeDrain(
    {
      observe: () => snapshot("unknown"),
      mutate: () => {
        mutated = true;
        return undefined;
      },
    },
    "session-1",
    4,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "blocked");
  assert.equal(result.value.next_action, "reobserve-drain");
  assert.equal(mutated, false);
});

test("a lifecycle epoch change fails closed before close mutation", async () => {
  let observes = 0;
  const result = await closeSessionWithRuntimeDrain(
    {
      observe: () => {
        observes += 1;
        return snapshot("empty", observes === 1 ? 4 : 5);
      },
      mutate: () => "closed",
    },
    "session-1",
    4,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_REJECTED");
});
