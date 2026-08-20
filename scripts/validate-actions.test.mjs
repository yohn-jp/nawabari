import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { repositoryActionFiles, validateActionText, validateRepositoryActions } from "./validate-actions.mjs";

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

test("accepts the pinned canonical reusable governance workflows", () => {
  const result = validateActionText(
    [
      "    uses: yohn-jp/.github/.github/workflows/pr-governance.yml@main",
      "    uses: yohn-jp/.github/.github/workflows/issue-governance.yml@main",
    ].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.deepEqual(result.errors, []);
  assert.equal(result.references.filter((reference) => reference.trustedReusableWorkflow).length, 2);
});

test("rejects mutable untrusted reusable workflow references", () => {
  const result = validateActionText(
    "    uses: example-org/governance/.github/workflows/pr.yml@main",
    ".github/workflows/example.yml",
  );

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /full 40-character commit SHA/u);
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

test("required test workflows do not use machine-global sandbox provisioning", () => {
  const workflowFiles = repositoryActionFiles(repositoryRoot).filter((file) => file.startsWith(".github/workflows/"));
  const forbiddenPattern = /provision-sandbox-launcher-test-capability|nawabari-sandbox-test-stub/u;
  const violations = [];
  let testWorkflowCount = 0;

  for (const file of workflowFiles) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), "utf8");
    if (!source.includes("pnpm test")) continue;
    testWorkflowCount += 1;
    if (forbiddenPattern.test(source)) violations.push(file);
  }

  assert.ok(testWorkflowCount > 0);
  assert.deepEqual(violations, []);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, ".github/actions/provision-sandbox-launcher-test-capability/action.yml")),
    false,
  );
});
