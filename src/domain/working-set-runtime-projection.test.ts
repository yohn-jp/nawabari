import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID,
  allowsWorkingSetPath,
  compileWorkingSetRuntimeProjection,
  resolveWorkingSetPaths,
  validateWorkingSetRuntimeProjection,
} from "./working-set-runtime-projection.js";

const BASE = "a".repeat(40);

function workingSet() {
  return {
    version: 1 as const,
    kind: "effective-working-set" as const,
    revision: 1 as const,
    id: "ews-test",
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: BASE },
    scope: {
      readOnly: ["src/**", "README.md"],
      write: ["src/allowed.ts"],
      create: ["src/generated.ts"],
      delete: [],
      deny: ["src/secret.ts"],
    },
    provenance: {
      executionScope: { kind: "implementation-execution-scope", version: 1, digest: "a".repeat(64), identity: "body" },
      candidateWorkingSet: { kind: "candidate-working-set", version: 1, digest: "b".repeat(64), identity: "candidate" },
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
      base: { branch: "main", revision: BASE },
    },
  };
}

test("compiles a versioned working-set runtime projection and keeps DENY authoritative", () => {
  const result = compileWorkingSetRuntimeProjection(workingSet());
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.contract_id, WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID);
  assert.equal(result.value.revision, 1);
  assert.equal(allowsWorkingSetPath(result.value, "src/allowed.ts", "READONLY"), true);
  assert.equal(allowsWorkingSetPath(result.value, "src/allowed.ts", "WRITE"), true);
  assert.equal(allowsWorkingSetPath(result.value, "src/secret.ts", "READONLY"), false);
  assert.equal(allowsWorkingSetPath(result.value, "src/other.ts", "READONLY"), true);
  assert.equal(allowsWorkingSetPath(result.value, "src/secret.ts", "WRITE"), false);
});

test("working-set runtime validation rejects unsupported versions and unsafe selectors", () => {
  const valid = compileWorkingSetRuntimeProjection(workingSet());
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  const unsupported = validateWorkingSetRuntimeProjection({ ...valid.value, schema_version: 2 });
  assert.equal(unsupported.ok, false);
  const unsafe = validateWorkingSetRuntimeProjection({
    ...valid.value,
    scope: { ...valid.value.scope, readOnly: ["../secret"] },
  });
  assert.equal(unsafe.ok, false);
});

test("selector resolution is bounded to the worktree and does not follow symlinks", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-working-set-runtime-"));
  try {
    fs.mkdirSync(path.join(worktree, "src"));
    fs.writeFileSync(path.join(worktree, "src", "allowed.ts"), "allowed");
    fs.writeFileSync(path.join(worktree, "src", "secret.ts"), "secret");
    fs.symlinkSync(path.join(worktree, "src", "secret.ts"), path.join(worktree, "src", "link.ts"));
    const matches = resolveWorkingSetPaths(worktree, ["src/**"]);
    assert.ok(matches.includes(path.join(worktree, "src", "allowed.ts")));
    assert.ok(matches.includes(path.join(worktree, "src", "secret.ts")));
    assert.equal(matches.includes(path.join(worktree, "src", "link.ts")), false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});
