import assert from "node:assert/strict";
import test from "node:test";
import { validatePullRequest } from "./validate-pr.mjs";

const validBody = "## Summary\n\nDoes a thing.\n\nCloses #7\n\n## Validation\n\n- [x] Tests\n";

test("accepts a title and body with a closing Issue and required sections", () => {
  assert.deepEqual(validatePullRequest({ title: "feat: add init command", body: validBody }).errors, []);
});

test("rejects a body with no closing Issue reference", () => {
  const errors = validatePullRequest({ title: "feat: add init command", body: "## Summary\n\n## Validation\n" }).errors;
  assert.ok(errors.some((error) => error.includes("closing Issue")));
});

test("rejects a body missing a required section", () => {
  const errors = validatePullRequest({ title: "feat: add init command", body: "Closes #7" }).errors;
  assert.ok(errors.some((error) => error.includes("## Summary")));
  assert.ok(errors.some((error) => error.includes("## Validation")));
});

test("rejects an empty title", () => {
  const errors = validatePullRequest({ title: "", body: validBody }).errors;
  assert.ok(errors.some((error) => error.includes("title")));
});
