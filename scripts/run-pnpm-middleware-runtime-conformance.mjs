#!/usr/bin/env node
// Preseed the exact pinned Nix outputs, then execute the opt-in backend
// producer conformance test. The production materializer only performs
// offline, read-only path-info queries and never downloads during launch.
import { spawnSync } from "node:child_process";
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
run("nix", ["build", "--no-link", materializer.RTK_NIX_INSTALLABLE]);
console.log(`materializing pinned pnpm output: ${materializer.PNPM_NIX_INSTALLABLE}`);
run("nix", ["build", "--no-link", materializer.PNPM_NIX_INSTALLABLE]);

const rtkEvidence = {
  version: evaluate(materializer.RTK_NIX_INSTALLABLE, "version"),
  source_owner: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.owner"),
  source_repository: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.repo"),
  source_revision: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.rev"),
  source_hash: evaluate(materializer.RTK_NIX_INSTALLABLE, "src.outputHash"),
  cargo_hash: evaluate(materializer.RTK_NIX_INSTALLABLE, "cargoHash"),
};
assertExact("RTK Nixpkgs", rtkEvidence, {
  version: materializer.RTK_BACKEND_REQUIREMENT.version,
  source_owner: materializer.RTK_NIX_SOURCE.owner,
  source_repository: materializer.RTK_NIX_SOURCE.repository,
  source_revision: materializer.RTK_NIX_SOURCE.revision,
  source_hash: materializer.RTK_NIX_SOURCE.hash,
  cargo_hash: materializer.RTK_NIX_SOURCE.cargo_hash,
});
console.log(`verified RTK Nixpkgs expression: ${JSON.stringify(rtkEvidence)}`);

const pnpmEvidence = {
  version: evaluate(materializer.PNPM_NIX_INSTALLABLE, "version"),
  source_url: evaluate(materializer.PNPM_NIX_INSTALLABLE, "src.url"),
  source_hash: evaluate(materializer.PNPM_NIX_INSTALLABLE, "src.outputHash"),
};
assertExact("pnpm Nixpkgs", pnpmEvidence, {
  version: materializer.REAL_PNPM_BACKEND_REQUIREMENT.version,
  source_url: materializer.PNPM_NIX_SOURCE.url,
  source_hash: materializer.PNPM_NIX_SOURCE.hash,
});
console.log(`verified pnpm Nixpkgs expression: ${JSON.stringify(pnpmEvidence)}`);

for (const installable of [materializer.RTK_NIX_INSTALLABLE, materializer.PNPM_NIX_INSTALLABLE]) {
  run("nix", ["path-info", "--offline", "--json", "--json-format", "1", "--no-pretty", "--recursive", installable]);
}

const conformanceEnv = { ...process.env, NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE: "1" };
for (const testFile of [
  "src/domain/pnpm-middleware-backend-materialization.test.ts",
  // The #306 acceptance test consumes the real #311 handoff under this same
  // Nix-preseeded and protected-runtime conformance gate.
  "src/domain/runtime-provider-pnpm-middleware.test.ts",
]) {
  run(process.execPath, ["--test", "--import", "tsx", testFile], { env: conformanceEnv });
}
