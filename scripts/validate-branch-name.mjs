#!/usr/bin/env node
// Branch naming contract: <type>/<issue-number>-<slug>, e.g. feat/42-add-init-command.
// Keeps every branch traceable to an Issue without requiring a heavier PR body parser.
// release/<semver> is exempt from the issue-number requirement: release prep
// (changelog/version bump) has no Issue of its own and is scoped down in CI
// (see isReleaseDocsOnlyChange in ci docs-only guard).
import { execFileSync } from "node:child_process";

const BRANCH_PATTERN = /^(feat|fix|docs|refactor|test|chore|perf)\/\d+-[a-z0-9-]+$/;
const RELEASE_BRANCH_PATTERN = /^release\/\d+\.\d+\.\d+$/;
const EXEMPT_BRANCHES = new Set(["main", "chore/nawabari-0.1.0"]);

export function validateBranchName(branch) {
  if (EXEMPT_BRANCHES.has(branch)) return [];
  if (BRANCH_PATTERN.test(branch)) return [];
  if (RELEASE_BRANCH_PATTERN.test(branch)) return [];
  return [
    `branch name "${branch}" does not match <type>/<issue-number>-<slug>` +
      ' (e.g. "feat/42-add-init-command") or release/<semver> (e.g. "release/0.1.0");' +
      " type must be one of feat, fix, docs, refactor, test, chore, perf",
  ];
}

function main() {
  const branchArgIndex = process.argv.indexOf("--branch");
  const branch =
    branchArgIndex === -1
      ? execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim()
      : process.argv[branchArgIndex + 1];

  const errors = validateBranchName(branch);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`branch name "${branch}" is valid.`);
}

if (process.argv[1]?.endsWith("validate-branch-name.mjs")) main();
