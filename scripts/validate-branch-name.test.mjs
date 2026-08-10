import assert from "node:assert/strict";
import test from "node:test";
import { validateBranchName } from "./validate-branch-name.mjs";

test("accepts a well-formed branch name", () => {
  assert.deepEqual(validateBranchName("feat/42-add-init-command"), []);
});

test("accepts the exempt main branch", () => {
  assert.deepEqual(validateBranchName("main"), []);
});

test("rejects a branch missing an issue number", () => {
  assert.equal(validateBranchName("feat/add-init-command").length, 1);
});

test("rejects an unknown type prefix", () => {
  assert.equal(validateBranchName("wip/42-add-init-command").length, 1);
});
