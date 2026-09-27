#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lane = process.argv[2];
const linuxSystemCases = new Map([
  [
    "src/domain/fhs-development-runtime.test.ts",
    [
      "standalone Linux protected execution runs the materialized Node/Git baseline",
      "a bounded session under the default strict FHS profile actually executes, with Landlock enforced",
    ],
  ],
  [
    "src/domain/fhs-runtime.test.ts",
    ["a strict FHS projection executes its declared runtime and hides absolute-path host tools"],
  ],
  ["src/domain/landlock.test.ts", ["supported Landlock denies a write outside the canonical topology"]],
  [
    "src/domain/runtime-provider-pnpm-middleware.test.ts",
    ["the launcher transport stays isolated under a bounded real runtime with synthetic backend fixtures"],
  ],
  [
    "src/domain/runtime-resolution.test.ts",
    ["the default strict FHS projection keeps the development baseline functional without host visibility"],
  ],
  [
    "src/domain/sandbox-launcher.test.ts",
    [
      "bounded Landlock scopes /tmp scratch access away from a worktree mounted under /tmp",
      "interactive execution inherits the caller streams and skips bounded limits",
      "interactive execution under a strict runtime projection resolves PATH only through the canonical surface",
      "a protected session runs with a private root/tmp/proc view and only its owned worktree",
      "direct execution and PATH-based child lookup resolve the same projected executable under real isolation",
      "session shell CLI path shares the compiled strict-projection authority with session run under real isolation",
    ],
  ],
  [
    "src/domain/sandbox-security-conformance.test.ts",
    ["canonical protected execution rejects the Issue #93 security-negative matrix"],
  ],
  [
    "src/domain/session-launch-supervisor-worker.test.ts",
    ["the compiled trusted supervisor keeps an immediate payload descendant in its owned cgroup"],
  ],
  [
    "src/domain/session-protected-launch-integration.test.ts",
    ["the protected composition reaches the repaired worker on a supported runtime"],
  ],
  [
    "src/domain/standalone-linux-compat.test.ts",
    ["standalone Linux runs development workloads through the exact protected profile"],
  ],
]);

const compiledWorkerCases = new Map([
  [
    "src/domain/session-launch-supervisor-worker.test.ts",
    ["the real package entrypoint uses fd 4/5 without sharing payload stdio"],
  ],
]);
const systemOnlyFiles = new Set([
  "src/domain/sandbox-security-conformance.test.ts",
  "src/domain/standalone-linux-compat.test.ts",
]);

function listTests(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTests(absolute);
    if (!entry.isFile()) return [];
    if (!/\.test\.(?:ts|mjs)$/u.test(entry.name)) return [];
    return [path.relative(repoRoot, absolute).split(path.sep).join("/")];
  });
}

const discoveredFiles = [...listTests(path.join(repoRoot, "src")), ...listTests(path.join(repoRoot, "scripts"))].sort();
if (discoveredFiles.length === 0) throw new Error("test inventory is empty");

function classify(file) {
  if (file.startsWith("scripts/")) return "fast";
  if (systemOnlyFiles.has(file)) return "linux-system";
  if (file.startsWith("src/domain/") && /-integration\.test\.ts$/u.test(file)) return "integration";
  if (file.startsWith("src/domain/") || file.startsWith("src/state/") || file.startsWith("src/testing/")) return "fast";
  if (file.startsWith("src/registry/") || file.startsWith("src/ui/")) return "integration";
  if (file.startsWith("src/") && file.slice("src/".length).split("/").length === 1) return "integration";
  throw new Error(`unclassified test path: ${file}`);
}

const filesByLane = new Map([
  ["fast", []],
  ["integration", []],
  ["linux-system", []],
]);
for (const file of discoveredFiles) {
  const owner = classify(file);
  const files = filesByLane.get(owner);
  if (files === undefined) throw new Error(`test path has no verification owner: ${file}`);
  files.push(file);
}

function assertCaseInventory(cases, label) {
  for (const [file, titles] of cases) {
    if (!discoveredFiles.includes(file)) throw new Error(`${label} test file is missing from discovery: ${file}`);
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    for (const title of titles) {
      if (!source.includes(`"${title}"`))
        throw new Error(`${label} test title is missing or changed: ${file}: ${title}`);
    }
  }
}
assertCaseInventory(linuxSystemCases, "Linux-system");
assertCaseInventory(compiledWorkerCases, "compiled-worker");

const knownLanes = new Set(["all", "fast", "integration", "compiled-worker", "linux-system"]);
if (!knownLanes.has(lane)) {
  throw new Error(`usage: node scripts/run-verification-lane.mjs ${[...knownLanes].join("|")}`);
}

function expectedTitles(cases) {
  return [...cases.values()].flat();
}

let selectedFiles;
let selectedTitles = [];
let testLane = lane;
if (lane === "all") {
  selectedFiles = discoveredFiles;
} else if (lane === "fast" || lane === "integration") {
  selectedFiles = filesByLane.get(lane) ?? [];
} else if (lane === "compiled-worker") {
  selectedFiles = [...compiledWorkerCases.keys()];
  selectedTitles = expectedTitles(compiledWorkerCases);
} else {
  selectedFiles = [...linuxSystemCases.keys()];
  selectedTitles = expectedTitles(linuxSystemCases);
}

if (selectedFiles.length === 0) throw new Error(`no test files are assigned to ${lane}`);
console.log(
  `verification inventory: discovered_files=${discoveredFiles.length} fast_files=${filesByLane.get("fast")?.length ?? 0} integration_files=${filesByLane.get("integration")?.length ?? 0} linux_system_cases=${expectedTitles(linuxSystemCases).length} compiled_worker_cases=${expectedTitles(compiledWorkerCases).length}`,
);
console.log(`verification lane: ${lane} files=${selectedFiles.length} expected_cases=${selectedTitles.length}`);

function run(command, args, { capture = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (capture && result.stdout) process.stdout.write(result.stdout);
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

if (lane === "compiled-worker" || lane === "linux-system") {
  const buildStarted = performance.now();
  const build = run("pnpm", ["run", "build"]);
  const buildDuration = Math.round(performance.now() - buildStarted);
  console.log(`verification invocation: build=1 duration_ms=${buildDuration}`);
  if (build.status !== 0) process.exit(build.status);
}

const args = ["--test", "--test-reporter=tap", "--import", "tsx"];
if (selectedTitles.length > 0) {
  const titlePattern = selectedTitles.map((title) => title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|");
  args.push(`--test-name-pattern=${titlePattern}`);
}
args.push(...selectedFiles);

const runStarted = performance.now();
const env = { ...process.env, NAWABARI_TEST_LANE: testLane };
const tests = run(process.execPath, args, {
  capture: lane === "compiled-worker" || lane === "linux-system",
  env,
});
const testDuration = Math.round(performance.now() - runStarted);
console.log(`verification invocation: node_test=1 duration_ms=${testDuration}`);
if (tests.status !== 0) process.exitCode = tests.status;

if (lane === "compiled-worker" || lane === "linux-system") {
  const total = tests.stdout.match(/^# tests (\d+)$/mu);
  const skipped = tests.stdout.match(/^# skipped (\d+)$/mu);
  const totalCount = total === null ? 0 : Number(total[1]);
  const skippedCount = skipped === null ? 0 : Number(skipped[1]);
  if (totalCount < selectedTitles.length) {
    console.error(`BLOCKED: expected ${selectedTitles.length} ${lane} case(s), discovered ${totalCount}`);
    process.exitCode = 1;
  }
  if (skippedCount > 0) {
    console.error(`BLOCKED: ${skippedCount} ${lane} test(s) skipped; this lane did not establish positive evidence`);
    process.exitCode = 1;
  }
}
