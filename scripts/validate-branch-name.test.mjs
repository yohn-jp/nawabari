import assert from "node:assert/strict";
import test from "node:test";
import { validateBranchName } from "./validate-branch-name.mjs";

test("accepts a well-formed branch name", () => {
  assert.deepEqual(validateBranchName("feat/42-add-init-command"), []);
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
