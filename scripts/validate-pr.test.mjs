import assert from "node:assert/strict";
import test from "node:test";
import { validatePullRequest } from "./validate-pr.mjs";

const validBody = [
  "## Summary",
  "",
  "Does a thing.",
  "",
  "## Linked issue",
  "",
  "Refs #117",
  "",
  "## Changes",
  "",
  "Implemented.",
  "",
  "## Validation",
  "",
  "- [x] Tests",
  "",
  "## Review focus",
  "",
  "None.",
].join("\n");

test("accepts a title and valid repository-native PR body", async () => {
  const result = await validatePullRequest({ title: "feat: add init command", body: validBody });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("rejects a body missing a required PR section", async () => {
  const result = await validatePullRequest({
    title: "feat: add init command",
    body: validBody.replace("## Review focus\n\nNone.", ""),
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("Review focus")));
});

test("rejects an unparseable PR body", async () => {
  const result = await validatePullRequest({ title: "feat: add init command", body: "not a template" });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("rejects an empty title", async () => {
  const result = await validatePullRequest({ title: "", body: validBody });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("title")));
});

test("accepts a release title with the default PR contract", async () => {
  const result = await validatePullRequest({ title: "chore: release 0.1.1", body: validBody });

  assert.equal(result.valid, true);
});
