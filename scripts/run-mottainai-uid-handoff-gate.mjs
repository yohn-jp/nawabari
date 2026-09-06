#!/usr/bin/env node
// #150 CI gate: produce the #149 packed/protected-execution artifact exactly
// once, then feed that exact tarball + evidence into the Mottainai UID
// handoff script. #150 must never repack; this wrapper is the only supported
// entry point for "pnpm run test:package:mottainai" so the lineage
// requirement is structural, not an optional flag.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-mottainai-uid-gate-"));
  const evidencePath = path.join(tempRoot, "packed-standalone-protected-execution.json");
  const tarballPath = path.join(repoRoot, `${packageJson.name}-${packageJson.version}.tgz`);
  try {
    run(process.execPath, [
      "scripts/run-package-suite.mjs",
      "--require-protected-execution",
      "--keep-tarball",
      "--evidence-output",
      evidencePath,
    ]);
    run(process.execPath, [
      "scripts/run-mottainai-uid-handoff.mjs",
      "--tarball",
      tarballPath,
      "--artifact-evidence",
      evidencePath,
    ]);
  } finally {
    fs.rmSync(tarballPath, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
