import assert from "node:assert/strict";
import test from "node:test";

import {
  beginExecutionDrain,
  finalizeExecutionDrain,
  observeDrainCompletion,
  serializeExecutionDrainFence,
  type SessionDrainAdmissionAuthority,
  type SessionDrainExecution,
} from "./session-execution-control.js";
import { deriveCgroupScopeName } from "./cgroups-v2.js";
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

const observation = (executionId: string, state: OwnedExecutionObservation["state"]): OwnedExecutionObservation => {
  if (state === "unknown") {
    return {
      contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
      session_id: "session-1",
      execution_id: executionId,
      boot_id: "boot-1",
      state,
      cgroups: null,
    };
  }
  const population = state === "active" ? "populated" : "empty";
  return {
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: "session-1",
    execution_id: executionId,
    boot_id: "boot-1",
    state,
    cgroups: {
      scope: deriveCgroupScopeName({ session_id: "session-1", execution_id: executionId }),
      population: {
        state: population,
        populated: state === "active",
        processes: state === "active" ? [100] : [],
        events: { populated: state === "active" ? 1 : 0 },
      },
      accounting: {
        bounded: true,
        cpu_usage_usec: null,
        cpu_user_usec: null,
        cpu_system_usec: null,
        cpu_throttled_usec: null,
        memory_current_bytes: null,
        memory_peak_bytes: null,
        pids_current: null,
        pids_max_events: null,
        memory_oom_kill_events: null,
        memory_max_events: null,
        cpu_throttled: false,
        memory_limit_exceeded: false,
        pids_limit_exceeded: false,
      },
    },
  };
};

const execution = (id: string, state: OwnedExecutionObservation["state"]): SessionDrainExecution => ({
  record: record(id),
  observation: observation(id, state),
});

const closeAdmission: SessionDrainAdmissionAuthority = (request) => ({
  ok: true,
  value: {
    admission: "closed",
    runtime_epoch:
      typeof request.expected_epoch === "number" ? request.expected_epoch + 1 : `${request.expected_epoch}:closed`,
  },
});

test("begin closes admission and does not hold a registry lock while waiting", () => {
  const result = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [execution("exec-1", "active")],
      kernel_empty: false,
    },
    closeAdmission,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.admission, "closed");
  assert.equal(result.value.status, "draining");
  assert.deepEqual(result.value.active_execution_ids, ["exec-1"]);
});

test("wait policy leaves an active execution fenced and finalize fails closed", () => {
  const started = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [execution("exec-1", "active")],
    },
    closeAdmission,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const completion = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
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
  const started = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "discard",
      policy: "terminate",
      executions: [execution("exec-1", "active")],
    },
    closeAdmission,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const completion = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
    executions: [execution("exec-1", "active")],
    kernel_empty: false,
  });
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  assert.equal(completion.value.next_action, "terminate-owned-executions");
  assert.equal(completion.value.fence.status, "waiting");
});

test("unknown occupancy and stale epochs prevent destructive finalization", () => {
  const started = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "release-claims",
      policy: "terminate",
      executions: [execution("exec-1", "unknown")],
    },
    closeAdmission,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const unknown = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
    executions: [execution("exec-1", "unknown")],
    kernel_empty: true,
  });
  assert.equal(unknown.ok, true);
  if (!unknown.ok) return;
  assert.equal(unknown.value.next_action, "reobserve-drain");
  const stale = observeDrainCompletion(started.value, {
    observed_epoch: 9,
    executions: [execution("exec-1", "unknown")],
    kernel_empty: true,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "OPERATION_REJECTED");
});

test("only fresh post-admission empty proof can finalize", () => {
  const started = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [execution("exec-1", "empty")],
      kernel_empty: true,
    },
    closeAdmission,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const preGateFinalization = finalizeExecutionDrain(started.value);
  assert.equal(preGateFinalization.ok, false);
  const preGateObservation = observeDrainCompletion(started.value, {
    observed_epoch: started.value.expected_epoch,
    executions: [execution("exec-1", "empty")],
    kernel_empty: true,
  });
  assert.equal(preGateObservation.ok, false);
  const completion = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
    executions: [execution("exec-1", "empty")],
    kernel_empty: true,
  });
  assert.equal(completion.ok, true);
  if (!completion.ok) return;
  const finalized = finalizeExecutionDrain(completion.value.fence);
  assert.equal(finalized.ok, true);
  if (finalized.ok) assert.equal(finalized.value.admission_epoch, started.value.admission_epoch);
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
  const result = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      observed_epoch: 8,
      executions: [wrongOwner],
    },
    closeAdmission,
  );
  assert.equal(result.ok, false);
});

test("a fence cannot be issued without the atomic canonical admission authority", () => {
  const result = beginExecutionDrain("session-1", 7, {
    operation: "close",
    policy: "wait",
    executions: [execution("exec-1", "empty")],
    kernel_empty: true,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_REJECTED");
});

test("boot and cgroup identity mismatches fail closed", () => {
  const valid = execution("exec-1", "empty");
  const wrongBoot: SessionDrainExecution = {
    record: valid.record,
    observation: { ...valid.observation, boot_id: "other-boot" },
  };
  const wrongBootResult = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [wrongBoot],
    },
    closeAdmission,
  );
  assert.equal(wrongBootResult.ok, false);

  const wrongScope: SessionDrainExecution = {
    record: valid.record,
    observation: {
      ...valid.observation,
      cgroups: valid.observation.cgroups === null ? null : { ...valid.observation.cgroups, scope: "other-scope" },
    },
  };
  const wrongScopeResult = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [wrongScope],
    },
    closeAdmission,
  );
  assert.equal(wrongScopeResult.ok, false);
});

test("malformed nested cgroups evidence returns typed failure instead of throwing", () => {
  const valid = execution("exec-1", "empty");
  const malformed: SessionDrainExecution = {
    record: valid.record,
    observation: {
      ...valid.observation,
      cgroups: {
        ...(valid.observation.cgroups as NonNullable<OwnedExecutionObservation["cgroups"]>),
        population: null,
      } as unknown as NonNullable<OwnedExecutionObservation["cgroups"]>,
    },
  };
  const result = beginExecutionDrain(
    "session-1",
    7,
    { operation: "close", policy: "wait", executions: [malformed] },
    closeAdmission,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("distinct long idempotency keys receive distinct bounded fence identities", () => {
  const first = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      idempotency_key: "a".repeat(512),
    },
    closeAdmission,
  );
  const second = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      idempotency_key: `${"a".repeat(511)}b`,
    },
    closeAdmission,
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.notEqual(first.value.fence_id, second.value.fence_id);
    assert.ok(first.value.fence_id.length <= 512);
    assert.ok(second.value.fence_id.length <= 512);
  }
});

test("missing execution coverage remains fenced and malformed fence evidence is rejected", () => {
  const started = beginExecutionDrain(
    "session-1",
    7,
    {
      operation: "close",
      policy: "wait",
      executions: [execution("exec-1", "empty")],
      kernel_empty: true,
    },
    closeAdmission,
  );
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const missing = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
    executions: [],
    kernel_empty: true,
  });
  assert.equal(missing.ok, true);
  if (!missing.ok) return;
  assert.deepEqual(missing.value.missing_execution_ids, ["exec-1"]);
  assert.equal(missing.value.safe_to_finalize, false);

  const malformedKernel = observeDrainCompletion(started.value, {
    observed_epoch: started.value.admission_epoch,
    executions: [execution("exec-1", "empty")],
    kernel_empty: "yes" as unknown as boolean,
  });
  assert.equal(malformedKernel.ok, false);

  const malformedFence = observeDrainCompletion(
    { ...started.value, contract_id: "other-contract" } as unknown as typeof started.value,
    { observed_epoch: started.value.admission_epoch, executions: [execution("exec-1", "empty")], kernel_empty: true },
  );
  assert.equal(malformedFence.ok, false);

  const malformedOperation = observeDrainCompletion(
    { ...started.value, operation: "gc" } as unknown as typeof started.value,
    { observed_epoch: started.value.admission_epoch, executions: [execution("exec-1", "empty")], kernel_empty: true },
  );
  assert.equal(malformedOperation.ok, false);
});
