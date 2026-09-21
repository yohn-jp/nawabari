import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCgroupScope, type CgroupFileSystem } from "./cgroups-v2.js";
import {
  observeOwnedExecution,
  serializeSessionExecutionRecord,
  terminateOwnedExecution,
  type SessionExecutionRecord,
} from "./session-process-observation.js";

function fixture(): { readonly root: string; readonly filesystem: CgroupFileSystem; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-process-observation-"));
  const native: CgroupFileSystem = {
    statSync: (file) => fs.statSync(file),
    realpathSync: (file) => fs.realpathSync.native(file),
    readFileSync: (file) => fs.readFileSync(file, "utf8"),
    writeFileSync: (file, value) => {
      fs.writeFileSync(file, value, "utf8");
      if (path.basename(file) === "cgroup.kill") {
        fs.writeFileSync(path.join(path.dirname(file), "cgroup.procs"), "", "utf8");
        fs.writeFileSync(path.join(path.dirname(file), "cgroup.events"), "populated 0\n", "utf8");
      }
    },
    mkdirSync: (file, options) => {
      fs.mkdirSync(file, options);
      if (path.basename(file) === "nawabari") {
        fs.writeFileSync(path.join(file, "cgroup.subtree_control"), "+cpu +memory +pids\n", "utf8");
      }
      if (path.basename(file).startsWith("nawabari-")) {
        for (const [name, value] of [
          ["cgroup.procs", ""],
          ["cgroup.events", "populated 0\n"],
          ["cpu.stat", "usage_usec 0\nuser_usec 0\nsystem_usec 0\nthrottled_usec 0\n"],
          ["memory.current", "0\n"],
          ["memory.peak", "0\n"],
          ["memory.events", "max 0\noom_kill 0\n"],
          ["pids.current", "0\n"],
          ["pids.events", "max 0\n"],
        ] as const) {
          fs.writeFileSync(path.join(file, name), value, "utf8");
        }
      }
    },
    rmdirSync: (file) => fs.rmSync(file, { recursive: true }),
  };
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n", "utf8");
  fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +memory +pids\n", "utf8");
  return { root, filesystem: native, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("owned observation reports subtree occupancy without adopting caller PIDs", () => {
  const testFixture = fixture();
  try {
    const created = createCgroupScope(
      { session_id: "session-a", execution_id: "run-a" },
      { root: testFixture.root, filesystem: testFixture.filesystem, boot_id: "boot-a" },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    fs.writeFileSync(path.join(created.value.path, "cgroup.events"), "populated 1\n", "utf8");
    fs.writeFileSync(path.join(created.value.path, "cgroup.procs"), "4242\n", "utf8");
    const execution: SessionExecutionRecord = {
      schema_version: 1,
      session_id: "session-a",
      execution_id: "run-a",
      boot_id: "boot-a",
      state: "active",
      cgroups: {
        contract_id: created.value.contract_id,
        root: created.value.root,
        parent: created.value.parent,
        path: created.value.path,
        name: created.value.name,
        boot_id: "boot-a",
        identity: created.value.identity,
        scope: created.value,
      },
    };
    const observed = observeOwnedExecution(execution);
    assert.equal(observed.ok, true, observed.ok ? "" : JSON.stringify(observed.error));
    if (!observed.ok) return;
    assert.equal(observed.value.state, "active");
    assert.deepEqual(observed.value.cgroups?.population.processes, [4242]);
    assert.deepEqual(serializeSessionExecutionRecord(execution).cgroups, {
      contract_id: created.value.contract_id,
      root: created.value.root,
      parent: created.value.parent,
      path: created.value.path,
      name: created.value.name,
      boot_id: "boot-a",
      identity: { session_id: "session-a", execution_id: "run-a" },
    });
  } finally {
    testFixture.cleanup();
  }
});

test("termination requires exact session, execution, and boot identity and uses cgroup.kill", () => {
  const testFixture = fixture();
  try {
    const created = createCgroupScope(
      { session_id: "session-a", execution_id: "run-b" },
      { root: testFixture.root, filesystem: testFixture.filesystem, boot_id: "boot-a" },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    fs.writeFileSync(path.join(created.value.path, "cgroup.events"), "populated 1\n", "utf8");
    fs.writeFileSync(path.join(created.value.path, "cgroup.procs"), "4242\n", "utf8");
    const execution: SessionExecutionRecord = {
      schema_version: 1,
      session_id: "session-a",
      execution_id: "run-b",
      boot_id: "boot-a",
      state: "terminating",
      cgroups: {
        contract_id: created.value.contract_id,
        root: created.value.root,
        parent: created.value.parent,
        path: created.value.path,
        name: created.value.name,
        boot_id: "boot-a",
        identity: created.value.identity,
        scope: created.value,
      },
    };
    const wrongBoot = terminateOwnedExecution(execution, {
      kind: "terminate",
      session_id: "session-a",
      execution_id: "run-b",
      boot_id: "boot-other",
    });
    assert.equal(wrongBoot.ok, false);
    assert.equal(fs.readFileSync(path.join(created.value.path, "cgroup.procs"), "utf8"), "4242\n");

    const terminated = terminateOwnedExecution(execution, {
      kind: "terminate",
      session_id: "session-a",
      execution_id: "run-b",
      boot_id: "boot-a",
    });
    assert.equal(terminated.ok, true, terminated.ok ? "" : JSON.stringify(terminated.error));
    if (!terminated.ok) return;
    assert.equal(terminated.value.killed, true);
    assert.equal(terminated.value.population_after.state, "empty");
    assert.equal(terminated.value.scope_removed, true);
    assert.equal(terminated.value.record_terminalized, true);
    assert.equal(terminated.value.record.state, "terminal");
    assert.equal(fs.existsSync(created.value.path), false);
  } finally {
    testFixture.cleanup();
  }
});
