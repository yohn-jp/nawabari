import assert from "node:assert/strict";
import test from "node:test";
import { validateIssue } from "./validate-issue.mjs";

test("accepts a sufficiently detailed body", () => {
  assert.deepEqual(validateIssue("This is a properly detailed issue description."), []);
});

test("rejects an empty body", () => {
  assert.equal(validateIssue("").length, 1);
});

test("rejects a too-short body", () => {
  assert.equal(validateIssue("too short").length, 1);
});
