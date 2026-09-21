import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compileFilesystemPolicyEnforcement,
  compileFilesystemMounts,
  deriveFilesystemPolicyLandlockRules,
  validateFilesystemPolicyEnforcementRuntime,
} from "./filesystem-policy-enforcement.js";
import { materializeFilesystemPolicy } from "./filesystem-policy-materialization.js";
import { validateWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";

const REVISION = "a".repeat(40);

function projection(scope: Record<string, readonly string[]>) {
  const result = validateWorkingSetRuntimeProjection({
    contract_id: "nawabari.working-set-runtime-projection.v1",
    schema_version: 1,
    working_set_id: "filesystem-policy-enforcement-test",
    revision: 1,
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: REVISION },
    scope: { readOnly: [], write: [], create: [], delete: [], deny: [], ...scope },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-enforcement-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "allowed.ts"), "allowed");
  fs.writeFileSync(path.join(root, "src", "secret.ts"), "secret");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function materialize(root: string, scope: Record<string, readonly string[]>) {
  const result = materializeFilesystemPolicy(root, projection(scope));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test("compiles an exact file bind from the real worktree without projecting siblings", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { readOnly: ["src/allowed.ts"] });
    const result = compileFilesystemMounts(policy);
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.deepEqual(result.value, [
      {
        source: path.join(value.root, "src", "allowed.ts"),
        target: path.join(value.root, "src", "allowed.ts"),
        access_mode: "read-only",
        source_kind: "file",
      },
    ]);
    assert.equal(
      result.value.some((mount) => mount.target.endsWith("secret.ts")),
      false,
    );
  } finally {
    value.cleanup();
  }
});

test("does not turn a DENY-hole policy into a broad namespace bind", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { readOnly: ["src/**"], deny: ["src/secret.ts"] });
    const result = compileFilesystemMounts(policy);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    value.cleanup();
  }
});

test("revalidates a native namespace identity before binding a replacement directory", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { readOnly: ["src/**"] });
    const original = path.join(value.root, "src-original");
    const replacement = path.join(value.root, "src-replacement");
    fs.renameSync(path.join(value.root, "src"), original);
    fs.mkdirSync(replacement);
    fs.writeFileSync(path.join(replacement, "allowed.ts"), "replacement");
    fs.renameSync(replacement, path.join(value.root, "src"));

    const result = compileFilesystemMounts(policy);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    value.cleanup();
  }
});

test("rejects a native namespace replaced by a symlink escape", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { readOnly: ["src/**"] });
    const original = path.join(value.root, "src-original");
    fs.renameSync(path.join(value.root, "src"), original);
    fs.symlinkSync(original, path.join(value.root, "src"), "dir");

    const result = compileFilesystemMounts(policy);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    value.cleanup();
  }
});

test("rejects a broad namespace bind when a deny glob can match a descendant", () => {
  const value = fixture();
  try {
    fs.writeFileSync(path.join(value.root, "src", "secret.tmp"), "secret");
    const policy = materialize(value.root, { readOnly: ["src/**"], deny: ["**/*.tmp"] });
    const result = compileFilesystemMounts(policy);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    value.cleanup();
  }
});

test("keeps exact CREATE as a registry operation and emits no parent-directory grant", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { create: ["src/generated.ts"] });
    const mounts = compileFilesystemMounts(policy);
    assert.equal(mounts.ok, true, mounts.ok ? "" : mounts.error.message);
    if (!mounts.ok) return;
    assert.deepEqual(mounts.value, []);
    const plan = compileFilesystemPolicyEnforcement(policy);
    assert.equal(plan.ok, true, plan.ok ? "" : plan.error.message);
    if (plan.ok) {
      assert.equal(plan.value.registry_operations[0]?.operation, "CREATE");
      assert.equal(plan.value.registry_operations[0]?.relativePath, "src/generated.ts");
    }
  } finally {
    value.cleanup();
  }
});

test("derives Landlock from the same bind plan and rejects an ABI without truncate", () => {
  const value = fixture();
  try {
    const policy = materialize(value.root, { write: ["src/allowed.ts"] });
    const plan = compileFilesystemPolicyEnforcement(policy);
    assert.equal(plan.ok, true, plan.ok ? "" : plan.error.message);
    if (!plan.ok) return;
    assert.equal(plan.value.landlock_required_abi, 3);
    assert.deepEqual(plan.value.landlock_rules, deriveFilesystemPolicyLandlockRules(plan.value.mounts));
    const targetRule = plan.value.landlock_rules.find((rule) => rule.path.endsWith("allowed.ts"));
    assert.ok(targetRule);
    assert.equal((targetRule.allowed_access & (1 << 14)) !== 0, true);

    const unavailable = validateFilesystemPolicyEnforcementRuntime(plan.value, { landlock_abi: 2 });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
    const missingHelper = validateFilesystemPolicyEnforcementRuntime(plan.value, { landlock_helper: null });
    assert.equal(missingHelper.ok, false);
    if (!missingHelper.ok) assert.equal(missingHelper.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  } finally {
    value.cleanup();
  }
});
