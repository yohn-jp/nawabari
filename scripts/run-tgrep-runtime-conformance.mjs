#!/usr/bin/env node
// Preseed the exact pinned Nix output, then run the opt-in conformance test.
// The production materializer remains offline/read-only: this build step is
// explicit test setup and is never part of session launch.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const materializer = await import(
  pathToFileURL(path.join(repoRoot, "src/domain/tgrep-runtime-materialization.ts")).href
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function evaluateNix(attribute) {
  const result = spawnSync(
    "nix",
    ["eval", "--offline", "--raw", `${materializer.TGREP_NIX_INSTALLABLE}.${attribute}`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`nix eval ${attribute} exited with ${result.status}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

console.log(`materializing pinned tgrep output: ${materializer.TGREP_NIX_INSTALLABLE}`);
run("nix", ["build", "--no-link", materializer.TGREP_NIX_INSTALLABLE]);
const nixEvidence = {
  version: evaluateNix("version"),
  source_tag: evaluateNix("src.tag"),
  source_owner: evaluateNix("src.owner"),
  source_repository: evaluateNix("src.repo"),
  source_hash: evaluateNix("src.outputHash"),
  cargo_hash: evaluateNix("cargoHash"),
};
const expectedNixEvidence = {
  version: materializer.TGREP_BACKEND_VERSION,
  source_tag: materializer.TGREP_NIX_SOURCE.tag,
  source_owner: materializer.TGREP_NIX_SOURCE.owner,
  source_repository: materializer.TGREP_NIX_SOURCE.repository,
  source_hash: materializer.TGREP_NIX_SOURCE.hash,
  cargo_hash: materializer.TGREP_NIX_SOURCE.cargo_hash,
};
if (JSON.stringify(nixEvidence) !== JSON.stringify(expectedNixEvidence)) {
  throw new Error(
    `Nixpkgs tgrep expression drifted:\n${JSON.stringify({ nixEvidence, expectedNixEvidence }, null, 2)}`,
  );
}
console.log(`verified Nixpkgs tgrep expression: ${JSON.stringify(nixEvidence)}`);
run("nix", [
  "path-info",
  "--offline",
  "--json",
  "--json-format",
  "1",
  "--no-pretty",
  "--recursive",
  materializer.TGREP_NIX_INSTALLABLE,
]);
run(process.execPath, ["--test", "--import", "tsx", "src/domain/tgrep-runtime-materialization.test.ts"], {
  env: { ...process.env, NAWABARI_TGREP_RUNTIME_CONFORMANCE: "1" },
});
// Proves the #295 rg provider preserves rg semantics against this exact
// backend for the supported compatibility matrix, not a synthetic stub.
run("nix", ["build", "--no-link", `${materializer.TGREP_NIXPKGS_REF}#nodejs`]);
run(process.execPath, ["--test", "--import", "tsx", "src/domain/runtime-provider-tgrep.test.ts"], {
  env: { ...process.env, NAWABARI_TGREP_RUNTIME_CONFORMANCE: "1" },
});
