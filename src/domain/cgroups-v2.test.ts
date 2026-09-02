import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  attachProcessToCgroup,
  cleanupCgroupScope,
  createCgroupScope,
  deriveCgroupScopeName,
  readCgroupAccounting,
  type CgroupFileSystem,
} from "./cgroups-v2.js";

function fixture(): { readonly root: string; readonly filesystem: CgroupFileSystem; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-cgroups-v2-"));
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n");
  fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +memory +pids\n");
  const native: CgroupFileSystem = {
    statSync: (file) => fs.statSync(file),
    realpathSync: (file) => fs.realpathSync.native(file),
    readFileSync: (file) => fs.readFileSync(file, "utf8"),
    writeFileSync: (file, value) => {
      fs.writeFileSync(file, value, "utf8");
      if (path.basename(file) === "cgroup.kill")
        fs.writeFileSync(path.join(path.dirname(file), "cgroup.procs"), "", "utf8");
    },
    mkdirSync: (file, options) => {
      fs.mkdirSync(file, options);
      if (path.basename(file) === "nawabari")
        fs.writeFileSync(path.join(file, "cgroup.subtree_control"), "+cpu +memory +pids\n", "utf8");
      if (path.basename(file).startsWith("nawabari-")) {
        for (const [name, value] of [
          ["cgroup.procs", ""],
          ["cpu.stat", "usage_usec 100\nuser_usec 80\nsystem_usec 20\nthrottled_usec 3\n"],
          ["memory.current", "4096\n"],
          ["memory.peak", "8192\n"],
          ["memory.events", "max 1\noom_kill 0\n"],
          ["pids.current", "2\n"],
          ["pids.events", "max 1\n"],
          ["cpu.max", "max 100000\n"],
          ["memory.max", "max\n"],
          ["pids.max", "max\n"],
        ] as const) {
          fs.writeFileSync(path.join(file, name), value, "utf8");
        }
      }
    },
    rmdirSync: (file) => fs.rmSync(file, { recursive: true }),
  };
  return { root, filesystem: native, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("cgroups v2 scope names bind session and execution identity", () => {
  const first = deriveCgroupScopeName({ session_id: "session-a", execution_id: "run-1" });
  const same = deriveCgroupScopeName({ session_id: "session-a", execution_id: "run-1" });
  const different = deriveCgroupScopeName({ session_id: "session-a", execution_id: "run-2" });
  assert.equal(first, same);
  assert.notEqual(first, different);
  assert.match(first, /^nawabari-[0-9a-f]{48}$/u);
});

test("cgroups v2 limits, bounded accounting, attach, and cleanup remain identity-bound", () => {
  const testFixture = fixture();
  try {
    const identity = { session_id: "session-a", execution_id: "run-1" };
    const created = createCgroupScope(identity, {
      root: testFixture.root,
      filesystem: testFixture.filesystem,
      limits: { cpu_max_usec: 50_000, cpu_period_usec: 100_000, memory_max_bytes: 1_048_576, pids_max: 8 },
    });
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    assert.equal(fs.readFileSync(path.join(created.value.path, "cpu.max"), "utf8"), "50000 100000");
    assert.equal(fs.readFileSync(path.join(created.value.path, "memory.max"), "utf8"), "1048576");
    assert.equal(fs.readFileSync(path.join(created.value.path, "pids.max"), "utf8"), "8");
    assert.equal(attachProcessToCgroup(created.value, 42).ok, true);
    const accounting = readCgroupAccounting(created.value);
    assert.equal(accounting.bounded, true);
    assert.equal(accounting.cpu_usage_usec, 100);
    assert.equal(accounting.memory_peak_bytes, 8192);
    assert.equal(accounting.pids_limit_exceeded, true);
    const wrongIdentity = { ...created.value, identity: { ...identity, execution_id: "other" } };
    assert.equal(cleanupCgroupScope(wrongIdentity).ok, false);
    assert.equal(cleanupCgroupScope(created.value).ok, true);
  } finally {
    testFixture.cleanup();
  }
});

test("occupied deterministic scopes are not adopted on restart", () => {
  const testFixture = fixture();
  try {
    const identity = { session_id: "session-a", execution_id: "run-occupied" };
    const first = createCgroupScope(identity, { root: testFixture.root, filesystem: testFixture.filesystem });
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
    if (!first.ok) return;
    fs.writeFileSync(path.join(first.value.path, "cgroup.procs"), "123\n", "utf8");
    const retry = createCgroupScope(identity, { root: testFixture.root, filesystem: testFixture.filesystem });
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.error.code, "SANDBOX_CGROUP_SCOPE_CONFLICT");
  } finally {
    testFixture.cleanup();
  }
});
