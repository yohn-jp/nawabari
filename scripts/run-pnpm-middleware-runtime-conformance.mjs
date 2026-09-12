#!/usr/bin/env node
// Preseed the exact pinned Nix outputs, then execute the opt-in backend
// producer conformance test. The production materializer only performs
// offline, read-only path-info queries and never downloads during launch.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const materializer = await import(
  pathToFileURL(path.join(repoRoot, "src/domain/pnpm-middleware-backend-materialization.ts")).href
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${status ?? `signal ${signal}`}`));
    });
  });
}

function timed(label, operation) {
  const started = process.hrtime.bigint();
  const result = operation();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  console.log(`conformance phase=${label} duration_ms=${elapsedMs.toFixed(1)}`);
  return result;
}

async function timedAsync(label, operation) {
  const started = process.hrtime.bigint();
  try {
    return await operation();
  } finally {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    console.log(`conformance phase=${label} duration_ms=${elapsedMs.toFixed(1)}`);
  }
}

function evaluate(installable, attribute) {
  const result = spawnSync("nix", ["eval", "--offline", "--raw", `${installable}.${attribute}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`nix eval ${installable}.${attribute} exited with ${result.status}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function assertExact(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} expression drifted:\n${JSON.stringify({ actual, expected }, null, 2)}`);
  }
}

console.log(`materializing pinned RTK output: ${materializer.RTK_NIX_INSTALLABLE}`);
console.log(`materializing pinned pnpm output: ${materializer.PNPM_NIX_INSTALLABLE}`);
await timedAsync("nix-build", async () => {
  const buildResults = await Promise.allSettled(
    [materializer.RTK_NIX_INSTALLABLE, materializer.PNPM_NIX_INSTALLABLE].map((installable) =>
      runAsync("nix", ["build", "--no-link", installable]),
    ),
  );
  const failedBuild = buildResults.find((result) => result.status === "rejected");
  if (failedBuild?.status === "rejected") throw failedBuild.reason;
});

const rtkEvidence = timed("rtk-evidence", () => ({
  version: evaluate(materializer.RTK_NIX_INSTALLABLE, "version"),
  source_owner: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.owner"),
  source_repository: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.repo"),
  source_revision: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.rev"),
  source_hash: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.outputHash"),
  cargo_hash: evaluate(materializer.RTK_NIX_INSTALLABLE, "cargoHash"),
}));
assertExact("RTK Nixpkgs", rtkEvidence, {
  version: materializer.RTK_BACKEND_REQUIREMENT.version,
  source_owner: materializer.RTK_NIX_SOURCE.owner,
  source_repository: materializer.RTK_NIX_SOURCE.repository,
  source_revision: materializer.RTK_NIX_SOURCE.revision,
  source_hash: materializer.RTK_NIX_SOURCE.hash,
  cargo_hash: materializer.RTK_NIX_SOURCE.cargo_hash,
});
console.log(`verified RTK Nixpkgs expression: ${JSON.stringify(rtkEvidence)}`);

const pnpmEvidence = timed("pnpm-evidence", () => ({
  version: evaluate(materializer.PNPM_NIX_INSTALLABLE, "version"),
  source_url: evaluate(materializer.PNPM_NIX_INSTALLABLE, "src.url"),
  source_hash: evaluate(materializer.PNPM_NIX_INSTALLABLE, "src.outputHash"),
}));
assertExact("pnpm Nixpkgs", pnpmEvidence, {
  version: materializer.REAL_PNPM_BACKEND_REQUIREMENT.version,
  source_url: materializer.PNPM_NIX_SOURCE.url,
  source_hash: materializer.PNPM_NIX_SOURCE.hash,
});
console.log(`verified pnpm Nixpkgs expression: ${JSON.stringify(pnpmEvidence)}`);

timed("nix-path-info", () =>
  run(
    "nix",
    [
      "path-info",
      "--offline",
      "--json",
      "--json-format",
      "1",
      "--no-pretty",
      "--recursive",
      materializer.RTK_NIX_INSTALLABLE,
      materializer.PNPM_NIX_INSTALLABLE,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  ),
);

const conformanceEnv = { ...process.env, NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE: "1" };
const testFiles = [
  "src/domain/pnpm-middleware-backend-materialization.test.ts",
  // The #306 acceptance test consumes the real #311 handoff under this same
  // Nix-preseeded and protected-runtime conformance gate.
  "src/domain/runtime-provider-pnpm-middleware.test.ts",
];
const testResults = await Promise.allSettled(
  testFiles.map((testFile) =>
    timedAsync(`test-${path.basename(testFile, path.extname(testFile))}`, () =>
      runAsync(process.execPath, ["--test", "--import", "tsx", testFile], { env: conformanceEnv }),
    ),
  ),
);
const failedTest = testResults.find((result) => result.status === "rejected");
if (failedTest?.status === "rejected") throw failedTest.reason;
