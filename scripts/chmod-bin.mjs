#!/usr/bin/env node
// tsc does not set the executable bit on emitted files, and npm packs files
// verbatim with whatever mode they have on disk (it does not infer +x from
// package.json's "bin" map). Without this, a fresh clone's first `npm pack`
// ships bin targets that are not executable once installed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const bin = packageJson.bin ?? {};

for (const relativeTarget of Object.values(bin)) {
  const target = path.join(repoRoot, relativeTarget);
  const stat = fs.statSync(target);
  fs.chmodSync(target, stat.mode | 0o111);
  console.log(`chmod +x ${relativeTarget}`);
}
