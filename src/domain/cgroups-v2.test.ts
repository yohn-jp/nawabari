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
  const initializedScopes = new Set<string>();
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
        const reused = initializedScopes.has(file);
        initializedScopes.add(file);
        for (const [name, value] of [
          ["cgroup.procs", ""],
          [
            "cpu.stat",
            reused
              ? "usage_usec 0\nuser_usec 0\nsystem_usec 0\nthrottled_usec 0\n"
              : "usage_usec 100\nuser_usec 80\nsystem_usec 20\nthrottled_usec 3\n",
          ],
          ["memory.current", reused ? "0\n" : "4096\n"],
          ["memory.peak", reused ? "0\n" : "8192\n"],
          ["memory.events", reused ? "max 0\noom_kill 0\n" : "max 1\noom_kill 0\n"],
          ["pids.current", reused ? "0\n" : "2\n"],
          ["pids.events", reused ? "max 0\n" : "max 1\n"],
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

test("empty deterministic scopes are recreated before a new profile is applied", () => {
  const testFixture = fixture();
  try {
    const identity = { session_id: "session-a", execution_id: "run-reuse" };
    const limited = createCgroupScope(identity, {
      root: testFixture.root,
      filesystem: testFixture.filesystem,
      limits: { cpu_max_usec: 50_000, cpu_period_usec: 100_000, memory_max_bytes: 1_048_576, pids_max: 8 },
    });
    assert.equal(limited.ok, true, limited.ok ? "" : JSON.stringify(limited.error));
    if (!limited.ok) return;

    fs.writeFileSync(path.join(limited.value.path, "cpu.max"), "50000 100000\n", "utf8");
    fs.writeFileSync(path.join(limited.value.path, "memory.max"), "1048576\n", "utf8");
    fs.writeFileSync(path.join(limited.value.path, "pids.max"), "8\n", "utf8");
    fs.writeFileSync(path.join(limited.value.path, "cpu.stat"), "usage_usec 999\nthrottled_usec 4\n", "utf8");
    fs.writeFileSync(path.join(limited.value.path, "memory.events"), "max 7\noom_kill 2\n", "utf8");
    fs.writeFileSync(path.join(limited.value.path, "pids.events"), "max 3\n", "utf8");

    const unlimited = createCgroupScope(identity, { root: testFixture.root, filesystem: testFixture.filesystem });
    assert.equal(unlimited.ok, true, unlimited.ok ? "" : JSON.stringify(unlimited.error));
    if (!unlimited.ok) return;
    assert.equal(fs.readFileSync(path.join(unlimited.value.path, "cpu.max"), "utf8"), "max 100000\n");
    assert.equal(fs.readFileSync(path.join(unlimited.value.path, "memory.max"), "utf8"), "max\n");
    assert.equal(fs.readFileSync(path.join(unlimited.value.path, "pids.max"), "utf8"), "max\n");
    const accounting = readCgroupAccounting(unlimited.value);
    assert.equal(accounting.cpu_usage_usec, 0);
    assert.equal(accounting.cpu_throttled, false);
    assert.equal(accounting.memory_max_events, 0);
    assert.equal(accounting.memory_oom_kill_events, 0);
    assert.equal(accounting.pids_max_events, 0);
    assert.deepEqual(accounting, {
      bounded: true,
      cpu_usage_usec: 0,
      cpu_user_usec: 0,
      cpu_system_usec: 0,
      cpu_throttled_usec: 0,
      memory_current_bytes: 0,
      memory_peak_bytes: 0,
      pids_current: 0,
      pids_max_events: 0,
      memory_oom_kill_events: 0,
      memory_max_events: 0,
      cpu_throttled: false,
      memory_limit_exceeded: false,
      pids_limit_exceeded: false,
    });

    const changed = createCgroupScope(identity, {
      root: testFixture.root,
      filesystem: testFixture.filesystem,
      limits: { cpu_max_usec: 25_000, cpu_period_usec: 100_000, memory_max_bytes: 2_097_152, pids_max: 16 },
    });
    assert.equal(changed.ok, true, changed.ok ? "" : JSON.stringify(changed.error));
    if (!changed.ok) return;
    assert.equal(fs.readFileSync(path.join(changed.value.path, "cpu.max"), "utf8"), "25000 100000");
    assert.equal(fs.readFileSync(path.join(changed.value.path, "memory.max"), "utf8"), "2097152");
    assert.equal(fs.readFileSync(path.join(changed.value.path, "pids.max"), "utf8"), "16");
  } finally {
    testFixture.cleanup();
  }
});
