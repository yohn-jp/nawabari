import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { sandboxExecutionEvidenceFromError } from "./sandbox-execution-evidence.js";
import { DomainError } from "./errors.js";
import { runObservedSandboxChild } from "./sandbox-physical-execution.js";

test("the physical gate refuses a child whose namespaces are shared with the caller", async () => {
  const source = [
    "const fs = require('node:fs')",
    "fs.writeSync(4, JSON.stringify({ 'child-pid': process.pid }, null, 2) + '\\n')",
    "const gate = Buffer.alloc(1)",
    "fs.readSync(5, gate, 0, 1, null)",
    "fs.writeSync(1, 'payload-released')",
  ].join(";");
  const child = spawn(process.execPath, ["-e", source], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "pipe"],
  });

  const result = await runObservedSandboxChild(child, {
    execution_id: "gate-test-execution",
    procfs: { mode: "denied", reason: "parent-procfs-has-overmounts" },
    timeout_ms: 5_000,
    max_output_bytes: 1_024,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SANDBOX_EXECUTION_FAILED");
  const evidence = sandboxExecutionEvidenceFromError(result.error as DomainError);
  assert.ok(evidence);
  assert.equal(evidence.execution_id, "gate-test-execution");
  assert.equal(evidence.physical_execution.procfs.mode, "denied");
  assert.equal(evidence.physical_execution.procfs.reason, "parent-procfs-has-overmounts");
  assert.equal(evidence.physical_execution.start.state, "unknown");
  assert.equal(evidence.physical_execution.cleanup.state, "unknown");
  assert.equal(Buffer.from(evidence.raw_output.stdout, "base64").toString("utf8"), "");
});

test("output-limit errors preserve bounded raw bytes and explicit truncation", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "const fs=require('node:fs'); fs.writeSync(1, Buffer.alloc(128 * 1024, 0xff)); setTimeout(()=>{},5000)"],
    { shell: false, stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "pipe"] },
  );
  const result = await runObservedSandboxChild(child, {
    execution_id: "output-limit-execution",
    procfs: { mode: "private", reason: null },
    timeout_ms: 2_000,
    max_output_bytes: 2,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SANDBOX_OUTPUT_LIMIT");
  const evidence = sandboxExecutionEvidenceFromError(result.error as DomainError);
  assert.ok(evidence);
  assert.deepEqual([...Buffer.from(evidence.raw_output.stdout, "base64")], [0xff, 0xff]);
  assert.ok(evidence.raw_output.observed_stdout_bytes > evidence.raw_output.stdout_bytes);
  assert.equal(evidence.raw_output.complete, false);
  assert.equal(evidence.raw_output.truncated, true);
  assert.equal(evidence.physical_execution.termination.reason, "output-limit");
});

test("owner cancellation preserves captured bytes and marks physical termination unknown when unobservable", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('prefix'); setTimeout(()=>{},5000)"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const pending = runObservedSandboxChild(child, {
    execution_id: "cancelled-execution",
    procfs: { mode: "private", reason: null },
    signal: controller.signal,
    timeout_ms: 2_000,
    max_output_bytes: 1_024,
  });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SANDBOX_EXECUTION_FAILED");
  const evidence = sandboxExecutionEvidenceFromError(result.error as DomainError);
  assert.ok(evidence);
  assert.equal(Buffer.from(evidence.raw_output.stdout, "base64").toString("utf8"), "prefix");
  assert.equal(evidence.raw_output.complete, false);
  assert.equal(evidence.physical_execution.termination.reason, "cancelled");
  assert.equal(evidence.physical_execution.start.state, "unknown");
});

test("an invalid observation request kills the already-spawned, gated child", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe", "ignore", "pipe", "pipe"],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  const result = await runObservedSandboxChild(child, {
    execution_id: "invalid-observation-request",
    procfs: { mode: "private", reason: null },
    timeout_ms: 0,
  });
  const exit = await closed;

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(exit.signal, "SIGKILL");
});
