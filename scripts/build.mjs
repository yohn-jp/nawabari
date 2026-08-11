#!/usr/bin/env node
// Build from a clean output directory so removed or renamed source files can
// never survive as stale package artifacts.
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(repoRoot, "dist");

fs.rmSync(distDirectory, { recursive: true, force: true });
for (const incrementalMetadata of ["tsconfig.tsbuildinfo", "tsconfig.build.tsbuildinfo"]) {
  fs.rmSync(path.join(repoRoot, incrementalMetadata), { force: true });
}

const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
const build = spawnSync(tsc, ["-p", "tsconfig.build.json"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.error !== undefined) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const chmod = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "chmod-bin.mjs")], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (chmod.error !== undefined) throw chmod.error;
if (chmod.status !== 0) process.exit(chmod.status ?? 1);
