#!/usr/bin/env node
// Measure dependency readiness in newly-created Git worktrees without mutating
// the caller's checkout. The benchmark uses a temporary local clone, separate
// pnpm stores, and commits the candidate workspace setting only in that clone.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_RUNS = 5;
const GLOBAL_SETTING = "enableGlobalVirtualStore";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");

function usage() {
  return [
    "Usage: pnpm run benchmark:pnpm-worktree-install [options]",
    "",
    "Options:",
    `  --runs <number>       Warm fresh-worktree repetitions (default: ${DEFAULT_RUNS})`,
    "  --base-ref <ref>      Baseline ref (default: origin/main, then main, then HEAD)",
    "  --output <path>       Write the JSON report to a file as well as stdout",
    "  --keep-temp           Keep the temporary clone and worktrees for inspection",
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { runs: DEFAULT_RUNS, baseRef: undefined, output: undefined, keepTemp: false };
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
    const [name, inlineValue] = argument.split("=", 2);
    if (name === "--runs" || name === "--base-ref" || name === "--output") {
      const value = inlineValue ?? argv[++index];
      if (value === undefined || value === "") throw new Error(`${name} requires a value`);
      if (name === "--runs") {
        const runs = Number(value);
        if (!Number.isInteger(runs) || runs < 3) throw new Error("--runs must be an integer of at least 3");
        options.runs = runs;
      } else if (name === "--base-ref") {
        options.baseRef = value;
      } else {
        options.output = path.resolve(value);
      }
      continue;
    }
    throw new Error(`unknown option: ${argument}`);
  }
  return options;
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}\n${output.slice(-4000)}`);
  }
  return output;
}

function tryResolveCommit(repositoryRoot, ref) {
  try {
    return run("git", ["rev-parse", "--verify", `${ref}^{commit}`], repositoryRoot).trim();
  } catch {
    return undefined;
  }
}

function resolveBaseline(repositoryRoot, requestedRef) {
  const candidates = requestedRef === undefined ? ["origin/main", "main", "HEAD"] : [requestedRef];
  for (const ref of candidates) {
    const commit = tryResolveCommit(repositoryRoot, ref);
    if (commit !== undefined) return { ref, commit };
  }
  throw new Error(`could not resolve baseline ref: ${candidates.join(", ")}`);
}

function makeEnvironment(overrides = {}) {
  return { ...process.env, ...overrides };
}

function localInstallEnvironment() {
  const environment = makeEnvironment();
  delete environment.CI;
  delete environment.GITHUB_ACTIONS;
  return environment;
}

function measureDiskUsage(target) {
  const output = run("du", ["-sk", target], path.dirname(target));
  const value = Number(output.trim().split(/\s+/, 1)[0]);
  if (!Number.isFinite(value)) throw new Error(`could not parse disk usage for ${target}: ${output}`);
  return value;
}

function findEsbuildBinary(worktree) {
  const pnpmDirectory = path.join(worktree, "node_modules", ".pnpm");
  const directCandidate = path.join(pnpmDirectory, "node_modules", "esbuild", "bin", "esbuild");
  if (fs.existsSync(directCandidate)) return directCandidate;
  if (!fs.existsSync(pnpmDirectory)) return undefined;
  for (const entry of fs.readdirSync(pnpmDirectory)) {
    if (!entry.startsWith("esbuild@")) continue;
    const candidate = path.join(pnpmDirectory, entry, "node_modules", "esbuild", "bin", "esbuild");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function virtualStoreMode(worktree) {
  const modulesFile = path.join(worktree, "node_modules", ".modules.yaml");
  const contents = fs.readFileSync(modulesFile, "utf8");
  const match = contents.match(/["']?virtualStoreDir["']?\s*:\s*["']?([^"'\n,]+)["']?,?/);
  const virtualStoreDir = match?.[1] ?? "unknown";
  return {
    virtualStoreDir,
    mode: virtualStoreDir.endsWith("/links") || virtualStoreDir.includes("/links/") ? "global" : "local",
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return { count: sorted.length, medianMs: median, minMs: sorted[0], maxMs: sorted.at(-1) };
}

function addWorktree(cloneRoot, worktree, commit, worktrees) {
  run("git", ["worktree", "add", "--detach", "--quiet", worktree, commit], cloneRoot);
  worktrees.push(worktree);
}

function commitCandidate(cloneRoot, baseCommit, worktrees, label) {
  const seed = path.join(path.dirname(cloneRoot), `${label}-seed`);
  addWorktree(cloneRoot, seed, baseCommit, worktrees);
  run("pnpm", ["config", "set", GLOBAL_SETTING, "true", "--location", "project"], seed);
  run("git", ["add", "pnpm-workspace.yaml"], seed);
  run(
    "git",
    [
      "-c",
      "user.name=benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--quiet",
      "-m",
      `benchmark ${GLOBAL_SETTING}`,
    ],
    seed,
  );
  return run("git", ["rev-parse", "HEAD"], seed).trim();
}

function commitDependencyChange(cloneRoot, baseCommit, worktrees) {
  const seed = path.join(path.dirname(cloneRoot), "dependency-change-seed");
  addWorktree(cloneRoot, seed, baseCommit, worktrees);
  const fixtureDirectory = path.join(seed, "benchmark-fixture");
  fs.mkdirSync(fixtureDirectory);
  fs.writeFileSync(
    path.join(fixtureDirectory, "package.json"),
    `${JSON.stringify({ name: "@nawabari/benchmark-fixture", version: "1.0.0" }, null, 2)}\n`,
  );
  run("pnpm", ["add", "--save-dev", "--lockfile-only", "./benchmark-fixture"], seed);
  run("git", ["add", "package.json", "pnpm-lock.yaml", "benchmark-fixture/package.json"], seed);
  run(
    "git",
    [
      "-c",
      "user.name=benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "benchmark dependency change",
    ],
    seed,
  );
  const changedBaseCommit = run("git", ["rev-parse", "HEAD"], seed).trim();
  run("pnpm", ["config", "set", GLOBAL_SETTING, "true", "--location", "project"], seed);
  run("git", ["add", "pnpm-workspace.yaml"], seed);
  run(
    "git",
    [
      "-c",
      "user.name=benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "benchmark dependency change global virtual store",
    ],
    seed,
  );
  return { changedBaseCommit, changedGlobalCommit: run("git", ["rev-parse", "HEAD"], seed).trim() };
}

function runCompatibilityChecks(worktree, output) {
  const lifecycleBuilt = /esbuild[\s\S]*postinstall\$[\s\S]*postinstall:\s*Done/.test(output);
  const esbuildBinary = findEsbuildBinary(worktree);
  if (!lifecycleBuilt || esbuildBinary === undefined) {
    throw new Error(`esbuild lifecycle build was not verified in ${worktree}`);
  }
  run(process.execPath, ["--input-type=module", "-e", "await import('tsx');"], worktree, localInstallEnvironment());
  run("pnpm", ["run", "build"], worktree, localInstallEnvironment());
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const module = await import('./dist/contract.js'); if (!module.MACHINE_CONTRACT_ID) throw new Error('missing contract');",
    ],
    worktree,
    localInstallEnvironment(),
  );
  return { lifecycleBuild: "pass", esbuildBinary, esmImport: "pass", builtPackageImport: "pass" };
}

function measureInstall({ cloneRoot, root, config, phase, repetition, commit, store, worktrees }) {
  const worktree = path.join(root, `worktree-${config}-${phase}-${repetition}`);
  const started = performance.now();
  addWorktree(cloneRoot, worktree, commit, worktrees);
  const worktreeReady = performance.now();
  const output = run(
    "pnpm",
    ["install", "--frozen-lockfile", "--store-dir", store],
    worktree,
    localInstallEnvironment(),
  );
  const dependencyReady = performance.now();
  const result = {
    config,
    phase,
    repetition,
    worktreeMs: Math.round(worktreeReady - started),
    installMs: Math.round(dependencyReady - worktreeReady),
    totalMs: Math.round(dependencyReady - started),
    nodeModulesKb: measureDiskUsage(path.join(worktree, "node_modules")),
    storeKb: measureDiskUsage(store),
    ...virtualStoreMode(worktree),
    lifecycleBuild: /esbuild[\s\S]*postinstall\$[\s\S]*postinstall:\s*Done/.test(output),
  };
  if (phase === "cold") result.compatibility = runCompatibilityChecks(worktree, output);
  return result;
}

function measureCiInstall({ cloneRoot, root, config, commit, store, worktrees }) {
  const worktree = path.join(root, `worktree-${config}-ci`);
  addWorktree(cloneRoot, worktree, commit, worktrees);
  run(
    "pnpm",
    ["install", "--frozen-lockfile", "--offline", "--store-dir", store],
    worktree,
    makeEnvironment({ CI: "true", GITHUB_ACTIONS: "true" }),
  );
  return { config, ...virtualStoreMode(worktree) };
}

function filesystemContext(repositoryRoot) {
  const stats = fs.statfsSync(repositoryRoot);
  return { type: stats.type, blockSize: stats.bsize, blocks: stats.blocks };
}

function cleanup(cloneRoot, worktrees, keepTemp) {
  if (keepTemp) return;
  for (const worktree of [...worktrees].reverse()) {
    spawnSync("git", ["worktree", "remove", "--force", worktree], {
      cwd: cloneRoot,
      stdio: "ignore",
    });
  }
  fs.rmSync(path.dirname(cloneRoot), { recursive: true, force: true });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === null) return;
  const baseline = resolveBaseline(REPOSITORY_ROOT, options.baseRef);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-worktree-benchmark-"));
  const cloneRoot = path.join(root, "repository");
  const worktrees = [];
  let report;
  try {
    run("git", ["clone", "--local", "--no-hardlinks", "--quiet", REPOSITORY_ROOT, cloneRoot], REPOSITORY_ROOT);
    const baselineWorkspace = run("git", ["show", `${baseline.commit}:pnpm-workspace.yaml`], REPOSITORY_ROOT);
    if (new RegExp(`${GLOBAL_SETTING}:\\s*true`).test(baselineWorkspace)) {
      throw new Error(`${baseline.ref} already enables ${GLOBAL_SETTING}; use a default-setting baseline`);
    }
    const currentCommit = baseline.commit;
    const globalCommit = commitCandidate(cloneRoot, baseline.commit, worktrees, "global");
    const dependencyCommits = commitDependencyChange(cloneRoot, baseline.commit, worktrees);
    const stores = {
      current: path.join(root, "store-current"),
      global: path.join(root, "store-global"),
    };
    fs.mkdirSync(stores.current);
    fs.mkdirSync(stores.global);
    const measurements = [];
    const compatibility = {};
    for (const [config, commit] of [
      ["current", currentCommit],
      ["global", globalCommit],
    ]) {
      const cold = measureInstall({
        cloneRoot,
        root,
        config,
        phase: "cold",
        repetition: 0,
        commit,
        store: stores[config],
        worktrees,
      });
      compatibility[config] = cold.compatibility;
      measurements.push(cold);
      for (let repetition = 1; repetition <= options.runs; repetition += 1) {
        measurements.push(
          measureInstall({
            cloneRoot,
            root,
            config,
            phase: "warm",
            repetition,
            commit,
            store: stores[config],
            worktrees,
          }),
        );
      }
      measurements.push(
        measureInstall({
          cloneRoot,
          root,
          config,
          phase: "dependency-change",
          repetition: 0,
          commit: dependencyCommits[config === "current" ? "changedBaseCommit" : "changedGlobalCommit"],
          store: stores[config],
          worktrees,
        }),
      );
    }
    const summaries = {};
    for (const config of ["current", "global"]) {
      summaries[config] = {};
      for (const phase of ["cold", "warm", "dependency-change"]) {
        summaries[config][phase] = summarize(
          measurements
            .filter((measurement) => measurement.config === config && measurement.phase === phase)
            .map((measurement) => measurement.totalMs),
        );
      }
    }
    const ci = [
      measureCiInstall({
        cloneRoot,
        root,
        config: "current",
        commit: currentCommit,
        store: stores.current,
        worktrees,
      }),
      measureCiInstall({
        cloneRoot,
        root,
        config: "global",
        commit: globalCommit,
        store: stores.global,
        worktrees,
      }),
    ];
    report = {
      protocol: {
        freshWorktree: true,
        coldAndWarmSeparated: true,
        warmRuns: options.runs,
        dependencyChangeFixture: true,
        storePerConfiguration: true,
        timings: "worktree creation through pnpm install completion",
      },
      environment: {
        measuredAt: new Date().toISOString(),
        platform: process.platform,
        platformRelease: os.release(),
        architecture: process.arch,
        node: process.version,
        pnpm: run("pnpm", ["--version"], REPOSITORY_ROOT).trim(),
        filesystem: filesystemContext(REPOSITORY_ROOT),
        baselineRef: baseline.ref,
        baselineCommit: baseline.commit,
        repositoryRoot: REPOSITORY_ROOT,
      },
      configurations: {
        current: { commit: currentCommit, globalVirtualStore: false },
        global: { commit: globalCommit, globalVirtualStore: true },
      },
      measurements,
      summaries,
      compatibility,
      ci,
      temporaryRoot: options.keepTemp ? root : undefined,
    };
  } finally {
    cleanup(cloneRoot, worktrees, options.keepTemp);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output !== undefined) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, serialized);
  }
  process.stdout.write(serialized);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
