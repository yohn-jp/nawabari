import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveCgroupScopeName } from "./cgroups-v2.js";
import {
  observeExecutionIdentity,
  observeMissingExecutionRecord,
  parseSessionExecutionRecord,
  recordExecutionState,
  reserveExecution,
  reserveExecutionBeforePayload,
  serializeSessionExecutionRecord,
  type SessionExecutionIdentityReader,
  type SessionExecutionRecord,
} from "./session-execution-record.js";

const timestamp = "2026-09-21T00:00:00.000Z";

function reservation(): SessionExecutionRecord {
  const result = reserveExecution({
    session_id: "session-1",
    execution_id: "execution-1",
    profile_digest: "a".repeat(64),
    filesystem_token: "filesystem-token-1",
    runtime_epoch: 7,
    boot_id: "boot-1",
    cgroup_root: "/sys/fs/cgroup/user.slice/test.scope",
    now: timestamp,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function attached(): SessionExecutionRecord {
  const result = recordExecutionState(reservation(), {
    state: "attached",
    supervisor: { pid: 4123, starttime: "9001" },
    now: "2026-09-21T00:00:01.000Z",
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function reader(
  record: SessionExecutionRecord,
  overrides: Partial<{
    readonly boot_id: string;
    readonly starttime: string;
    readonly cgroup_path: string;
  }> = {},
): SessionExecutionIdentityReader {
  return {
    read_boot_id: () => overrides.boot_id ?? record.boot_id,
    read_process_starttime: () => overrides.starttime ?? record.supervisor_starttime ?? "0",
    read_process_cgroup: () =>
      overrides.cgroup_path ?? `/user.slice/test.scope/nawabari/${deriveCgroupScopeName(record.cgroup_identity)}`,
  };
}

test("reservation is a distinct durable execution identity and starts in starting", () => {
  const record = reservation();
  assert.equal(record.session_id, "session-1");
  assert.equal(record.execution_id, "execution-1");
  assert.equal(record.cgroup_identity.session_id, record.session_id);
  assert.equal(record.cgroup_identity.execution_id, record.execution_id);
  assert.equal(record.state, "starting");
  assert.equal(record.supervisor_pid, null);
  assert.equal(record.supervisor_starttime, null);
  assert.equal(record.release_attempt, null);
});

test("state recording preserves all identity evidence and enforces lifecycle ordering", () => {
  const attachedRecord = attached();
  assert.equal(attachedRecord.state, "attached");
  assert.equal(attachedRecord.supervisor_pid, 4123);
  assert.equal(attachedRecord.supervisor_starttime, "9001");

  const running = recordExecutionState(attachedRecord, {
    state: "running",
    now: "2026-09-21T00:00:02.000Z",
  });
  assert.equal(running.ok, true, running.ok ? "" : JSON.stringify(running.error));
  if (!running.ok) return;

  const replacement = recordExecutionState(attachedRecord, {
    state: "running",
    supervisor: { pid: 4124, starttime: "9002" },
    now: "2026-09-21T00:00:02.000Z",
  });
  assert.equal(replacement.ok, false);
  if (!replacement.ok) assert.equal(replacement.error.code, "INVALID_ARGUMENT");

  const invalid = recordExecutionState(reservation(), { state: "running", now: "2026-09-21T00:00:01.000Z" });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "INVALID_ARGUMENT");
});

test("release-attempt evidence is monotonic and cannot be cleared", () => {
  const released = recordExecutionState(attached(), {
    state: "exited",
    release_attempt: {
      attempt: 1,
      outcome: "unresolved",
      attempted_at: "2026-09-21T00:00:02.000Z",
    },
    now: "2026-09-21T00:00:02.000Z",
  });
  assert.equal(released.ok, true, released.ok ? "" : JSON.stringify(released.error));
  if (!released.ok) return;

  const cleared = recordExecutionState(released.value, {
    state: "exited",
    release_attempt: null,
    now: "2026-09-21T00:00:03.000Z",
  });
  assert.equal(cleared.ok, false);

  const preserved = recordExecutionState(released.value, {
    state: "exited",
    now: "2026-09-21T00:00:03.000Z",
  });
  assert.equal(preserved.ok, true, preserved.ok ? "" : JSON.stringify(preserved.error));
  if (preserved.ok) assert.equal(preserved.value.release_attempt?.attempt, 1);
});

test("serialization round-trips after a restart without changing execution identity", () => {
  const record = attached();
  const serialized = serializeSessionExecutionRecord(record);
  const restarted = parseSessionExecutionRecord(JSON.parse(JSON.stringify(serialized)));
  assert.equal(restarted.ok, true, restarted.ok ? "" : JSON.stringify(restarted.error));
  if (!restarted.ok) return;
  assert.deepEqual(restarted.value, record);
  assert.notEqual(restarted.value.session_id, restarted.value.execution_id);
  assert.equal(restarted.value.cgroup_root, "/sys/fs/cgroup/user.slice/test.scope");
});

test("legacy missing and malformed cgroup roots never acquire new ownership", () => {
  const record = attached();
  const { cgroup_root: _root, ...legacy } = serializeSessionExecutionRecord(record);
  const parsed = parseSessionExecutionRecord(legacy);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.cgroup_root, null);
    const observed = observeExecutionIdentity(parsed.value, { reader: reader(record) });
    assert.equal(observed.ok, true);
    if (observed.ok) assert.equal(observed.value.classification, "unresolved");
  }
  assert.equal(parseSessionExecutionRecord({ ...record, cgroup_root: "/sys/fs/cgroup/../other" }).ok, false);
});

test("observation accepts only matching boot, process generation, and cgroup identity", () => {
  const record = attached();
  const matched = observeExecutionIdentity(record, { reader: reader(record) });
  assert.equal(matched.ok, true, matched.ok ? "" : JSON.stringify(matched.error));
  if (!matched.ok) return;
  assert.equal(matched.value.matches, true);
  assert.equal(matched.value.classification, "matched");
  assert.equal(matched.value.active, true);

  const reusedPid = observeExecutionIdentity(record, { reader: reader(record, { starttime: "9002" }) });
  assert.equal(reusedPid.ok, true);
  if (reusedPid.ok) {
    assert.equal(reusedPid.value.matches, false);
    assert.equal(reusedPid.value.classification, "pid-reused");
  }

  const differentBoot = observeExecutionIdentity(record, { reader: reader(record, { boot_id: "boot-2" }) });
  assert.equal(differentBoot.ok, true);
  if (differentBoot.ok) assert.equal(differentBoot.value.classification, "different-boot");

  const differentCgroup = observeExecutionIdentity(record, {
    reader: reader(record, { cgroup_path: "/nawabari/nawabari-foreign" }),
  });
  assert.equal(differentCgroup.ok, true);
  if (differentCgroup.ok) assert.equal(differentCgroup.value.classification, "different-cgroup");

  const sameBasenameDifferentHierarchy = observeExecutionIdentity(record, {
    reader: reader(record, { cgroup_path: `/foreign/${deriveCgroupScopeName(record.cgroup_identity)}` }),
  });
  assert.equal(sameBasenameDifferentHierarchy.ok, true);
  if (sameBasenameDifferentHierarchy.ok) {
    assert.equal(sameBasenameDifferentHierarchy.value.matches, false);
    assert.equal(sameBasenameDifferentHierarchy.value.classification, "different-cgroup");
  }
});

test("missing supervisor evidence remains unresolved instead of becoming active", () => {
  const result = observeExecutionIdentity(reservation(), {
    reader: {
      read_boot_id: () => "boot-1",
      read_process_starttime: () => "9001",
      read_process_cgroup: () => "/nawabari/ignored",
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.matches, false);
    assert.equal(result.value.classification, "unresolved");
    assert.equal(result.value.observed, null);
  }
});

test("missing execution records are legacy-untracked and never active", () => {
  const result = observeMissingExecutionRecord("session-legacy");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.classification, "legacy-untracked");
  assert.equal(result.value.matches, false);
  assert.equal(result.value.active, false);
  assert.equal(result.value.execution_id, null);
});

test("registry failure prevents payload start", async () => {
  let started = false;
  const result = await reserveExecutionBeforePayload(
    {
      session_id: "session-1",
      execution_id: "execution-failing-write",
      profile_digest: "a".repeat(64),
      filesystem_token: "filesystem-token-1",
      runtime_epoch: "epoch-1",
      boot_id: "boot-1",
      now: timestamp,
    },
    async () => {
      throw new Error("injected registry failure");
    },
    () => {
      started = true;
      return "payload";
    },
  );
  assert.equal(result.ok, false);
  assert.equal(started, false);
  if (!result.ok) assert.equal(result.error.code, "REGISTRY_DURABILITY_UNCERTAIN");
});

test("payload starts only after the starting record has been persisted", async () => {
  const persisted: SessionExecutionRecord[] = [];
  let started = false;
  const result = await reserveExecutionBeforePayload(
    {
      session_id: "session-1",
      execution_id: "execution-persisted-first",
      profile_digest: "a".repeat(64),
      filesystem_token: "filesystem-token-1",
      runtime_epoch: 9,
      boot_id: "boot-1",
      now: timestamp,
    },
    (record) => {
      const parsed = parseSessionExecutionRecord(record);
      assert.equal(parsed.ok, true);
      if (parsed.ok) persisted.push(parsed.value);
    },
    (record) => {
      started = true;
      assert.equal(persisted[0]?.execution_id, record.execution_id);
      assert.equal(persisted[0]?.state, "starting");
      return "payload";
    },
  );
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  assert.equal(started, true);
  assert.equal(persisted.length, 1);
});

test("malformed or unrelated cgroup records are rejected before observation", () => {
  const record = reservation();
  const malformed = parseSessionExecutionRecord({
    ...record,
    cgroup_identity: { session_id: "other", execution_id: "x" },
  });
  assert.equal(malformed.ok, false);
  const extra = parseSessionExecutionRecord({ ...record, unexpected: true });
  assert.equal(extra.ok, false);
});
