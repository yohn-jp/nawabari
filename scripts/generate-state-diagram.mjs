#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateNawabariProductStateManifest,
  renderNawabariSessionLifecycleDiagram,
} from "../src/product-state-manifest.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repositoryRoot, "docs/architecture/generated/session-lifecycle.mmd");
const generated = renderNawabariSessionLifecycleDiagram(generateNawabariProductStateManifest());
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const current = fs.readFileSync(outputPath, "utf8");
  if (current !== generated) {
    throw new Error(
      `generated Session lifecycle diagram is stale: ${path.relative(repositoryRoot, outputPath)}; ` +
        "run `pnpm run manifest:generate`",
    );
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
}
