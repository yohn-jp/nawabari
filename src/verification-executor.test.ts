import assert from "node:assert/strict";
import test from "node:test";

import {
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_PROFILE_SCHEMA_VERSION,
  executeVerification,
  validateVerificationProfile,
} from "./verification-executor.js";
import { success, type DomainResult } from "./domain/errors.js";
import type { SandboxExecutionRequest } from "./domain/sandbox.js";
import type { SandboxExecutionResult } from "./domain/sandbox-launcher.js";

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
} as unknown as SandboxExecutionRequest;

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

test("verification normalizes bounded diagnostics and never mutates the request", async () => {
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
  assert.equal(receivedRequest, request);
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
