import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileFilesystemMountArguments,
  compileFilesystemPolicyEnforcement,
} from "./filesystem-policy-enforcement.js";
import { materializeFilesystemPolicy } from "./filesystem-policy-materialization.js";
import { validateWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-launch-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "allowed.ts"), "allowed");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("launch fragments create parents in the namespace and bind only the selected real file", () => {
  const value = fixture();
  try {
    const projection = validateWorkingSetRuntimeProjection({
      contract_id: "nawabari.working-set-runtime-projection.v1",
      schema_version: 1,
      working_set_id: "filesystem-launch-test",
      revision: 1,
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "nawabari" },
      base: { branch: "main", revision: "a".repeat(40) },
      scope: { readOnly: ["src/allowed.ts"], write: [], create: [], delete: [], deny: [] },
    });
    assert.equal(projection.ok, true, projection.ok ? "" : projection.error.message);
    if (!projection.ok) return;
    const policy = materializeFilesystemPolicy(value.root, projection.value);
    assert.equal(policy.ok, true, policy.ok ? "" : policy.error.message);
    if (!policy.ok) return;
    const result = compileFilesystemMountArguments(policy.value);
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    const source = path.join(value.root, "src", "allowed.ts");
    const bindIndex = result.value.indexOf("--ro-bind");
    assert.notEqual(bindIndex, -1);
    assert.deepEqual(result.value.slice(bindIndex, bindIndex + 3), ["--ro-bind", source, source]);
    assert.equal(result.value.includes("secret.ts"), false);
    assert.equal(result.value.includes("cp"), false);
    const plan = compileFilesystemPolicyEnforcement(policy.value);
    assert.equal(plan.ok, true, plan.ok ? "" : plan.error.message);
    if (plan.ok) assert.equal(plan.value.mounts[0]?.source, source);
  } finally {
    value.cleanup();
  }
});
