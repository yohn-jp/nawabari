import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileFilesystemEnforcementIntegration,
  type FilesystemEnforcementIntegrationInput,
} from "./filesystem-enforcement-integration.js";
import { materializeFilesystemPolicy } from "./filesystem-policy-materialization.js";
import { createFilesystemPolicyToken } from "./filesystem-policy-revision.js";
import { validateWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";

const REVISION = "a".repeat(40);

function projection(scope: Record<string, readonly string[]>) {
  const result = validateWorkingSetRuntimeProjection({
    contract_id: "nawabari.working-set-runtime-projection.v1",
    schema_version: 1,
    working_set_id: "filesystem-enforcement-integration-test",
    revision: 1,
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: REVISION },
    scope: { readOnly: [], write: [], create: [], delete: [], deny: [], ...scope },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function token(registryRevision = 1) {
  const result = createFilesystemPolicyToken({
    registry_revision: registryRevision,
    session_runtime_epoch: 4,
    claim_set_generation: 2,
    working_set_revision: 1,
    profile_digest: "b".repeat(64),
    session_id: "019123e4-7abc-7def-8123-456789abcdef",
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-enforcement-integration-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "allowed.ts"), "allowed");
  fs.writeFileSync(path.join(root, "src", "secret.ts"), "secret");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function input(
  materialized_policy: FilesystemEnforcementIntegrationInput["materialized_policy"],
  policy_token = token(),
  expected_policy_token = policy_token,
): FilesystemEnforcementIntegrationInput {
  return {
    materialized_policy,
    policy_token,
    expected_policy_token,
    enforcement_options: { landlock_abi: 3, landlock_helper: "/usr/bin/landlock" },
  };
}

test("compiles one policy token, mount projection, and Landlock plan", () => {
  const value = fixture();
  try {
    const materialized = materializeFilesystemPolicy(value.root, projection({ readOnly: ["src/allowed.ts"] }));
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;
    const expected = token();
    const result = compileFilesystemEnforcementIntegration(input(materialized.value, expected));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.deepEqual(result.value.policy_token, expected);
    assert.deepEqual(result.value.landlock_rules, result.value.enforcement.landlock_rules);
    assert.deepEqual(result.value.mount_arguments.slice(-3), [
      "--ro-bind",
      path.join(value.root, "src", "allowed.ts"),
      path.join(value.root, "src", "allowed.ts"),
    ]);
  } finally {
    value.cleanup();
  }
});

test("stale policy tokens fail before unsupported policy compilation", () => {
  const value = fixture();
  try {
    const materialized = materializeFilesystemPolicy(
      value.root,
      projection({ readOnly: ["src/**"], deny: ["src/secret.ts"] }),
    );
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;
    const actual = token();
    const expected = token(2);
    const result = compileFilesystemEnforcementIntegration(input(materialized.value, actual, expected));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "STALE_REGISTRY");
  } finally {
    value.cleanup();
  }
});

test("unsupported policy fails closed without compiling a successful subset", () => {
  const value = fixture();
  try {
    const materialized = materializeFilesystemPolicy(
      value.root,
      projection({ readOnly: ["src/**"], deny: ["src/secret.ts"] }),
    );
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;
    const result = compileFilesystemEnforcementIntegration(input(materialized.value));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    value.cleanup();
  }
});
