import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_PROFILE_SCHEMA_VERSION,
  executeVerification,
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
