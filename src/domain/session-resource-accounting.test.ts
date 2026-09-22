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
    readFileSync: (file) => files[file] ?? files[file.split("/").pop() ?? file] ?? "",
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
