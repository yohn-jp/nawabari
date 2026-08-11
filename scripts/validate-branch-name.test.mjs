import assert from "node:assert/strict";
import test from "node:test";
import { validateBranchName } from "./validate-branch-name.mjs";

test("accepts a well-formed branch name", () => {
  assert.deepEqual(validateBranchName("feat/42-add-init-command"), []);
});

test("accepts a performance branch name", () => {
  assert.deepEqual(validateBranchName("perf/44-pnpm-worktree-install"), []);
});

test("accepts the exempt main branch", () => {
  assert.deepEqual(validateBranchName("main"), []);
});

test("accepts the Nawabari v0.1.0 release branch", () => {
  assert.deepEqual(validateBranchName("chore/nawabari-0.1.0"), []);
});

test("rejects a branch missing an issue number", () => {
  assert.equal(validateBranchName("feat/add-init-command").length, 1);
});

test("rejects an unknown type prefix", () => {
  assert.equal(validateBranchName("wip/42-add-init-command").length, 1);
});

test("accepts a release/<semver> branch", () => {
  assert.deepEqual(validateBranchName("release/0.1.0"), []);
});

test("rejects a release branch with a non-semver suffix", () => {
  assert.equal(validateBranchName("release/nawabari-0.1.0").length, 1);
});
