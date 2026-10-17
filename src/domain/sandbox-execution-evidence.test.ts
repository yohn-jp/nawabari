import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  makeSandboxRawOutput,
  observeSandboxExecutionStart,
  observeSandboxExecutionTermination,
  parseBubblewrapInfo,
} from "./sandbox-execution-evidence.js";

function writeProcess(
  root: string,
  pid: number,
  startTicks: string,
  namespaces: Readonly<Record<string, string>>,
): void {
  const processDirectory = path.join(root, String(pid));
  const namespaceDirectory = path.join(processDirectory, "ns");
  fs.mkdirSync(namespaceDirectory, { recursive: true });
  const fields = ["S", ...Array.from({ length: 18 }, () => "0"), startTicks];
  fs.writeFileSync(path.join(processDirectory, "stat"), `${pid} (test process) ${fields.join(" ")}\n`);
  for (const [name, identity] of Object.entries(namespaces)) {
    fs.symlinkSync(identity, path.join(namespaceDirectory, name));
  }
}

function procRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-physical-evidence-"));
}

const TARGET_NAMESPACES = {
  pid: "pid:[100]",
  user: "user:[101]",
  mnt: "mnt:[102]",
  ipc: "ipc:[103]",
  uts: "uts:[104]",
};

const CALLER_NAMESPACES = {
  pid: "pid:[200]",
  user: "user:[201]",
  mnt: "mnt:[202]",
  ipc: "ipc:[203]",
  uts: "uts:[204]",
};

test("Bubblewrap info parsing accepts only a bounded positive child PID", () => {
  assert.equal(parseBubblewrapInfo('{"child-pid": 42, "namespace_ids": []}'), 42);
  assert.equal(parseBubblewrapInfo('{"child-pid": 0}'), null);
  assert.equal(parseBubblewrapInfo('{"child-pid": "42"}'), null);
  assert.equal(parseBubblewrapInfo("x".repeat(4_097)), null);
});

test("start and termination evidence observes namespaces and cleanup from procfs", async () => {
  const root = procRoot();
  try {
    writeProcess(root, 100, "300", TARGET_NAMESPACES);
    writeProcess(root, 200, "400", CALLER_NAMESPACES);

    const start = observeSandboxExecutionStart(100, root, 200);
    assert.equal(start.state, "observed");
    assert.equal(start.outer_pid, 100);
    assert.equal(start.namespaces.pid.distinct_from_caller, true);
    assert.equal(start.namespaces.user.distinct_from_caller, true);
    assert.equal(start.namespaces.mount.distinct_from_caller, true);
    assert.equal(start.namespaces.ipc.distinct_from_caller, true);
    assert.equal(start.namespaces.uts.distinct_from_caller, true);

    const populated = await observeSandboxExecutionTermination(start, "timeout", {
      proc_root: root,
      cleanup_timeout_ms: 1,
      retry_ms: 1,
    });
    assert.equal(populated.termination.state, "observed-running");
    assert.equal(populated.cleanup.state, "observed-populated");
    assert.equal(populated.cleanup.process_count, 1);

    fs.rmSync(path.join(root, "100"), { recursive: true, force: true });
    const empty = await observeSandboxExecutionTermination(start, "timeout", { proc_root: root });
    assert.equal(empty.termination.state, "observed-exited");
    assert.equal(empty.termination.reason, "timeout");
    assert.equal(empty.cleanup.state, "observed-empty");
    assert.equal(empty.cleanup.process_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an unobservable namespace remains unknown and raw streams preserve exact bytes", () => {
  const root = procRoot();
  try {
    const start = observeSandboxExecutionStart(900, root, 901);
    assert.equal(start.state, "unknown");
    assert.equal(start.namespaces.pid.identity, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const stdout = Buffer.from([0x00, 0xff, 0x61]);
  const raw = makeSandboxRawOutput({
    stdout,
    stderr: Buffer.from("stderr"),
    observed_stdout_bytes: stdout.byteLength,
    observed_stderr_bytes: 6,
    complete: true,
    capture_mode: "pipes",
  });
  assert.equal(Buffer.from(raw.stdout, "base64").equals(stdout), true);
  assert.equal(Buffer.from(raw.stderr, "base64").toString("utf8"), "stderr");
  assert.equal(raw.stdout_bytes, 3);
  assert.equal(raw.complete, true);
  assert.equal(raw.truncated, false);
});
