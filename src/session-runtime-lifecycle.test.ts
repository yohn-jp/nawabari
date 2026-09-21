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
import { deriveCgroupScopeName } from "./domain/cgroups-v2.js";
import {
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  type OwnedExecutionObservation,
} from "./domain/session-process-observation.js";
import type { SessionDrainExecution } from "./domain/session-execution-control.js";

const durableRecord = (id: string, epoch = 4): SessionExecutionRecord => ({
  contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
  schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  session_id: "session-1",
  execution_id: id,
  state: "running",
  profile_digest: "profile",
  filesystem_token: "filesystem",
  runtime_epoch: epoch,
  boot_id: "boot",
  supervisor_pid: 42,
  supervisor_starttime: "10",
  cgroup_identity: { session_id: "session-1", execution_id: id },
  release_attempt: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const ownedObservation = (id: string, state: OwnedExecutionObservation["state"]): OwnedExecutionObservation => {
  if (state === "unknown") {
    return {
      contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
      session_id: "session-1",
      execution_id: id,
      boot_id: "boot",
      state,
      cgroups: null,
    };
  }
  const population = state === "active" ? "populated" : "empty";
  return {
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: "session-1",
    execution_id: id,
    boot_id: "boot",
    state,
    cgroups: {
      scope: deriveCgroupScopeName({ session_id: "session-1", execution_id: id }),
      population: {
        state: population,
        populated: state === "active",
        processes: state === "active" ? [42] : [],
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

const snapshot = (state: OwnedExecutionObservation["state"], epoch = 4): SessionRuntimeLifecycleSnapshot => {
  const execution: SessionDrainExecution = {
    record: durableRecord("execution-1", epoch),
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
  let runtimeEpoch = 4;
  const result = await closeSessionWithRuntimeDrain(
    {
      observe: () => {
        events.push("observe");
        return snapshot("active", runtimeEpoch);
      },
      close_admission: ({ expected_epoch }) => {
        events.push("close-admission");
        runtimeEpoch = Number(expected_epoch) + 1;
        return { ok: true, value: { admission: "closed", runtime_epoch: runtimeEpoch } };
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
  assert.deepEqual(events, ["observe", "close-admission", "observe"]);
});

test("explicit terminate runs only the caller supplied ownership operation, then revalidates before mutation", async () => {
  const events: string[] = [];
  let runtimeEpoch = 4;
  let observations = 0;
  const result = await discardSessionWithRuntimeDrain(
    {
      observe: () => {
        events.push("observe");
        observations += 1;
        return snapshot(observations < 3 ? "active" : "empty", runtimeEpoch);
      },
      close_admission: ({ expected_epoch }) => {
        events.push("close-admission");
        runtimeEpoch = Number(expected_epoch) + 1;
        return { ok: true, value: { admission: "closed", runtime_epoch: runtimeEpoch } };
      },
      terminate: () => {
        events.push("terminate");
        return {
          observed_epoch: runtimeEpoch,
          executions: [snapshot("empty", runtimeEpoch).executions[0]!],
          kernel_empty: true,
        };
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
  assert.deepEqual(events, ["observe", "close-admission", "observe", "terminate", "observe", "mutate:ready"]);
});

test("claim release is blocked by unknown occupancy and never reaches mutation", async () => {
  let mutated = false;
  let runtimeEpoch = 4;
  const result = await releaseSessionClaimsWithRuntimeDrain(
    {
      observe: () => snapshot("unknown", runtimeEpoch),
      close_admission: ({ expected_epoch }) => {
        runtimeEpoch = Number(expected_epoch) + 1;
        return { ok: true, value: { admission: "closed", runtime_epoch: runtimeEpoch } };
      },
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
  let runtimeEpoch = 4;
  const result = await closeSessionWithRuntimeDrain(
    {
      observe: () => {
        observes += 1;
        if (observes === 1) return snapshot("empty", 4);
        if (observes === 2) return snapshot("empty", runtimeEpoch);
        return snapshot("empty", 6);
      },
      close_admission: ({ expected_epoch }) => {
        runtimeEpoch = Number(expected_epoch) + 1;
        return { ok: true, value: { admission: "closed", runtime_epoch: runtimeEpoch } };
      },
      mutate: () => "closed",
    },
    "session-1",
    4,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_REJECTED");
});
