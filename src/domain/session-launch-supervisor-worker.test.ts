import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  attachProcessToCgroup,
  cleanupCgroupScope,
  createCgroupScope,
  readCgroupPopulation,
  resolveManagedCgroupRoot,
  type CgroupScope,
} from "./cgroups-v2.js";
import { decideExecutionAdmission } from "./session-admission-decision.js";
import { serializeTrustedSupervisorGoMessage, type SupervisorStartRequest } from "./session-launch-supervisor.js";
import { runTrustedSessionSupervisorWorker } from "./session-launch-supervisor-worker.js";
import type { SandboxExecutionEvidenceSnapshot } from "./sandbox-execution-evidence.js";
import { sandboxExecutionMockSuccess } from "../testing/sandbox-execution-evidence-mock.js";
import type { ObservedSandboxProcessResult } from "./sandbox-physical-execution.js";

type CompiledSupervisorModule = typeof import("./session-launch-supervisor.js");
type CompiledSupervisorResult = Awaited<ReturnType<CompiledSupervisorModule["runSessionLaunchSupervisor"]>>;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function compiledPackageArtifacts(): { readonly supervisor: string; readonly worker: string } {
  const supervisor = path.join(repositoryRoot, "dist", "domain", "session-launch-supervisor.js");
  const worker = path.join(repositoryRoot, "dist", "domain", "session-launch-supervisor-worker.js");
  if (!fs.existsSync(supervisor) || !fs.existsSync(worker)) {
    throw new Error("BLOCKED: the owning verification lane did not prepare a fresh compiled worker artifact");
  }
  return { supervisor, worker };
}

const admissionFacts = {
  session_id: "session-worker",
  execution_id: "execution-worker",
  current: {
    lifecycle: "active" as const,
    launch_permitted: true,
    profile_token: "profile-token",
    profile_revision: 1,
    filesystem_token: "filesystem-token",
    filesystem_revision: 1,
    generation: 1,
    epoch: 1,
  },
  expected: {
    lifecycle: "active" as const,
    launch_permitted: true,
    profile_token: "profile-token",
    profile_revision: 1,
    filesystem_token: "filesystem-token",
    filesystem_revision: 1,
    generation: 1,
    epoch: 1,
  },
};

const admission = decideExecutionAdmission(admissionFacts);
assert.equal(admission.ok, true);
if (!admission.ok || !admission.value.admitted) throw new Error("worker admission fixture is invalid");
const reservation = admission.value.reservation;

function request(overrides: Partial<SupervisorStartRequest["payload"]> = {}): SupervisorStartRequest {
  return {
    reservation,
    trusted: { entrypoint: "/worktree/ignored.js", cwd: "/worktree" },
    payload: {
      executable: process.execPath,
      args: ["-e", "process.stdout.write('worker-out'); process.stderr.write('worker-err')"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      procfs: { mode: "private", reason: null },
      stdio: ["ignore", "pipe", "pipe", 3],
      seccomp_fd: 3,
      ...overrides,
    },
  };
}

test("rejects EOF before spawning the payload", async () => {
  const control = new PassThrough();
  const result = new PassThrough();
  let spawned = 0;
  const outcome = runTrustedSessionSupervisorWorker({
    control,
    result,
    spawn_process: (() => {
      spawned += 1;
      throw new Error("payload must not spawn");
    }) as typeof import("node:child_process").spawn,
  });
  control.end();
  assert.deepEqual(await outcome, { status: "unknown" });
  assert.equal(spawned, 0);
});

test("rejects malformed GO before spawning the payload", async () => {
  const control = new PassThrough();
  const result = new PassThrough();
  let spawned = 0;
  const outcome = runTrustedSessionSupervisorWorker({
    control,
    result,
    spawn_process: (() => {
      spawned += 1;
      throw new Error("payload must not spawn");
    }) as typeof import("node:child_process").spawn,
  });
  control.end('{"type":"GO","contract_id":"wrong"}\n');
  assert.deepEqual(await outcome, { status: "unknown" });
  assert.equal(spawned, 0);
});

test("rejects an oversized pre-GO packet before spawning the payload", async () => {
  const control = new PassThrough();
  const result = new PassThrough();
  let spawned = 0;
  const outcome = runTrustedSessionSupervisorWorker({
    control,
    result,
    spawn_process: (() => {
      spawned += 1;
      throw new Error("payload must not spawn");
    }) as typeof import("node:child_process").spawn,
  });
  control.end(Buffer.alloc(2 * 1_024 * 1_024 + 1, 0x7b));
  assert.deepEqual(await outcome, { status: "unknown" });
  assert.equal(spawned, 0);
});

test("executes only after GO and carries the actual bounded result", async () => {
  const control = new PassThrough();
  const result = new PassThrough();
  const wire: Buffer[] = [];
  result.on("data", (value) => wire.push(Buffer.from(value)));
  let spawnedPayload = false;
  const worker = runTrustedSessionSupervisorWorker({
    control,
    result,
    spawn_process: ((...args: Parameters<typeof spawn>) => {
      spawnedPayload = true;
      return spawn(...args);
    }) as typeof spawn,
    run_observed_child: async (_child, options) => {
      assert.equal(spawnedPayload, true, "the payload may spawn only after the valid GO message");
      assert.equal(options.procfs.mode, "private");
      const mocked = sandboxExecutionMockSuccess({
        exit_code: 0,
        signal: null,
        stdout: "worker-out",
        stderr: "worker-err",
        duration_ms: 3,
      });
      if (!mocked.ok) return mocked;
      const value: ObservedSandboxProcessResult = {
        ...mocked.value,
        execution_id: options.execution_id,
        physical_execution: {
          ...mocked.value.physical_execution,
          correlation_id: options.execution_id,
        },
      };
      return { ok: true, value };
    },
  });
  control.end(`${serializeTrustedSupervisorGoMessage(request())}\n`);
  const outcome = await worker;
  assert.equal(outcome.status, "completed");
  if (outcome.status !== "completed") return;
  assert.equal((outcome.result as { stdout: string }).stdout, "worker-out");
  assert.equal((outcome.result as { stderr: string }).stderr, "worker-err");
  const envelope = JSON.parse(Buffer.concat(wire).toString("utf8")) as {
    status: string;
    result: { exit_code: number; stdout: string; stderr: string; physical_execution: { start: { state: string } } };
  };
  assert.equal(envelope.status, "completed");
  assert.equal(envelope.result.exit_code, 0);
  assert.equal(envelope.result.stdout, "worker-out");
  assert.equal(envelope.result.stderr, "worker-err");
  assert.equal(envelope.result.physical_execution.start.state, "unknown");
});

test("the compiled worker rejects a non-Bubblewrap launch with unknown physical evidence", async (t) => {
  if (process.env.NAWABARI_TEST_LANE !== "compiled-worker") {
    t.skip("run via pnpm test:compiled-worker");
    return;
  }
  const { worker: workerEntrypoint } = compiledPackageArtifacts();
  const seccompFd = fs.openSync("/dev/null", "r");
  try {
    const child = spawn(process.execPath, [workerEntrypoint], {
      cwd: path.dirname(path.dirname(workerEntrypoint)),
      env: { ...process.env },
      shell: false,
      stdio: ["ignore", "ignore", "ignore", seccompFd, "pipe", "pipe"],
    });
    const channels = child.stdio as Array<Readable | Writable | null | undefined>;
    const control = channels[4] as Writable | null | undefined;
    const result = channels[5] as Readable | null | undefined;
    assert.ok(control !== null && typeof control !== "undefined" && "end" in control);
    assert.ok(result !== null && typeof result !== "undefined");
    const wire: Buffer[] = [];
    result.on("data", (value) => wire.push(Buffer.from(value)));
    control.end(`${serializeTrustedSupervisorGoMessage(request())}\n`);
    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (exitCode, signal) => resolve([exitCode, signal]));
    });
    assert.equal(code, 0);
    const envelope = JSON.parse(Buffer.concat(wire).toString("utf8")) as {
      status: string;
      error?: string;
      result?: SandboxExecutionEvidenceSnapshot;
    };
    assert.equal(envelope.status, "failed", "a non-Bubblewrap child cannot produce a positive physical receipt");
    assert.equal(typeof envelope.error, "string");
    assert.ok(envelope.result, "the failed worker envelope retains the observer's evidence snapshot");
    assert.equal(envelope.result.schema_version, 1);
    assert.equal(envelope.result.execution_id, reservation.execution_id);
    assert.equal(envelope.result.exit_code, 0);
    assert.equal(envelope.result.signal, null);
    assert.deepEqual(envelope.result.raw_output, {
      encoding: "base64",
      capture_mode: "pipes",
      stdout: Buffer.from("worker-out").toString("base64"),
      stderr: Buffer.from("worker-err").toString("base64"),
      stdout_bytes: Buffer.byteLength("worker-out"),
      stderr_bytes: Buffer.byteLength("worker-err"),
      observed_stdout_bytes: Buffer.byteLength("worker-out"),
      observed_stderr_bytes: Buffer.byteLength("worker-err"),
      complete: true,
      truncated: false,
    });
    assert.equal(envelope.result.physical_execution.correlation_id, reservation.execution_id);
    assert.equal(envelope.result.physical_execution.start.state, "unknown");
    assert.equal(envelope.result.physical_execution.termination.state, "unknown");
    assert.equal(envelope.result.physical_execution.cleanup.state, "unknown");
  } finally {
    fs.closeSync(seccompFd);
  }
});

test("the compiled trusted supervisor keeps an immediate payload descendant in its owned cgroup", async (t) => {
  if (process.env.NAWABARI_TEST_LANE !== "linux-system") {
    t.skip("run via pnpm test:linux:system");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("the cgroups v2 descendant conformance requires supported Linux");
    return;
  }
  const root = resolveManagedCgroupRoot();
  if (!root.ok) {
    t.skip(`supported cgroups v2 capability unavailable (${root.error.message})`);
    return;
  }
  const probe = createCgroupScope(
    { session_id: "descendant-conformance-probe", execution_id: randomUUID() },
    { root: root.value },
  );
  if (!probe.ok) {
    const reason = probe.error.details?.reason;
    if (
      probe.error.code === "SANDBOX_CAPABILITY_UNAVAILABLE" ||
      (probe.error.code === "SANDBOX_CGROUP_SETUP_FAILED" &&
        typeof reason === "string" &&
        /\b(?:EACCES|EPERM|EROFS)\b/u.test(reason))
    ) {
      t.skip(`cgroups v2 scope creation unavailable (${probe.error.message})`);
      return;
    }
    throw probe.error;
  }
  const cleaned = cleanupCgroupScope(probe.value);
  assert.equal(cleaned.ok, true, cleaned.ok ? "" : cleaned.error.message);
  const { supervisor: supervisorEntrypoint } = compiledPackageArtifacts();
  const compiledSupervisor = (await import(pathToFileURL(supervisorEntrypoint).href)) as CompiledSupervisorModule;
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-451-descendant-"));
  const marker = path.join(tempDirectory, "marker.txt");
  const release = path.join(tempDirectory, "release.txt");
  let seccompFd: number | null = null;
  let scopeCreated = false;
  let runPromise: Promise<CompiledSupervisorResult> | null = null;
  try {
    seccompFd = fs.openSync("/dev/null", "r");
    let runScope: CgroupScope | null = null;
    runPromise = compiledSupervisor.runSessionLaunchSupervisor({
      admission: reservation,
      trusted: {
        entrypoint: supervisorEntrypoint,
        cwd: path.dirname(supervisorEntrypoint),
        env: { PATH: process.env.PATH ?? "/usr/bin" },
      },
      payload: {
        executable: process.execPath,
        args: [
          "-e",
          (() => {
            const descendantCode = [
              "const fs = require('node:fs')",
              `const release = ${JSON.stringify(release)}`,
              "const wait = () => { if (fs.existsSync(release)) process.exit(0); setTimeout(wait, 10) }",
              "wait()",
            ].join(";");
            return [
              "const fs = require('node:fs')",
              "const { spawn } = require('node:child_process')",
              `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'ignore' })`,
              `fs.writeFileSync(${JSON.stringify(marker)}, String(descendant.pid))`,
              "descendant.once('exit', () => process.exit(0))",
            ].join(";");
          })(),
        ],
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "/usr/bin" },
        procfs: { mode: "private", reason: null },
        stdio: ["ignore", "pipe", "pipe", seccompFd],
        seccomp_fd: seccompFd,
      },
      result_timeout_ms: 5_000,
      cgroup: {
        required: true,
        root: root.value,
        create_scope: (identity, options) => {
          const created = createCgroupScope(identity, {
            root: options?.root,
            limits: options?.limits,
            filesystem: options?.filesystem,
          });
          if (created.ok) {
            runScope = created.value;
            scopeCreated = true;
          }
          return created;
        },
        attach_process: (scope, pid) => {
          return attachProcessToCgroup(scope, pid);
        },
        cleanup_scope: (scope) => {
          return cleanupCgroupScope(scope);
        },
      },
      process_factory: compiledSupervisor.createTrustedSupervisorProcess,
    });

    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!fs.existsSync(marker)) {
      const outcome = await runPromise;
      if (!outcome.ok && !scopeCreated) {
        const code = outcome.error.code;
        if (code === "SANDBOX_CAPABILITY_UNAVAILABLE" || code === "SANDBOX_CGROUP_SETUP_FAILED") {
          throw new Error(`BLOCKED: supported cgroups v2 capability unavailable (${outcome.error.message})`);
        }
      }
      throw new Error("The compiled payload did not fork promptly.");
    }
    const descendantPid = Number(fs.readFileSync(marker, "utf8").trim());
    if (!Number.isSafeInteger(descendantPid) || descendantPid < 1) {
      throw new Error("The compiled payload did not report a valid descendant pid.");
    }

    if (runScope === null) throw new Error("The production supervisor did not create a cgroup scope.");
    let population = readCgroupPopulation(runScope);
    for (let attempt = 0; attempt < 40 && !population.processes?.includes(descendantPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      population = readCgroupPopulation(runScope);
    }
    assert.equal(population.state, "populated");
    assert.ok(population.processes?.includes(descendantPid), JSON.stringify(population));
    fs.writeFileSync(release, "release");
    const outcome = await runPromise;
    if (!outcome.ok && !scopeCreated) {
      const code = outcome.error.code;
      if (code === "SANDBOX_CAPABILITY_UNAVAILABLE" || code === "SANDBOX_CGROUP_SETUP_FAILED") {
        throw new Error(`BLOCKED: supported cgroups v2 capability unavailable (${outcome.error.message})`);
      }
    }
    assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error.message);
    if (outcome.ok) assert.equal(outcome.value.status, "completed");
  } finally {
    fs.writeFileSync(release, "release");
    if (runPromise !== null) await runPromise.catch(() => undefined);
    if (seccompFd !== null) fs.closeSync(seccompFd);
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
