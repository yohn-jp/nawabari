#!/usr/bin/env node
// Validate the exact archive that will be published. The optional npm dry run
// is a preflight only; it must finish before the irreversible publish command.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const tarballPath = process.argv[2];
const publishDryRun = process.argv.includes("--publish-dry-run");
if (tarballPath === undefined) throw new Error("usage: validate-release-tarball.mjs <tarball> [--publish-dry-run]");
if (!fs.existsSync(tarballPath)) throw new Error(`tarball not found: ${tarballPath}`);

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const expectedName = "nawabari";
const expectedVersion = packageJson.version;
const expectedTarballName = `${expectedName}-${expectedVersion}.tgz`;
if (packageJson.name !== expectedName || typeof expectedVersion !== "string" || expectedVersion.length === 0) {
  throw new Error("repository package.json must define the nawabari package name and a non-empty version");
}
if (path.basename(tarballPath) !== expectedTarballName) {
  throw new Error(`tarball filename must be ${expectedTarballName}, got ${path.basename(tarballPath)}`);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const metadata = JSON.parse(run("tar", ["-xOf", tarballPath, "package/package.json"]).stdout);
if (metadata.name !== expectedName || metadata.version !== expectedVersion) {
  throw new Error(
    `tarball metadata must be ${expectedName}@${expectedVersion}, got ${metadata.name}@${metadata.version}`,
  );
}
if (metadata.bin?.nawabari !== "dist/index.js" || metadata.bin?.["git-nawabari"] !== "dist/index.js") {
  throw new Error("tarball must expose nawabari and git-nawabari from dist/index.js");
}

const entries = run("tar", ["-tzf", tarballPath])
  .stdout.trim()
  .split("\n")
  .filter(Boolean)
  .map((entry) => entry.replace(/\/$/, ""));
const allowed = new Set(["package/package.json", "package/README.md", "package/LICENSE"]);
for (const entry of entries) {
  if (!allowed.has(entry) && !entry.startsWith("package/dist/")) {
    throw new Error(`unexpected entry in publish tarball: ${entry}`);
  }
}
if (!entries.includes("package/dist/index.js")) throw new Error("publish tarball has no dist/index.js");

if (publishDryRun) {
  const dryRun = spawnSync("npm", ["publish", tarballPath, "--dry-run", "--ignore-scripts", "--json"], {
    encoding: "utf8",
  });
  if (dryRun.error) throw dryRun.error;
  const output = `${dryRun.stdout}\n${dryRun.stderr}`;
  if (dryRun.status !== 0) {
    throw new Error(`npm publish dry-run failed\n${output}`);
  }
  if (/npm warn publish/i.test(output)) {
    throw new Error(`npm publish dry-run emitted a publish warning\n${output}`);
  }
}

console.log(`release tarball validated: ${tarballPath}`);
