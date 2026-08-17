import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateRepositoryWorkflows, validateWorkflowText } from "./validate-workflows.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rejects duplicate top-level workflow mappings", () => {
  const result = validateWorkflowText(
    ["name: example", "on:", "  push:", "jobs:", "  one:", "    runs-on: ubuntu-latest", "jobs:"].join("\n"),
    ".github/workflows/example.yml",
  );

  assert.ok(result.errors.some((error) => /duplicate top-level key "jobs"/u.test(error)));
});

test("requires the publish job to own the npm OIDC permission", () => {
  const source = [
    "name: Publish to npm",
    "on:",
    "  workflow_dispatch:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  publish:",
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    runs-on: ubuntu-latest",
  ].join("\n");

  assert.deepEqual(validateWorkflowText(source, ".github/workflows/publish.yml").errors, []);
  assert.ok(
    validateWorkflowText(
      source.replace("      id-token: write", "      contents: read"),
      ".github/workflows/publish.yml",
    ).errors.some((error) => /id-token: write/u.test(error)),
  );
});

test("all repository workflows have one valid top-level job mapping", () => {
  const result = validateRepositoryWorkflows(repositoryRoot);

  assert.deepEqual(result.errors, []);
  assert.ok(result.files.length > 0);
});
