#!/usr/bin/env node
// Build/package validation deliberately passes one concrete tarball through
// content checks and the isolated consumer smoke test. A second npm pack is
// never allowed to hide a stale dist or packaging mismatch.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function parseArgs(argv) {
  return {
    keepTarball: argv.includes("--keep-tarball"),
    requireProtectedExecution: argv.includes("--require-protected-execution"),
  };
}

function assertPackContents(packInfo) {
  const packedFiles = packInfo.files.map((entry) => entry.path);
  const allowed = new Set(["package.json", "README.md", "LICENSE"]);
  for (const file of packedFiles) {
    if (!allowed.has(file) && !file.startsWith("dist/")) {
      throw new Error(`unexpected file in package tarball: ${file}`);
    }
  }

  for (const binPath of Object.values(packageJson.bin ?? {})) {
    if (!packedFiles.includes(binPath)) {
      throw new Error(`bin entry "${binPath}" is not included in the packed tarball`);
    }
    const stat = fs.statSync(path.join(repoRoot, binPath));
    if ((stat.mode & 0o100) === 0) {
      throw new Error(`bin entry "${binPath}" is not executable`);
    }
  }
}

function main() {
  const { keepTarball, requireProtectedExecution } = parseArgs(process.argv.slice(2));
  const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
  const tarballPath = path.join(repoRoot, tarballName);
  fs.rmSync(tarballPath, { force: true });

  try {
    const packResult = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", repoRoot]);
    const [packInfo] = JSON.parse(packResult.stdout);
    if (packInfo.filename !== tarballName) {
      throw new Error(`npm produced ${packInfo.filename}; expected ${tarballName}`);
    }
    assertPackContents(packInfo);

    run(process.execPath, ["scripts/validate-release-tarball.mjs", tarballPath]);
    console.log(`package contents verified in exact tarball: ${tarballName}`);
    const smokeArgs = ["scripts/smoke-test.mjs", "--tarball", tarballPath];
    if (requireProtectedExecution) smokeArgs.push("--require-protected-execution");
    run(process.execPath, smokeArgs, { stdio: "inherit" });
  } finally {
    if (!keepTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
