import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_PROFILE_SCHEMA_VERSION,
  executeSourceBoundVerification,
  executeVerification,
  isVerificationSourceWitnessCurrent,
  validateVerificationProfile,
} from "./verification-executor.js";
import { success, type DomainResult } from "./domain/errors.js";
import { createFilesystemPolicyToken } from "./domain/filesystem-policy-revision.js";
import type { SandboxExecutionRequest } from "./domain/sandbox.js";
import type { SandboxExecutionResult } from "./domain/sandbox-launcher.js";

const agentWorkingSet = {
  contract_id: "nawabari.working-set-runtime-projection.v1" as const,
  schema_version: 1 as const,
  working_set_id: "agent-ews",
  revision: 7,
  repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
  base: { branch: "main", revision: "a".repeat(40) },
  scope: {
    readOnly: ["src/**"],
    write: ["src/allowed.ts"],
    create: ["src/generated.ts"],
    delete: ["src/removed.ts"],
    deny: ["src/secret.ts"],
  },
};

const runtimeProjection = {
  contract_id: "nawabari.session-runtime-projection.v1" as const,
  schema_version: 1 as const,
  policy: {
    mode: "strict" as const,
    host_visibility: "default-deny" as const,
    compatibility: "disabled" as const,
    unrestricted_host_fallback: "forbidden" as const,
  },
  profile: { id: "node-runtime", version: "1" },
  requirements: [],
  filesystem: [],
  executables: [],
  working_set: agentWorkingSet,
};

const profile = {
  contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
  schema_version: VERIFICATION_PROFILE_SCHEMA_VERSION,
  profile_id: "package-check",
  profile_version: "1",
  executable: "/usr/bin/node",
  argv: ["--test"],
  cwd: "/repo/worktree",
  read_visibility: "repository" as const,
  write_policy: "deny" as const,
  timeout_ms: 10_000,
  max_output_bytes: 1_024,
};

const request = {
  enforce: true,
  worktree: "/repo/worktree",
  runtime_projection: runtimeProjection,
} as unknown as SandboxExecutionRequest;

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function createSourceRepository(): {
  readonly root: string;
  readonly request: SandboxExecutionRequest;
  cleanup(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-verification-source-"));
  runGit(["init", "--quiet", "--initial-branch", "main"], root);
  runGit(["config", "user.name", "Verification Test"], root);
  runGit(["config", "user.email", "verification-test@nawabari.invalid"], root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "entry.js"), "first\n");
  runGit(["add", "src/entry.js"], root);
  runGit(["commit", "--quiet", "-m", "initial"], root);
  const head = runGit(["rev-parse", "HEAD"], root);
  const sessionId = "019123e4-7abc-7def-8123-456789abcdef";
  const sourceRuntimeProjection = {
    ...runtimeProjection,
    working_set: {
      ...agentWorkingSet,
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
      base: { branch: "main", revision: head },
    },
  };
  return {
    root,
    request: {
      schema_version: 1,
      contract_id: "nawabari.sandbox-execution.v1",
      enforce: true,
      session_id: sessionId,
      repository: "yohn-jp/nawabari",
      worktree: root,
      branch: "main",
      network_mode: "inherited",
      sandbox_executable: "/usr/bin/bwrap",
      identity: { real_uid: 1000, real_gid: 1000, namespace_uid: 0, namespace_gid: 0 },
      git_identity: { host_global_name: null, host_global_email: null },
      filesystem: {
        owned_worktree: root,
        home: "/home/nawabari",
        cache: "/tmp/nawabari-cache",
        persistent_home: path.join(root, ".nawabari"),
        git_metadata: path.join(root, ".git"),
        git_objects: path.join(root, ".git", "objects"),
        user_tool_paths: [],
        runtime_paths: [],
        system_paths: [],
      },
      required_capabilities: [],
      seccomp_profile: { id: "test" },
      capability_baseline: { id: "test" },
      runtime_projection: sourceRuntimeProjection,
      runtime_resolution: {
        policy: {
          mode: "strict",
          host_visibility: "default-deny",
          compatibility: "disabled",
          unrestricted_host_fallback: "forbidden",
        },
        profile: { id: "node-runtime", version: "1" },
        materializer: "provided",
      },
    } as unknown as SandboxExecutionRequest,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function sourcePolicyFence(sessionId: string) {
  const token = createFilesystemPolicyToken({
    registry_revision: 1,
    session_runtime_epoch: 2,
    claim_set_generation: 3,
    working_set_revision: 7,
    profile_digest: "b".repeat(64),
    session_id: sessionId,
  });
  if (!token.ok) throw token.error;
  return { policy_token: token.value, expected_policy_token: token.value };
}

function policyToken(registryRevision: number) {
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

test("verification profile is versioned, fixed-argv, and default-deny", () => {
  const parsed = validateVerificationProfile(profile);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.argv, ["--test"]);
  assert.equal(parsed.value.write_policy, "deny");
  assert.equal(parsed.value.read_visibility, "repository");

  const shell = validateVerificationProfile({ ...profile, executable: "/bin/sh", argv: ["-c", "cat secret"] });
  assert.equal(shell.ok, false);
  const unsupported = validateVerificationProfile({ ...profile, schema_version: 2 });
  assert.equal(unsupported.ok, false);
});

test("verification derives a repository read-only projection without mutating agent EWS", async () => {
  const source = "secret-source-content-".repeat(100);
  let receivedRequest: SandboxExecutionRequest | null = null;
  const execute = async (sandboxRequest: SandboxExecutionRequest): Promise<DomainResult<SandboxExecutionResult>> => {
    receivedRequest = sandboxRequest;
    return success({
      exit_code: 1,
      signal: null,
      stdout: source,
      stderr: "\u0000diagnostic\n" + source,
      duration_ms: 3,
    });
  };

  const result = await executeVerification(profile, request, { execute });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.working_set_mutated, false);
  assert.notEqual(result.value.stdout.text, source);
  assert.ok(result.value.stdout.text.length <= 4_096);
  assert.notEqual(receivedRequest, request);
  assert.deepEqual(request.runtime_projection?.working_set, agentWorkingSet);
  const projectedRequest = receivedRequest as unknown as SandboxExecutionRequest;
  assert.deepEqual(projectedRequest.runtime_projection?.working_set?.scope, {
    readOnly: ["**"],
    write: [],
    create: [],
    delete: [],
    deny: [],
  });
  assert.equal(projectedRequest.runtime_projection?.working_set?.working_set_id, agentWorkingSet.working_set_id);
  assert.equal(projectedRequest.runtime_projection?.working_set?.revision, agentWorkingSet.revision);
});

test("declared verification visibility is the only read grant and keeps writes denied", async () => {
  let receivedRequest: SandboxExecutionRequest | null = null;
  const execute = async (sandboxRequest: SandboxExecutionRequest): Promise<DomainResult<SandboxExecutionResult>> => {
    receivedRequest = sandboxRequest;
    return success({ exit_code: 0, signal: null, stdout: "", stderr: "", duration_ms: 1 });
  };

  const result = await executeVerification(
    { ...profile, read_visibility: "declared", declared_read: ["src/allowed.ts"] },
    request,
    { execute },
  );
  assert.equal(result.ok, true);
  const projectedRequest = receivedRequest as unknown as SandboxExecutionRequest;
  assert.deepEqual(projectedRequest.runtime_projection?.working_set?.scope, {
    readOnly: ["src/allowed.ts"],
    write: [],
    create: [],
    delete: [],
    deny: [],
  });
  assert.deepEqual(request.runtime_projection?.working_set, agentWorkingSet);
});

test("verification requires protected execution and rejects worktree escape", async () => {
  const unrestricted = await executeVerification(profile, { ...request, enforce: false } as SandboxExecutionRequest, {
    execute: async () => {
      throw new Error("must not execute");
    },
  });
  assert.equal(unrestricted.ok, false);

  const escaped = await executeVerification({ ...profile, cwd: "/repo/other" }, request, {
    execute: async () => {
      throw new Error("must not execute");
    },
  });
  assert.equal(escaped.ok, false);
});

test("stale verification policy tokens fail before protected execution", async () => {
  let executed = false;
  const result = await executeVerification(
    profile,
    request,
    {
      execute: async () => {
        executed = true;
        throw new Error("must not execute");
      },
    },
    { policy_token: policyToken(1), expected_policy_token: policyToken(2) },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "STALE_REGISTRY");
  assert.equal(executed, false);
});

test("source-bound verification rejects same-path byte edits during protected execution", async () => {
  const fixture = createSourceRepository();
  try {
    const sourcePath = path.join(fixture.root, "src", "entry.js");
    let invoked = false;
    const result = await executeSourceBoundVerification(
      { ...profile, cwd: fixture.root },
      fixture.request,
      sourcePolicyFence("019123e4-7abc-7def-8123-456789abcdef"),
      {
        execute: async () => {
          invoked = true;
          const before = fs.statSync(sourcePath);
          fs.writeFileSync(sourcePath, "other\n");
          fs.utimesSync(sourcePath, before.atime, before.mtime);
          return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 });
        },
      },
    );
    assert.equal(invoked, true);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.verification.status, "passed");
    assert.equal(result.value.status, "unavailable");
    assert.deepEqual(result.value.source, { status: "unresolved", reason: "source-changed" });
  } finally {
    fixture.cleanup();
  }
});

test("source witness currentness tracks source, base, profile, policy, runtime, and HEAD", async () => {
  const fixture = createSourceRepository();
  try {
    const policyFence = sourcePolicyFence("019123e4-7abc-7def-8123-456789abcdef");
    const result = await executeSourceBoundVerification(
      { ...profile, cwd: fixture.root },
      fixture.request,
      policyFence,
      { execute: async () => success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 }) },
    );
    assert.equal(result.ok, true);
    if (!result.ok || result.value.source.status !== "proven") return;
    const witness = result.value.source.witness;
    const currentProfile = { ...profile, cwd: fixture.root };
    assert.equal(isVerificationSourceWitnessCurrent(witness, currentProfile, fixture.request, policyFence), true);
    assert.equal(
      isVerificationSourceWitnessCurrent(
        witness,
        { ...currentProfile, profile_version: "2" },
        fixture.request,
        policyFence,
      ),
      false,
    );

    const nextToken = createFilesystemPolicyToken({
      registry_revision: 2,
      session_runtime_epoch: 2,
      claim_set_generation: 3,
      working_set_revision: 7,
      profile_digest: "b".repeat(64),
      session_id: "019123e4-7abc-7def-8123-456789abcdef",
    });
    if (!nextToken.ok) throw nextToken.error;
    assert.equal(
      isVerificationSourceWitnessCurrent(witness, currentProfile, fixture.request, {
        policy_token: nextToken.value,
        expected_policy_token: nextToken.value,
      }),
      false,
    );

    const runtime = fixture.request.runtime_projection as typeof runtimeProjection;
    const changedRuntimeRequest = {
      ...fixture.request,
      runtime_projection: { ...runtime, profile: { id: "node-runtime", version: "2" } },
    } as SandboxExecutionRequest;
    assert.equal(
      isVerificationSourceWitnessCurrent(witness, currentProfile, changedRuntimeRequest, policyFence),
      false,
    );
    const changedBaseRequest = {
      ...fixture.request,
      runtime_projection: {
        ...runtime,
        working_set: { ...runtime.working_set, base: { branch: "main", revision: "f".repeat(40) } },
      },
    } as SandboxExecutionRequest;
    assert.equal(isVerificationSourceWitnessCurrent(witness, currentProfile, changedBaseRequest, policyFence), false);

    const sourcePath = path.join(fixture.root, "src", "entry.js");
    const beforeContentEdit = fs.statSync(sourcePath);
    fs.writeFileSync(sourcePath, "other\n");
    fs.utimesSync(sourcePath, beforeContentEdit.atime, beforeContentEdit.mtime);
    assert.equal(isVerificationSourceWitnessCurrent(witness, currentProfile, fixture.request, policyFence), false);

    fs.writeFileSync(path.join(fixture.root, "src", "later.js"), "later\n");
    runGit(["add", "src/later.js"], fixture.root);
    runGit(["commit", "--quiet", "-m", "advance head"], fixture.root);
    assert.equal(isVerificationSourceWitnessCurrent(witness, currentProfile, fixture.request, policyFence), false);
  } finally {
    fixture.cleanup();
  }
});

test("source-bound verification fails closed when a declared source is unobservable", async () => {
  const fixture = createSourceRepository();
  try {
    fs.symlinkSync(path.join(fixture.root, "src", "entry.js"), path.join(fixture.root, "selected-link.js"));
    let invoked = false;
    const result = await executeSourceBoundVerification(
      { ...profile, cwd: fixture.root, read_visibility: "declared", declared_read: ["selected-link.js"] },
      fixture.request,
      sourcePolicyFence("019123e4-7abc-7def-8123-456789abcdef"),
      {
        execute: async () => {
          invoked = true;
          return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 });
        },
      },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(invoked, false);
    assert.equal(result.value.status, "unavailable");
    assert.deepEqual(result.value.source, { status: "unresolved", reason: "pre-observation-unavailable" });
  } finally {
    fixture.cleanup();
  }
});

test("source-bound verification rejects current policy and runtime changes during execution", async () => {
  for (const changedIdentity of ["policy", "runtime"] as const) {
    const fixture = createSourceRepository();
    try {
      const policyFence = sourcePolicyFence("019123e4-7abc-7def-8123-456789abcdef");
      const nextToken = createFilesystemPolicyToken({
        registry_revision: 2,
        session_runtime_epoch: 2,
        claim_set_generation: 3,
        working_set_revision: 7,
        profile_digest: "b".repeat(64),
        session_id: "019123e4-7abc-7def-8123-456789abcdef",
      });
      if (!nextToken.ok) throw nextToken.error;
      const result = await executeSourceBoundVerification(
        { ...profile, cwd: fixture.root },
        fixture.request,
        policyFence,
        {
          execute: async () => {
            if (changedIdentity === "policy") {
              policyFence.policy_token = nextToken.value;
              policyFence.expected_policy_token = nextToken.value;
            } else {
              const runtime = fixture.request.runtime_projection as typeof runtimeProjection;
              (fixture.request as { runtime_projection?: unknown }).runtime_projection = {
                ...runtime,
                profile: { id: "node-runtime", version: "changed-during-execution" },
              };
            }
            return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 });
          },
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.equal(result.value.status, "unavailable");
      assert.deepEqual(result.value.source, { status: "unresolved", reason: "source-changed" });
    } finally {
      fixture.cleanup();
    }
  }
});
