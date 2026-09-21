#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as prettier from "prettier";

import { renderCliSkillPlaybook } from "../src/cli-skill-projection.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repositoryRoot, ".claude/skills/nawabari/SKILL.md");
const generated = await prettier.format(renderCliSkillPlaybook(), { filepath: outputPath });
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : undefined;
  if (current !== generated) {
    throw new Error(
      `generated CLI skill playbook is stale: ${path.relative(repositoryRoot, outputPath)}; ` +
        "run `pnpm run skill:generate`",
    );
  }
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
}
