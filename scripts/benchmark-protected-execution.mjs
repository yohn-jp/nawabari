#!/usr/bin/env node
// Measure the canonical protected session route in a disposable local Git
// repository.  The control path below is comparison evidence only; it is
// never selected when protected execution is unavailable or fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RUNS = 5;
const DEFAULT_PARALLEL = 4;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const TIME_MARKER = "__NAWABARI_TIME__";
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");
const CLI_ENTRYPOINT = path.join(REPOSITORY_ROOT, "dist", "index.js");
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "package.json"), "utf8"));

const PROTECTED_COMMAND = ["node", "-e", "process.stdout.write('ok')"];
const FAILURE_COMMAND = ["node", "-e", "process.exit(17)"];
const CONTROL_COMMAND = ["-e", "process.stdout.write('ok')"];

function usage() {
  return [
    "Usage: pnpm run benchmark:protected-execution -- [options]",
    "",
    "Options:",
    `  --runs <number>       Samples per serial phase (default: ${DEFAULT_RUNS})`,
    `  --parallel <number>   Sessions in each parallel sample (default: ${DEFAULT_PARALLEL})`,
    "  --output <path>       Also write the bounded JSON report to this path",
    "  --keep-temp           Keep disposable fixtures after the run",
    "  --help                Show this help",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, parallel: DEFAULT_PARALLEL, output: undefined, keepTemp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      return null;
    }
    if (argument === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    const parts = argument.split("=");
    const name = parts[0];
    const inlineValue = parts.length > 1 ? parts.slice(1).join("=") : undefined;
    if (name !== "--runs" && name !== "--parallel" && name !== "--output") {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === "") throw new Error(`${name} requires a value`);
    if (name === "--output") {
      options.output = path.resolve(value);
      continue;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
    if (name === "--runs" && (parsed < 3 || parsed > 100)) {
      throw new Error("--runs must be an integer between 3 and 100");
    }
    if (name === "--parallel" && (parsed < 2 || parsed > 32)) {
      throw new Error("--parallel must be an integer between 2 and 32");
    }
    options[name === "--runs" ? "runs" : "parallel"] = parsed;
  }
  return options;
}

function commandOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runChecked(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: MAX_CAPTURE_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const status = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${status}: ${commandOutput(result).slice(-2000)}`);
  }
  return result.stdout ?? "";
}

function appendBounded(chunks, state, value) {
  const text = String(value);
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  if (remaining <= 0) return;
  const selected = text.slice(0, remaining);
  chunks.push(selected);
  state.bytes += Buffer.byteLength(selected, "utf8");
}

function timeBinary() {
  const candidate = "/usr/bin/time";
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function parseTime(stderr) {
  const pattern = new RegExp(`${TIME_MARKER} ([0-9.]+) ([0-9.]+) ([0-9.]+) ([0-9]+) (-?[0-9]+)`);
  const match = stderr.match(pattern);
  if (match === null) return { source: "wall-only", user_ms: null, system_ms: null, max_rss_kib: null };
  return {
    source: "gnu-time",
    user_ms: Math.round(Number(match[2]) * 1_000),
    system_ms: Math.round(Number(match[3]) * 1_000),
    max_rss_kib: Number(match[4]),
  };
}

/** Execute one bounded command without shell interpretation. */
export function runTimed(command, args, cwd, environment = process.env) {
  const started = performance.now();
  const timer = timeBinary();
  const actualCommand = timer ?? command;
  const actualArgs = timer ? ["-f", `${TIME_MARKER} %e %U %S %M %x`, command, ...args] : args;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(actualCommand, actualArgs, {
        cwd,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let spawnError = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, COMMAND_TIMEOUT_MS);
    child.stdout?.on("data", (value) => appendBounded(stdout, stdoutState, value));
    child.stderr?.on("data", (value) => appendBounded(stderr, stderrState, value));
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      const stderrText = stderr.join("");
      const timing = parseTime(stderrText);
      resolve({
        status,
        signal,
        timed_out: timedOut,
        spawn_error: spawnError?.message ?? null,
        stdout: stdout.join(""),
        stderr: stderrText.replace(new RegExp(`${TIME_MARKER} [^\\n]*\\n?`, "g"), ""),
        wall_ms: Math.round(performance.now() - started),
        ...timing,
      });
    });
  });
}

function environment() {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "true" };
}

async function invokeCli(args, cwd, acceptedStatuses = [0]) {
  const result = await runTimed(process.execPath, [CLI_ENTRYPOINT, "--json", ...args], cwd, environment());
  if (result.spawn_error !== null) throw new Error(`CLI spawn failed: ${result.spawn_error}`);
  if (result.timed_out) throw new Error(`CLI command timed out: ${args.slice(0, 3).join(" ")}`);
  if (!acceptedStatuses.includes(result.status ?? -1)) {
    throw new Error(`CLI command failed (${result.status}): ${result.stderr.slice(-2000)}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  const document = lines.at(-1);
  if (document === undefined) throw new Error(`CLI returned no JSON: ${result.stderr.slice(-2000)}`);
  let payload;
  try {
    payload = JSON.parse(document);
  } catch (error) {
    throw new Error(`CLI returned invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { payload, timing: result };
}

function timingEvidence(result) {
  return {
    wall_ms: result.wall_ms,
    user_ms: result.user_ms,
    system_ms: result.system_ms,
    max_rss_kib: result.max_rss_kib,
    status: result.status,
  };
}

function summarize(values, unit = "ms") {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  const medianKey = `median_${unit}`;
  const minKey = `min_${unit}`;
  const maxKey = `max_${unit}`;
  const spreadKey = `spread_${unit}`;
  if (finite.length === 0) return { count: 0, [medianKey]: null, [minKey]: null, [maxKey]: null, [spreadKey]: null };
  const middle = Math.floor(finite.length / 2);
  const median = finite.length % 2 === 0 ? (finite[middle - 1] + finite[middle]) / 2 : finite[middle];
  return {
    count: finite.length,
    [medianKey]: median,
    [minKey]: finite[0],
    [maxKey]: finite.at(-1),
    [spreadKey]: finite.at(-1) - finite[0],
  };
}

export function summarizeTimings(records) {
  return {
    wall: summarize(records.map((record) => record.wall_ms)),
    user: summarize(records.map((record) => record.user_ms)),
    system: summarize(records.map((record) => record.system_ms)),
    max_rss_kib: summarize(
      records.map((record) => record.max_rss_kib),
      "kib",
    ),
  };
}

function gitFixture(root) {
  const repository = path.join(root, "repository");
  const worktreeRoot = path.join(root, "worktrees");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  runChecked("git", ["init", "--quiet", "--initial-branch=main", repository], REPOSITORY_ROOT);
  runChecked("git", ["config", "user.name", "nawabari-benchmark"], repository);
  runChecked("git", ["config", "user.email", "benchmark@example.invalid"], repository);
  runChecked("git", ["commit", "--quiet", "--allow-empty", "-m", "benchmark fixture"], repository);
  return { repository, worktreeRoot };
}

let sessionCounter = 0;
const activeSessions = new Map();

async function provision(fixture, label) {
  sessionCounter += 1;
  const branch = `benchmark/${label}-${sessionCounter}`;
  const result = await invokeCli(
    ["session", "create", "--branch", branch, "--worktree-root", fixture.worktreeRoot],
    fixture.repository,
  );
  if (result.payload?.ok !== true) throw new Error(`session create rejected: ${JSON.stringify(result.payload)}`);
  const sessionId = result.payload.session_id;
  const worktree = result.payload.worktree;
  if (typeof sessionId !== "string" || typeof worktree !== "string") {
    throw new Error("session create returned incomplete ownership metadata");
  }
  const resolvedWorktree = path.resolve(worktree);
  const resolvedRoot = path.resolve(fixture.worktreeRoot);
  if (!(resolvedWorktree === resolvedRoot || resolvedWorktree.startsWith(`${resolvedRoot}${path.sep}`))) {
    throw new Error("session create returned a worktree outside the benchmark fixture");
  }
  const session = { id: sessionId, worktree: resolvedWorktree, provisioning: timingEvidence(result.timing) };
  activeSessions.set(sessionId, { fixture, session });
  return session;
}

async function discard(fixture, session) {
  const result = await invokeCli(["session", "discard", "--session", session.id], fixture.repository);
  if (result.payload?.ok !== true) throw new Error(`session discard rejected: ${JSON.stringify(result.payload)}`);
  activeSessions.delete(session.id);
  return timingEvidence(result.timing);
}

function assertProtectedSuccess(result) {
  if (result.payload?.ok !== true || result.payload.exit_code !== 0 || result.payload.signal !== null) {
    throw new Error(
      `protected launch did not succeed: ${JSON.stringify({ ok: result.payload?.ok, code: result.payload?.code })}`,
    );
  }
}

async function protectedLaunch(session, fixture, command = PROTECTED_COMMAND) {
  const result = await invokeCli(["session", "run", "--session", session.id, "--", ...command], session.worktree);
  assertProtectedSuccess(result);
  return {
    timing: timingEvidence(result.timing),
    cgroup: cgroupEvidence(result.payload),
  };
}

async function controlLaunch(session) {
  const result = await runTimed(process.execPath, CONTROL_COMMAND, session.worktree, environment());
  if (result.status !== 0 || result.signal !== null || result.timed_out) {
    throw new Error(`control launch failed with status ${result.status}`);
  }
  return timingEvidence(result);
}

function cgroupEvidence(payload) {
  const resources = payload?.resources;
  if (resources === undefined || resources === null || typeof resources !== "object") {
    return { observed: false };
  }
  const accounting = resources.accounting;
  if (accounting === null || typeof accounting !== "object") return { observed: false };
  const numeric = {};
  for (const field of [
    "cpu_usage_usec",
    "cpu_user_usec",
    "cpu_system_usec",
    "cpu_throttled_usec",
    "memory_current_bytes",
    "memory_peak_bytes",
    "pids_current",
    "pids_max_events",
    "memory_oom_kill_events",
    "memory_max_events",
  ]) {
    if (typeof accounting[field] === "number") numeric[field] = accounting[field];
  }
  return { observed: true, contract_id: resources.cgroup_contract_id ?? null, accounting: numeric };
}

function addRecord(records, phase, sample, timing, extras = {}) {
  records.push({ phase, sample, ...timing, ...extras });
}

async function measureProvisioning(fixture, runs, records, cleanupRecords) {
  for (let sample = 1; sample <= runs; sample += 1) {
    const session = await provision(fixture, `provision-${sample}`);
    addRecord(records, "provisioning", sample, session.provisioning);
    const cleanup = await discard(fixture, session);
    addRecord(cleanupRecords, "discard", sample, cleanup);
  }
}

async function measureFirstLaunch(fixture, runs, records, cleanupRecords, protectedRecords) {
  for (let sample = 1; sample <= runs; sample += 1) {
    const session = await provision(fixture, `first-${sample}`);
    const launch = await protectedLaunch(session, fixture);
    addRecord(records, "first", sample, launch.timing);
    protectedRecords.push(launch);
    const cleanup = await discard(fixture, session);
    addRecord(cleanupRecords, "discard", sample, cleanup);
  }
}

async function measureRepeated(fixture, runs, records, cleanupRecords, protectedRecords) {
  for (let sample = 1; sample <= runs; sample += 1) {
    const session = await provision(fixture, `repeated-${sample}`);
    await protectedLaunch(session, fixture); // warm-up is intentionally not summarized as a repeated launch
    for (let repetition = 1; repetition <= runs; repetition += 1) {
      const launch = await protectedLaunch(session, fixture);
      addRecord(records, "repeated", sample, launch.timing, { repetition });
      protectedRecords.push(launch);
    }
    const cleanup = await discard(fixture, session);
    addRecord(cleanupRecords, "discard", sample, cleanup);
  }
}

async function measureParallel(fixture, runs, width, records, cleanupRecords, protectedRecords) {
  for (let sample = 1; sample <= runs; sample += 1) {
    const sessions = [];
    for (let index = 1; index <= width; index += 1)
      sessions.push(await provision(fixture, `parallel-${sample}-${index}`));
    const started = performance.now();
    const launches = await Promise.all(sessions.map((session) => protectedLaunch(session, fixture)));
    const batchMs = Math.round(performance.now() - started);
    launches.forEach((launch, index) => {
      addRecord(records, "parallel-launch", sample, launch.timing, { session_index: index + 1, batch_ms: batchMs });
      protectedRecords.push(launch);
    });
    for (const session of sessions) {
      const cleanup = await discard(fixture, session);
      addRecord(cleanupRecords, "discard", sample, cleanup);
    }
  }
}

async function measureControl(fixture, runs, width, records, cleanupRecords) {
  const serial = [];
  for (let sample = 1; sample <= runs; sample += 1) {
    const session = await provision(fixture, `control-${sample}`);
    const first = await controlLaunch(session);
    addRecord(serial, "first", sample, first);
    for (let repetition = 1; repetition <= runs; repetition += 1) {
      const repeated = await controlLaunch(session);
      addRecord(serial, "repeated", sample, repeated, { repetition });
    }
    const cleanup = await discard(fixture, session);
    addRecord(cleanupRecords, "discard", sample, cleanup);
  }
  const parallel = [];
  for (let sample = 1; sample <= runs; sample += 1) {
    const sessions = [];
    for (let index = 1; index <= width; index += 1)
      sessions.push(await provision(fixture, `control-parallel-${sample}-${index}`));
    const started = performance.now();
    const launches = await Promise.all(sessions.map((session) => controlLaunch(session)));
    const batchMs = Math.round(performance.now() - started);
    launches.forEach((launch, index) =>
      addRecord(parallel, "parallel-launch", sample, launch, { session_index: index + 1, batch_ms: batchMs }),
    );
    for (const session of sessions) {
      const cleanup = await discard(fixture, session);
      addRecord(cleanupRecords, "discard", sample, cleanup);
    }
  }
  return { serial, parallel };
}

async function measureFailure(fixture, runs, records, cleanupRecords, protectedRecords) {
  for (let sample = 1; sample <= runs; sample += 1) {
    const session = await provision(fixture, `failure-${sample}`);
    const result = await invokeCli(
      ["session", "run", "--session", session.id, "--", ...FAILURE_COMMAND],
      session.worktree,
      [17],
    );
    if (result.payload?.ok !== true || result.payload.exit_code !== 17) {
      throw new Error(`failure fixture did not preserve child failure: ${JSON.stringify(result.payload)}`);
    }
    const timing = timingEvidence(result.timing);
    addRecord(records, "failed-child", sample, timing, { child_exit_code: result.payload.exit_code });
    protectedRecords.push({ timing, cgroup: cgroupEvidence(result.payload) });
    const cleanup = await discard(fixture, session);
    addRecord(cleanupRecords, "discard-after-failure", sample, cleanup);
  }
}

function doctorEvidence(payload) {
  const sandbox = payload?.sandbox;
  if (sandbox === undefined || typeof sandbox !== "object") throw new Error("doctor returned no sandbox report");
  return {
    contract_id: sandbox.contract_id ?? null,
    schema_version: sandbox.schema_version ?? null,
    platform_supported: sandbox.platform_supported ?? false,
    ready: sandbox.ready ?? false,
    network_mode: sandbox.network_mode ?? null,
    required_capabilities: Array.isArray(sandbox.capabilities)
      ? sandbox.capabilities
          .filter((entry) => entry?.requirement === "required")
          .map((entry) => ({ id: entry.id, status: entry.status, code: entry.code }))
      : [],
    optional_capabilities: Array.isArray(sandbox.capabilities)
      ? sandbox.capabilities
          .filter((entry) => entry?.requirement === "optional")
          .map((entry) => ({ id: entry.id, status: entry.status, code: entry.code }))
      : [],
  };
}

function packageIdentity() {
  let commit = null;
  try {
    commit = runChecked("git", ["rev-parse", "HEAD"], REPOSITORY_ROOT).trim();
  } catch {
    // A source archive may not have Git metadata; the missing identity is
    // reported instead of being fabricated.
  }
  let pnpm = null;
  try {
    pnpm = runChecked("pnpm", ["--version"], REPOSITORY_ROOT).trim();
  } catch {
    // pnpm is not required by the runtime itself; the benchmark command is
    // still useful when invoked directly with node.
  }
  return {
    package: PACKAGE_JSON.name,
    version: PACKAGE_JSON.version,
    source_commit: commit,
    node: process.version,
    pnpm,
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpu_count: os.availableParallelism(),
  };
}

function summaryByPhase(records) {
  const phases = {};
  for (const phase of new Set(records.map((record) => record.phase))) {
    phases[phase] = summarizeTimings(records.filter((record) => record.phase === phase));
  }
  return phases;
}

function cleanupFixture(root, keepTemp) {
  if (!keepTemp) fs.rmSync(root, { recursive: true, force: true });
}

async function main(options) {
  if (!fs.existsSync(CLI_ENTRYPOINT)) {
    throw new Error("dist/index.js is missing; run `pnpm run build` before the benchmark");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-execution-benchmark-"));
  const fixture = gitFixture(root);
  const cleanupRecords = [];
  const protectedRecords = [];
  const provisioning = [];
  const first = [];
  const repeated = [];
  const parallel = [];
  const failures = [];
  let report;
  try {
    const doctorResult = await invokeCli(["doctor"], fixture.repository);
    const sandbox = doctorEvidence(doctorResult.payload);
    if (sandbox.ready !== true || sandbox.network_mode !== "inherited") {
      throw new Error(
        `protected execution is not ready (ready=${sandbox.ready}, network_mode=${sandbox.network_mode}); no ambient benchmark path was selected`,
      );
    }
    await measureProvisioning(fixture, options.runs, provisioning, cleanupRecords);
    await measureFirstLaunch(fixture, options.runs, first, cleanupRecords, protectedRecords);
    await measureRepeated(fixture, options.runs, repeated, cleanupRecords, protectedRecords);
    await measureParallel(fixture, options.runs, options.parallel, parallel, cleanupRecords, protectedRecords);
    await measureFailure(fixture, options.runs, failures, cleanupRecords, protectedRecords);
    const control = await measureControl(fixture, options.runs, options.parallel, [], cleanupRecords);
    const cgroupObserved = protectedRecords.filter((record) => record.cgroup.observed).map((record) => record.cgroup);
    report = {
      protocol: {
        contract: "nawabari.sandbox-execution.v1",
        route: "session run",
        alias_not_used: "session exec",
        runs: options.runs,
        parallel_sessions: options.parallel,
        command_timeout_ms: COMMAND_TIMEOUT_MS,
        sample_dimensions: [
          "session/worktree provisioning",
          "first protected launch",
          "repeated protected launch after one warm-up",
          "parallel protected launches across independent sessions",
          "failed protected child",
          "session discard cleanup",
        ],
        summary: "median and min/max spread; no SLA threshold is inferred",
      },
      environment: packageIdentity(),
      sandbox,
      resource_accounting: {
        source: timeBinary() === null ? "wall-only" : "GNU /usr/bin/time",
        fields: ["wall_ms", "user_ms", "system_ms", "max_rss_kib"],
        cgroup: cgroupObserved.length === 0 ? { observed: false } : { observed: true, samples: cgroupObserved.length },
      },
      measurements: {
        provisioning: { samples: provisioning, summary: summarizeTimings(provisioning) },
        protected_first: { samples: first, summary: summarizeTimings(first) },
        protected_repeated: { samples: repeated, summary: summarizeTimings(repeated) },
        protected_parallel: {
          samples: parallel,
          per_launch_summary: summarizeTimings(parallel),
          batch_summary: summarize(parallel.map((record) => record.batch_ms)),
        },
        protected_failure: { samples: failures, summary: summarizeTimings(failures) },
        cleanup: { samples: cleanupRecords, summary: summaryByPhase(cleanupRecords) },
        control_comparison_only: {
          supported_fallback: false,
          serial: { samples: control.serial, summary: summaryByPhase(control.serial) },
          parallel: { samples: control.parallel, summary: summaryByPhase(control.parallel) },
        },
      },
      architecture_evidence: {
        execution_model: "bubblewrap process/namespace boundary",
        per_session_vm: false,
        oci_image_pull_or_build: false,
        container_daemon: false,
        package_store_lifecycle: "not touched by benchmark",
        evidence_scope: "observed command path and bounded fixture; not a universal SLA",
      },
    };
  } finally {
    for (const { fixture: activeFixture, session } of [...activeSessions.values()].reverse()) {
      try {
        await discard(activeFixture, session);
      } catch {
        // Preserve the original benchmark error; the bounded report never
        // claims cleanup passed when the command itself was not observed.
      }
    }
    cleanupFixture(root, options.keepTemp);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output !== undefined) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, serialized);
  }
  process.stdout.write(serialized);
}

const options = parseArgs(process.argv.slice(2));
if (options !== null) {
  main(options).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
