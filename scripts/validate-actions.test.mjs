import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateActionText, validateRepositoryActions } from "./validate-actions.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = "a".repeat(40);

test("accepts immutable external actions and repository-local actions", () => {
  const result = validateActionText(
    [
      "      uses: actions/checkout@" + sha + " # v4.4.0",
      "      - uses: github/codeql-action/init@" + sha,
      "      uses: ./.github/actions/local-action",
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.references.length, 3);
  assert.equal(result.references.filter((reference) => reference.local).length, 1);
});

test("rejects mutable, incomplete, and missing external action refs", () => {
  const result = validateActionText(
    ["      uses: actions/checkout@v4", "      uses: actions/setup-node@1234", "      uses:"].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
  assert.match(result.errors[2], /same line/u);
});

test("all repository-owned workflow and composite-action refs are pinned", () => {
  const result = validateRepositoryActions(repositoryRoot);

  assert.deepEqual(result.errors, []);
  assert.ok(result.files.length > 0);
  assert.ok(result.references.some((reference) => !reference.local));
});
