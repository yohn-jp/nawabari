import assert from "node:assert/strict";
import test from "node:test";
import { reserveExecution } from "./session-execution-record.js";
import { projectSessionResourceAccounting } from "./session-resource-accounting.js";
import { deriveCgroupScopeName, type CgroupFileSystem } from "./cgroups-v2.js";

function fixture(id: string, files: Record<string, string>) {
  const reserved = reserveExecution({
    session_id: "s",
    execution_id: id,
    profile_digest: "p",
    filesystem_token: "f",
    runtime_epoch: 1,
    boot_id: "b",
  });
  assert.ok(reserved.ok);
  const record = reserved.value;
  const name = deriveCgroupScopeName(record.cgroup_identity);
  const filesystem: CgroupFileSystem = {
    statSync: () => ({ isDirectory: () => true, isFile: () => true }),
    realpathSync: (file) => file,
    readFileSync: (file) =>
      files[file] ?? files[file.split("/").pop() ?? file] ?? (file.endsWith("cgroup.events") ? "populated 0\n" : ""),
    writeFileSync: () => {},
    mkdirSync: () => {},
    rmdirSync: () => {},
  };
  return {
    record,
    observation: {
      session_id: "s",
      execution_id: id,
      classification: "matched",
      matches: true,
      active: false,
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
    filesystem,
  } as const;
}

test("distinguishes measured zero from unreadable accounting", () => {
  const zero = fixture("a", {
    "cpu.stat": "usage_usec 0\nuser_usec 0\nsystem_usec 0\nthrottled_usec 0\n",
    "memory.current": "0",
    "memory.peak": "0",
    "pids.current": "0",
  });
  const result = projectSessionResourceAccounting([zero.record], {
    filesystem: zero.filesystem,
    observations: new Map([["a", zero.observation]]),
    scopes: new Map([["a", zero.scope]]),
  });
  assert.equal(result.entries[0]?.status, "available");
  assert.equal(result.entries[0]?.accounting?.cpu_usage_usec, 0);
});

test("sorts and bounds entries", () => {
  const one = fixture("b", {});
  const two = fixture("a", {});
  const result = projectSessionResourceAccounting([one.record, two.record], {
    filesystem: one.filesystem,
    observations: new Map([
      ["a", two.observation],
      ["b", one.observation],
    ]),
    scopes: new Map([
      ["a", two.scope],
      ["b", one.scope],
    ]),
  });
  assert.deepEqual(
    result.entries.map((entry) => entry.execution_id),
    ["a", "b"],
  );
  assert.equal(result.aggregate.memory_peak_bytes, null);
});

test("classifies missing scopes, unreadable accounting, and bad ownership", () => {
  const entry = fixture("c", { "cpu.stat": "bad", "memory.current": "bad" });
  const missing = projectSessionResourceAccounting([entry.record], {
    filesystem: { ...entry.filesystem, statSync: () => ({ isDirectory: () => false, isFile: () => false }) },
    observations: new Map([["c", entry.observation]]),
    scopes: new Map([["c", entry.scope]]),
  });
  assert.equal(missing.entries[0]?.reason, "cgroup-unavailable");
  const unreadable = projectSessionResourceAccounting([entry.record], {
    filesystem: entry.filesystem,
    observations: new Map([["c", entry.observation]]),
    scopes: new Map([["c", entry.scope]]),
  });
  assert.equal(unreadable.entries[0]?.reason, "accounting-unreadable");
  const bad = projectSessionResourceAccounting([entry.record], {
    filesystem: entry.filesystem,
    observations: new Map([["c", { ...entry.observation, matches: false, classification: "different-cgroup" }]]),
    scopes: new Map([["c", entry.scope]]),
  });
  assert.equal(bad.entries[0]?.reason, "identity-unverified");
});

test("keeps partial aggregates incomplete and aggregates boolean events", () => {
  const first = fixture("d", {
    "cpu.stat": "usage_usec 1\nuser_usec 1\nsystem_usec 1\nthrottled_usec 1\n",
    "memory.current": "2",
    "memory.peak": "9",
    "pids.current": "3",
    "memory.events": "oom_kill 1\nmax 0\n",
    "pids.events": "max 1\n",
  });
  const second = fixture("e", {
    "cpu.stat": "usage_usec 4\nuser_usec 4\nsystem_usec 4\nthrottled_usec 0\n",
    "memory.current": "5",
    "memory.peak": "12",
    "pids.current": "6",
    "memory.events": "oom_kill 0\nmax 1\n",
    "pids.events": "max 1\n",
  });
  const options = {
    filesystem: first.filesystem,
    observations: new Map([
      ["d", first.observation],
      ["e", second.observation],
    ]),
    scopes: new Map([
      ["d", first.scope],
      ["e", second.scope],
    ]),
  };
  const result = projectSessionResourceAccounting([first.record, second.record], options);
  assert.equal(result.aggregate.cpu_usage_usec, 2);
  assert.equal(result.aggregate.memory_peak_bytes, null);
  assert.equal(result.aggregate.memory_limit_exceeded, true);
  assert.equal(result.aggregate.pids_limit_exceeded, true);
});

test("bounds more than 256 persisted records", () => {
  const entry = fixture("f", { "cpu.stat": "usage_usec 1\n" });
  const records = Array.from({ length: 257 }, () => entry.record);
  const result = projectSessionResourceAccounting(records, {
    filesystem: entry.filesystem,
    observations: new Map([["f", entry.observation]]),
    scopes: new Map([["f", entry.scope]]),
  });
  assert.equal(result.entries.length, 256);
  assert.equal(result.truncated, true);
  assert.equal(result.aggregate.complete, false);
});
