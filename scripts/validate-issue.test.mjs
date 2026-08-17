import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateIssue } from "./validate-issue.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validBody = [
  "### Summary",
  "A reproducible defect.",
  "",
  "### Reproduction",
  "Run the failing command on the supported environment.",
  "",
  "### Expected behavior",
  "The command succeeds deterministically.",
  "",
  "### Actual behavior",
  "The command fails before the expected assertion.",
  "",
  "### Acceptance criteria",
  "- [x] Regression test added.",
  "",
  "### Context",
  "Relevant logs and environment.",
].join("\n");

test("accepts a valid repository-native Issue body", async () => {
  const result = await validateIssue({ body: validBody, root: repositoryRoot });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("rejects an empty body", async () => {
  const result = await validateIssue({ body: "", root: repositoryRoot });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("rejects a too-short body", async () => {
  const result = await validateIssue({ body: "too short", root: repositoryRoot });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});
