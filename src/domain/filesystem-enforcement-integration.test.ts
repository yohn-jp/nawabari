import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileFilesystemPolicyEnforcement } from "./filesystem-policy-enforcement.js";
import {
  materializeFilesystemPolicy,
  validateMaterializedFilesystemPolicy,
} from "./filesystem-policy-materialization.js";
import { validateAuxiliaryStatePolicy } from "./auxiliary-state-policy.js";
import {
  SANDBOX_CAPABILITY_BASELINE_ID,
  SANDBOX_CAPABILITY_BASELINE_VERSION,
  sandboxCapabilityBaseline,
  sandboxSeccompProfileMetadata,
} from "./sandbox-seccomp.js";
import { discoverSandboxRuntimeLayout, sandboxDoctorReport } from "./sandbox.js";
import { compileSandboxInvocation } from "./sandbox-launcher.js";
import { STRICT_RUNTIME_POLICY, validateSessionRuntimeProjection } from "./runtime-projection.js";

type RuntimeEvidence = Readonly<{
  readonly bubblewrap: string;
  readonly landlock_helper: string;
  readonly landlock_abi: number;
}>;

function runtimeEvidence(): RuntimeEvidence | null {
  const layout = discoverSandboxRuntimeLayout();
  const doctor = sandboxDoctorReport(undefined, layout);
  const bubblewrap = layout.bubblewrap;
  const landlockHelper = layout.landlock_helper;
  const landlockAbi = doctor.landlock.abi;
  if (bubblewrap === null || typeof landlockHelper !== "string" || landlockAbi === null) return null;
  try {
    return Object.freeze({
      bubblewrap: fs.realpathSync.native(bubblewrap),
      landlock_helper: fs.realpathSync.native(landlockHelper),
      landlock_abi: landlockAbi,
    });
  } catch {
    return null;
  }
}

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-enforcement-integration-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".git", "objects"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codegraph"));
  fs.writeFileSync(path.join(root, "src", "allowed.ts"), "allowed\n");
  fs.writeFileSync(path.join(root, "src", "secret.ts"), "secret\n");
  fs.writeFileSync(path.join(root, ".codegraph", "index.json"), "auxiliary\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function projection(root: string, runtime?: RuntimeEvidence) {
  const auxiliary = validateAuxiliaryStatePolicy(
    {
      contract_id: "nawabari.repository-auxiliary-state-projection.v1",
      schema_version: 1,
      source: { kind: "repository-local", path: ".codegraph" },
      target: { kind: "managed-worktree", path: ".codegraph" },
      mode: "copy",
      durability: "durable",
    },
    {
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "nawabari" },
      base: { branch: "main", revision: "a".repeat(40) },
      worktree_root: root,
      scope: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [] },
    },
    {
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "nawabari" },
      base: { branch: "main", revision: "a".repeat(40) },
      root,
      revision: "a".repeat(40),
      covered_scope: ["src/**"],
      content_paths: ["src/allowed.ts"],
    },
  );
  if (!auxiliary.ok) throw new Error(auxiliary.error.message);
  const result = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "filesystem-enforcement-integration", version: "1" },
    requirements: [],
    filesystem:
      runtime === undefined
        ? []
        : [
            {
              source: runtime.landlock_helper,
              target: runtime.landlock_helper,
              access_mode: "read-only",
              provenance: "runtime-profile" as const,
            },
          ],
    executables: [],
    working_set: {
      contract_id: "nawabari.working-set-runtime-projection.v1",
      schema_version: 1,
      working_set_id: "filesystem-enforcement-integration",
      revision: 1,
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "nawabari" },
      base: { branch: "main", revision: "a".repeat(40) },
      scope: { readOnly: ["src/allowed.ts"], write: [], create: [], delete: [], deny: [] },
    },
    auxiliary_state: auxiliary.value,
  });
  if (!result.ok) throw new Error(result.error.message);
  const policy = materializeFilesystemPolicy(root, result.value.working_set);
  if (!policy.ok) throw new Error(policy.error.message);
  const enriched = validateSessionRuntimeProjection({ ...result.value, filesystem_policy: policy.value });
  if (!enriched.ok) throw new Error(enriched.error.message);
  return { projection: enriched.value, policy: policy.value };
}

test("protected launch consumes the real materialized policy and its enforcement plan", (t) => {
  const runtime = runtimeEvidence();
  if (runtime === null) {
    t.skip("bubblewrap, Landlock, and the canonical runtime helper are unavailable");
    return;
  }
  const value = fixture();
  try {
    const { projection: runtimeProjection, policy } = projection(value.root, runtime);
    const plan = compileFilesystemPolicyEnforcement(policy, {
      landlock_abi: runtime.landlock_abi,
      landlock_helper: runtime.landlock_helper,
    });
    assert.equal(plan.ok, true, plan.ok ? "" : plan.error.message);
    if (!plan.ok) return;

    const request = {
      schema_version: 1,
      contract_id: "nawabari.sandbox-execution.v1",
      enforce: true,
      session_id: "session-filesystem-enforcement",
      repository: value.root,
      worktree: value.root,
      branch: "feature/filesystem-enforcement",
      network_mode: "inherited" as const,
      sandbox_executable: runtime.bubblewrap,
      identity: { real_uid: null, real_gid: null, namespace_uid: 0, namespace_gid: 0 },
      git_identity: { host_global_name: null, host_global_email: null },
      filesystem: {
        owned_worktree: value.root,
        home: path.join(value.root, ".nawabari-home"),
        cache: path.join(value.root, ".nawabari-cache"),
        persistent_home: path.join(value.root, ".nawabari-persistent"),
        git_metadata: path.join(value.root, ".nawabari-git"),
        git_objects: path.join(value.root, ".git", "objects"),
        user_tool_paths: [],
        user_tool_home: null,
        runtime_paths: [],
        system_paths: [],
      },
      required_capabilities: [],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_executable: runtime.landlock_helper,
      landlock_abi: runtime.landlock_abi,
      landlock_required: true,
      runtime_projection: runtimeProjection,
      filesystem_policy: policy,
    };

    const compiled = compileSandboxInvocation(request, { command: "true" });
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (!compiled.ok) return;
    const allowed = path.join(value.root, "src", "allowed.ts");
    const secret = path.join(value.root, "src", "secret.ts");
    const bindIndex = compiled.value.args.indexOf("--ro-bind");
    assert.notEqual(bindIndex, -1);
    assert.deepEqual(compiled.value.args.slice(bindIndex, bindIndex + 3), ["--ro-bind", allowed, allowed]);
    assert.equal(compiled.value.args.includes("--bind"), true);
    assert.equal(compiled.value.args.includes(secret), false);
    assert.equal(compiled.value.args.includes(path.join(value.root, ".codegraph")), true);
    assert.ok(compiled.value.landlock.rule_count > 0);
    assert.equal(plan.value.policy_digest, policy.digest);
    assert.equal(plan.value.serialization_key, "sandbox");
    assert.equal(plan.value.runtime_projection_serialization_key, "runtime-projection");
    assert.equal(SANDBOX_CAPABILITY_BASELINE_ID, "nawabari.capabilities.v1");
    assert.equal(SANDBOX_CAPABILITY_BASELINE_VERSION, 1);
  } finally {
    value.cleanup();
  }
});

test("runtime policy boundaries reject null, identity-only, and forged materializations", () => {
  const value = fixture();
  try {
    const { projection: runtimeProjection, policy } = projection(value.root);
    const identityOnly = {
      contract_id: policy.contract_id,
      schema_version: policy.schema_version,
      serialization_key: policy.serialization_key,
    };
    for (const candidate of [null, identityOnly, { ...policy, digest: "0".repeat(64) }]) {
      const validated = validateMaterializedFilesystemPolicy(candidate);
      assert.equal(validated.ok, false);
      if (!validated.ok) assert.equal(validated.error.code, "RUNTIME_PROJECTION_INVALID");
      assert.doesNotThrow(() => compileFilesystemPolicyEnforcement(candidate as never));
      const projected = validateSessionRuntimeProjection({ ...runtimeProjection, filesystem_policy: candidate });
      assert.equal(projected.ok, false);
      if (!projected.ok) assert.equal(projected.error.code, "RUNTIME_PROJECTION_INVALID");
    }
  } finally {
    value.cleanup();
  }
});
