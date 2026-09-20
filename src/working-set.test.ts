import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_WORKING_SET_KIND,
  EFFECTIVE_WORKING_SET_KIND,
  composeEffectiveWorkingSet,
  parseCandidateWorkingSet,
  parseImplementationExecutionScope,
  serializeEffectiveWorkingSet,
} from "./working-set.js";

const repository = { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" };
const base = { branch: "main", revision: "a".repeat(40), freshness: `main@${"a".repeat(40)}` };

function executionScope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: "implementation-execution-scope",
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: { ...repository, number: 373 },
      governedBodyDigest: "b".repeat(64),
    },
    repository,
    base,
    scope: { readOnly: ["src/**"], write: ["src/working-set.ts"], create: [], delete: [], deny: ["src/secret.ts"] },
    ...overrides,
  };
}

function candidate(entries: unknown[]) {
  return {
    kind: CANDIDATE_WORKING_SET_KIND,
    schemaVersion: 1,
    workingSetId: "candidate-373",
    repository,
    revision: base.revision,
    entries,
  };
}

function entry(state: string, locator: string, kind = "file") {
  return {
    state,
    target: { kind, locator },
    reason: { id: "test:fixture", summary: "bounded fixture" },
    evidence: [{ artifact: "test", reference: locator }],
  };
}

test("consumer validates both versioned external artifacts without importing either product", () => {
  assert.equal(parseImplementationExecutionScope(executionScope()).kind, "implementation-execution-scope");
  assert.equal(
    parseCandidateWorkingSet(candidate([entry("required", "src/working-set.ts")])).kind,
    CANDIDATE_WORKING_SET_KIND,
  );
  assert.throws(() => parseImplementationExecutionScope({ ...executionScope(), version: 2 }), /unsupported/u);
  assert.throws(() => parseCandidateWorkingSet({ ...candidate([]), schemaVersion: 2 }), /unsupported/u);
});

test("composition is deterministic, operation-separated, and preserves DENY", () => {
  const input = {
    executionScope: executionScope(),
    candidateWorkingSet: candidate([
      entry("required", "src/working-set.ts"),
      entry("supporting", "src/secret.ts"),
      entry("verification", "src/working-set.test.ts", "test"),
    ]),
    repository,
    base,
  };
  const first = composeEffectiveWorkingSet(input);
  const second = composeEffectiveWorkingSet(input);
  assert.equal(first.status, "satisfied");
  assert.equal(second.status, "satisfied");
  if (first.status !== "satisfied" || second.status !== "satisfied") return;
  assert.deepEqual(first.workingSet, second.workingSet);
  assert.equal(first.workingSet.kind, EFFECTIVE_WORKING_SET_KIND);
  assert.deepEqual(first.workingSet.scope.readOnly, ["src/working-set.test.ts", "src/working-set.ts"]);
  assert.deepEqual(first.workingSet.scope.write, ["src/working-set.ts"]);
  assert.deepEqual(first.workingSet.scope.deny, ["src/secret.ts"]);
  assert.equal(serializeEffectiveWorkingSet(first.workingSet), serializeEffectiveWorkingSet(second.workingSet));
});

test("required unauthorized context and repository/base mismatch are explicit unsatisfiable results", () => {
  const requiredUnauthorized = composeEffectiveWorkingSet({
    executionScope: executionScope(),
    candidateWorkingSet: candidate([entry("required", "docs/README.md")]),
    repository,
    base,
  });
  assert.equal(requiredUnauthorized.status, "unsatisfiable");
  if (requiredUnauthorized.status === "unsatisfiable")
    assert.equal(requiredUnauthorized.code, "REQUIRED_CONTEXT_UNAUTHORIZED");

  const repositoryMismatch = composeEffectiveWorkingSet({
    executionScope: executionScope(),
    candidateWorkingSet: candidate([entry("required", "src/working-set.ts")]),
    repository: { ...repository, repositoryId: "999" },
    base,
  });
  assert.equal(repositoryMismatch.status, "unsatisfiable");
  if (repositoryMismatch.status === "unsatisfiable") assert.equal(repositoryMismatch.code, "REPOSITORY_MISMATCH");

  const baseMismatch = composeEffectiveWorkingSet({
    executionScope: executionScope(),
    candidateWorkingSet: candidate([entry("required", "src/working-set.ts")]),
    repository,
    base: { ...base, revision: "c".repeat(40) },
  });
  assert.equal(baseMismatch.status, "unsatisfiable");
  if (baseMismatch.status === "unsatisfiable") assert.equal(baseMismatch.code, "BASE_MISMATCH");
});

test("unresolved candidate context never silently becomes an effective set", () => {
  const result = composeEffectiveWorkingSet({
    executionScope: executionScope(),
    candidateWorkingSet: candidate([entry("unresolved", "conflict:provider-disagreement", "unresolved")]),
    repository,
    base,
  });
  assert.equal(result.status, "unsatisfiable");
  if (result.status === "unsatisfiable") assert.equal(result.code, "UNRESOLVED_REQUIRED_CONTEXT");
});
