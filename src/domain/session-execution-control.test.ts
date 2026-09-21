import assert from "node:assert/strict";
import test from "node:test";

import {
  beginExecutionDrain,
  finalizeExecutionDrain,
  observeDrainCompletion,
  serializeExecutionDrainFence,
  type SessionDrainExecution,
} from "./session-execution-control.js";
import {
  SESSION_EXECUTION_RECORD_CONTRACT_ID,
  SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  type SessionExecutionRecord,
} from "./session-execution-record.js";
import {
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  type OwnedExecutionObservation,
} from "./session-process-observation.js";

const record = (executionId: string): SessionExecutionRecord => ({
  contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
  schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  session_id: "session-1",
  execution_id: executionId,
  state: "running",
  profile_digest: "profile-digest",
  filesystem_token: "filesystem-token",
  runtime_epoch: 7,
  boot_id: "boot-1",
  supervisor_pid: 100,
  supervisor_starttime: "200",
  cgroup_identity: { session_id: "session-1", execution_id: executionId },
  release_attempt: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const observation = (executionId: string, state: OwnedExecutionObservation["state"]): OwnedExecutionObservation => ({
  contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  session_id: "session-1",
  execution_id: executionId,
  boot_id: "boot-1",
  state,
  cgroups: null,
});

const execution = (id: string, state: OwnedExecutionObservation["state"]): SessionDrainExecution => ({
  record: record(id),
  observation: observation(id, state),
});

test("begin closes admission and does not hold a registry lock while waiting", () => {
  const result = beginExecutionDrain("session-1", 7, {
    operation: "close",
    policy: "wait",
    executions: [execution("exec-1", "active")],
    kernel_empty: false,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.admission, "closed");
  assert.equal(result.value.status, "draining");
  assert.deepEqual(result.value.active_execution_ids, ["exec-1"]);
});

test("wait policy leaves an active execution fenced and finalize fails closed", () => {
  const started = beginExecutionDrain("session-1", 7, {
    operation: "close",
    policy: "wait",
    executions: [execution("exec-1", "active")],
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const completion = observeDrainCompletion(started.value, {
    executions: [execution("exec-1", "active")],
    kernel_empty: false,
  });
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.equal(completion.value.completed, false);
  assert.equal(completion.value.next_action, "wait-for-drain");
  const finalized = finalizeExecutionDrain(completion.value.fence);
  assert.equal(finalized.ok, false);
  if (!finalized.ok) assert.equal(finalized.error.code, "OPERATION_REJECTED");
});

test("explicit terminate policy advertises termination but never performs it", () => {
  const started = beginExecutionDrain("session-1", 7, {
    operation: "discard",
    policy: "terminate",
    executions: [execution("exec-1", "active")],
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const completion = observeDrainCompletion(started.value, { kernel_empty: false });
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.equal(completion.value.next_action, "terminate-owned-executions");
  assert.equal(completion.value.fence.status, "waiting");
});

test("unknown occupancy and stale epochs prevent destructive finalization", () => {
  const started = beginExecutionDrain("session-1", 7, {
    operation: "release-claims",
    policy: "terminate",
    executions: [execution("exec-1", "unknown")],
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const unknown = observeDrainCompletion(started.value, { kernel_empty: true });
  assert.equal(unknown.ok, true);
  if (!unknown.ok) return;
  assert.equal(unknown.value.next_action, "reobserve-drain");
  const stale = observeDrainCompletion(started.value, { observed_epoch: 8, kernel_empty: true });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "OPERATION_REJECTED");
});

test("empty proof can finalize, while serialization keeps registry/lifecycle authorities distinct", () => {
  const started = beginExecutionDrain("session-1", 7, {
    operation: "close",
    policy: "wait",
    executions: [execution("exec-1", "empty")],
    kernel_empty: true,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const completion = observeDrainCompletion(started.value);
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  const finalized = finalizeExecutionDrain(completion.value.fence);
  assert.equal(finalized.ok, true);
  const serialized = serializeExecutionDrainFence(completion.value.fence);
  assert.deepEqual(Object.keys(serialized), ["registry", "lifecycle"]);
  assert.equal((serialized.registry as { admission: string }).admission, "closed");
});

test("drain rejects mismatched observation ownership and epochs", () => {
  const valid = execution("exec-1", "empty");
  const wrongOwner: SessionDrainExecution = {
    record: valid.record,
    observation: { ...valid.observation, execution_id: "other-execution" },
  };
  const result = beginExecutionDrain("session-1", 7, {
    operation: "close",
    policy: "wait",
    observed_epoch: 8,
    executions: [wrongOwner],
  });
  assert.equal(result.ok, false);
});
