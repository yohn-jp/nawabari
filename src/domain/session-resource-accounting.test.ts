import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  recordExecutionState,
  reserveExecution,
  toPersistedSessionExecutionRecord,
  type PersistedSessionExecutionRecord,
  type SessionExecutionIdentityObservation,
  type SessionExecutionIdentityReader,
} from "./session-execution-record.js";
import {
  projectSessionResourceAccounting,
  type SessionResourceAccountingOptions,
} from "./session-resource-accounting.js";
import { deriveCgroupScopeName, type CgroupFileSystem, type CgroupScope } from "./cgroups-v2.js";

type Fixture = Readonly<{
  record: PersistedSessionExecutionRecord;
  observation: SessionExecutionIdentityObservation;
  scope: CgroupScope;
  files: Readonly<Record<string, string>>;
}>;

function fixture(id: string, files: Record<string, string>, sessionId = "s"): Fixture {
  const reserved = reserveExecution({
    session_id: sessionId,
    execution_id: id,
    profile_digest: "p",
    filesystem_token: "f",
    runtime_epoch: 1,
    boot_id: "b",
  });
  assert.ok(reserved.ok);
  const attached = recordExecutionState(reserved.value, {
    state: "attached",
    supervisor: { pid: 1, starttime: "1" },
  });
  assert.ok(attached.ok);
  const record = toPersistedSessionExecutionRecord(attached.value);
  const name = deriveCgroupScopeName(record.cgroup_identity);
  return {
    record,
    observation: {
      session_id: sessionId,
      execution_id: id,
      classification: "matched",
      matches: true,
      active: true,
      expected: { pid: 1, starttime: "1", boot_id: "b", cgroup_name: name },
      observed: { pid: 1, starttime: "1", boot_id: "b", cgroup_path: `/nawabari/${name}` },
    },
    scope: {
      contract_id: "nawabari.cgroups-v2.v1",
      root: "/r",
      parent: "/r/nawabari",
      path: `/r/nawabari/${name}`,
      name,
      identity: record.cgroup_identity,
      boot_id: "b",
      limits: {},
    },
    files,
  };
}

function testFilesystem(fixtures: readonly Fixture[]): CgroupFileSystem {
  const contents = new Map<string, string>();
  for (const entry of fixtures) {
    contents.set(path.join(entry.scope.path, "cgroup.events"), "populated 0\n");
    contents.set(path.join(entry.scope.path, "cgroup.procs"), "");
    for (const [name, value] of Object.entries(entry.files)) {
      contents.set(path.join(entry.scope.path, name), value);
    }
  }
  return {
    statSync: (file) => ({
      isDirectory: () => fixtures.some((entry) => entry.scope.path === file),
      isFile: () => false,
    }),
    realpathSync: (file) => file,
    readFileSync: (file) => {
      const value = contents.get(file);
      if (value === undefined) throw new Error(`Missing test cgroup file: ${file}`);
      return value;
    },
    writeFileSync: () => {},
    mkdirSync: () => {},
    rmdirSync: () => {},
  };
}

function optionsFor(fixtures: readonly Fixture[]): SessionResourceAccountingOptions {
  return {
    filesystem: testFilesystem(fixtures),
    observations: new Map(fixtures.map((entry) => [entry.record.execution_id, entry.observation])),
    scopes: new Map(fixtures.map((entry) => [entry.record.execution_id, entry.scope])),
  };
}

function project(fixtures: readonly Fixture[], options: SessionResourceAccountingOptions = {}) {
  return projectSessionResourceAccounting(
    fixtures.map((entry) => entry.record),
    { ...optionsFor(fixtures), ...options },
  );
}

test("distinguishes zero, unknown, and partial numeric values", () => {
  const zero = fixture("a", {
    "cpu.stat": "usage_usec 0\nuser_usec 0\nsystem_usec 0\nthrottled_usec 0\n",
    "memory.current": "0",
    "memory.peak": "9",
    "pids.current": "0",
    "memory.events": "oom_kill 0\nmax 0\n",
    "pids.events": "max 0\n",
  });
  const partial = fixture("b", { "cpu.stat": "usage_usec 5\n" });
  const result = project([zero, partial]);
  assert.equal(result.aggregate.complete, true);
  assert.equal(result.aggregate.cpu_usage_usec, 5);
  assert.equal(result.aggregate.cpu_user_usec, 0);
  assert.equal(result.aggregate.cpu_system_usec, 0);
  assert.equal(result.aggregate.cpu_throttled_usec, 0);
  assert.equal(result.aggregate.memory_current_bytes, 0);
  assert.equal(result.aggregate.memory_peak_bytes, null);
  assert.equal(result.aggregate.pids_current, 0);
  assert.equal(result.aggregate.pids_max_events, 0);
  assert.equal(result.aggregate.memory_oom_kill_events, 0);
  assert.equal(result.aggregate.memory_max_events, 0);
  assert.equal(result.aggregate.cpu_throttled, null);
  assert.equal(result.aggregate.memory_limit_exceeded, null);
  assert.equal(result.aggregate.pids_limit_exceeded, null);

  const unknown = fixture("c", {});
  const unknownResult = project([unknown]);
  assert.equal(unknownResult.entries[0]?.status, "unavailable");
  assert.equal(unknownResult.aggregate.complete, false);
  assert.equal(unknownResult.aggregate.cpu_usage_usec, null);

  const unavailable = fixture("d", { "cpu.stat": "usage_usec 4\n" });
  const unavailableObservation = { ...unavailable.observation, classification: "unresolved" as const, matches: false };
  const incomplete = project([zero, unavailable], {
    observations: new Map([
      [zero.record.execution_id, zero.observation],
      [unavailable.record.execution_id, unavailableObservation],
    ]),
  });
  assert.equal(incomplete.aggregate.complete, false);
  assert.equal(incomplete.aggregate.cpu_usage_usec, 0);
});

test("sorts entries by execution ID and never aggregates memory peaks", () => {
  const b = fixture("b", { "cpu.stat": "usage_usec 1\n", "memory.peak": "9" });
  const a = fixture("a", { "cpu.stat": "usage_usec 2\n", "memory.peak": "12" });
  const result = project([b, a]);
  assert.deepEqual(
    result.entries.map((entry) => entry.execution_id),
    ["a", "b"],
  );
  assert.equal(result.aggregate.cpu_usage_usec, 3);
  assert.equal(result.aggregate.memory_peak_bytes, null);
});

test("rejects unverified record, observation, and boot identities", () => {
  const entry = fixture("identity", { "cpu.stat": "usage_usec 1\n" });
  const invalidRecord = {
    ...entry.record,
    cgroup_identity: { session_id: "other", execution_id: entry.record.execution_id },
  };
  const recordResult = projectSessionResourceAccounting([invalidRecord], optionsFor([entry]));
  assert.equal(recordResult.entries[0]?.reason, "identity-unverified");

  const badObservation = {
    ...entry.observation,
    observed: { ...entry.observation.observed!, boot_id: "other-boot" },
  };
  const observationResult = project([entry], {
    observations: new Map([[entry.record.execution_id, badObservation]]),
  });
  assert.equal(observationResult.entries[0]?.reason, "identity-unverified");

  const name = deriveCgroupScopeName(entry.record.cgroup_identity);
  const reader: SessionExecutionIdentityReader = {
    read_boot_id: () => "other-boot",
    read_process_starttime: () => "1",
    read_process_cgroup: () => `/nawabari/${name}`,
  };
  const bootResult = project([entry], { observations: new Map(), identity_reader: reader });
  assert.equal(bootResult.entries[0]?.reason, "identity-unverified");
});

test("reports missing scopes and unreadable accounting as unavailable", () => {
  const entry = fixture("c", { "cpu.stat": "bad", "memory.current": "bad" });
  const base = optionsFor([entry]);
  const missing = project([entry], {
    filesystem: { ...base.filesystem!, statSync: () => ({ isDirectory: () => false, isFile: () => false }) },
  });
  assert.equal(missing.entries[0]?.reason, "cgroup-unavailable");

  const unreadable = project([entry]);
  assert.equal(unreadable.entries[0]?.reason, "accounting-unreadable");
});

test("uses the native filesystem and derives a separate scope for each execution", (t) => {
  const one = fixture("native-a", {
    "cpu.stat": "usage_usec 1\nuser_usec 1\n",
    "memory.current": "3",
    "pids.current": "1",
  });
  const two = fixture("native-b", {
    "cpu.stat": "usage_usec 2\nuser_usec 2\n",
    "memory.current": "5",
    "pids.current": "2",
  });
  const root = mkdtempSync(path.join(tmpdir(), "nawabari-resource-accounting-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const entry of [one, two]) {
    const name = deriveCgroupScopeName(entry.record.cgroup_identity);
    const directory = path.join(root, "nawabari", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "cgroup.events"), "populated 0\n");
    writeFileSync(path.join(directory, "cgroup.procs"), "");
    for (const [file, contents] of Object.entries(entry.files)) {
      writeFileSync(path.join(directory, file), contents);
    }
  }

  const result = projectSessionResourceAccounting([two.record, one.record], {
    root,
    observations: new Map([
      [one.record.execution_id, one.observation],
      [two.record.execution_id, two.observation],
    ]),
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.accounting?.cpu_usage_usec),
    [1, 2],
  );
  assert.equal(result.aggregate.cpu_usage_usec, 3);
  assert.equal(result.aggregate.memory_current_bytes, 8);
  assert.equal(result.aggregate.pids_current, 3);
});

test("applies three-valued certainty to each limit-event boolean", () => {
  const scenarios = [
    {
      field: "cpu_throttled",
      positive: { "cpu.stat": "usage_usec 0\nthrottled_usec 1\n" },
      zero: { "cpu.stat": "usage_usec 0\nthrottled_usec 0\n" },
      missing: { "cpu.stat": "usage_usec 0\n" },
    },
    {
      field: "memory_limit_exceeded",
      positive: { "cpu.stat": "usage_usec 0\n", "memory.events": "oom_kill 1\nmax 0\n" },
      zero: { "cpu.stat": "usage_usec 0\n", "memory.events": "oom_kill 0\nmax 0\n" },
      missing: { "cpu.stat": "usage_usec 0\n", "memory.events": "max 0\n" },
    },
    {
      field: "pids_limit_exceeded",
      positive: { "cpu.stat": "usage_usec 0\n", "pids.events": "max 1\n" },
      zero: { "cpu.stat": "usage_usec 0\n", "pids.events": "max 0\n" },
      missing: { "cpu.stat": "usage_usec 0\n" },
    },
  ] as const;

  for (const scenario of scenarios) {
    const positive = fixture(`${scenario.field}-positive`, scenario.positive);
    const zero = fixture(`${scenario.field}-zero`, scenario.zero);
    const missing = fixture(`${scenario.field}-missing`, scenario.missing);
    const unavailable = fixture(`${scenario.field}-unavailable`, { "cpu.stat": "usage_usec 0\n" });
    const unavailableObservation = {
      ...unavailable.observation,
      classification: "unresolved" as const,
      matches: false,
    };
    const incompleteObservations = new Map([
      [positive.record.execution_id, positive.observation],
      [zero.record.execution_id, zero.observation],
      [unavailable.record.execution_id, unavailableObservation],
    ]);

    assert.equal(project([positive]).aggregate[scenario.field], true, `${scenario.field}: known true`);
    assert.equal(project([zero]).aggregate[scenario.field], false, `${scenario.field}: complete raw false`);
    assert.equal(project([missing]).aggregate[scenario.field], null, `${scenario.field}: missing raw evidence`);

    const trueWithUnknown = project([positive, unavailable], { observations: incompleteObservations });
    assert.equal(trueWithUnknown.aggregate.complete, false);
    assert.equal(trueWithUnknown.aggregate[scenario.field], true, `${scenario.field}: true OR unknown`);

    const falseWithUnknown = project([zero, unavailable], { observations: incompleteObservations });
    assert.equal(falseWithUnknown.aggregate.complete, false);
    assert.equal(falseWithUnknown.aggregate[scenario.field], null, `${scenario.field}: false OR unknown`);
  }
});

test("orders, truncates at 256, and preserves partial numeric sums", () => {
  const fixtures = Array.from({ length: 257 }, (_, index) =>
    fixture(`execution-${index.toString().padStart(3, "0")}`, {
      "cpu.stat": "usage_usec 1\nthrottled_usec 0\n",
    }),
  );
  const result = project(fixtures);
  assert.equal(result.entries.length, 256);
  assert.equal(result.entries[0]?.execution_id, "execution-000");
  assert.equal(result.entries[255]?.execution_id, "execution-255");
  assert.equal(result.truncated, true);
  assert.equal(result.aggregate.complete, false);
  assert.equal(result.aggregate.cpu_usage_usec, 256);
  assert.equal(result.aggregate.cpu_throttled, null);
});
