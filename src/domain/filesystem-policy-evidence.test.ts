import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxExecutionRequest } from "./sandbox.js";
import {
  FILESYSTEM_POLICY_CONTRACT_ID,
  FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID,
  FILESYSTEM_POLICY_SCHEMA_VERSION,
  VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
  VerificationExecutionAuthority,
  projectFilesystemPolicyEvidence,
  serializeFilesystemPolicyEvidence,
  serializeVerificationExecutionEvidence,
  validateFilesystemPolicy,
} from "./filesystem-policy-evidence.js";
import { success, type DomainResult } from "./errors.js";
import type { SandboxExecutionResult } from "./sandbox-launcher.js";

const policy = {
  contract_id: FILESYSTEM_POLICY_CONTRACT_ID,
  schema_version: FILESYSTEM_POLICY_SCHEMA_VERSION,
  policy_id: "ews-472",
  revision: 7,
  scope: {
    readOnly: ["docs/**"],
    write: ["src/**"],
    create: ["src/generated/**"],
    delete: ["src/removed.ts"],
    deny: ["src/secret.ts"],
  },
} as const;

const checkpoint = {
  schemaVersion: 1,
  source: "git",
  guarantee: "git-observable-only",
  repositoryId: "1329799765",
  worktreePath: "/repo/worktree",
  branchName: "feat/policy",
  headId: "a".repeat(40),
  sessionId: "session-472",
  paths: {
    changed: ["docs/readme.md", "src/generated/new.ts", "src/secret.ts", "src/updated.ts"],
    staged: ["src/updated.ts"],
    unstaged: ["docs/readme.md", "src/generated/new.ts", "src/secret.ts"],
    untracked: ["src/generated/new.ts"],
  },
  inClaim: ["src/generated/new.ts", "src/updated.ts"],
  outOfClaim: ["docs/readme.md", "src/secret.ts"],
  maxPaths: 4_096,
} as const;

test("policy input is versioned, canonical, and deny-first", () => {
  const parsed = validateFilesystemPolicy(policy);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.scope.write, ["src/**"]);
  assert.equal(Object.isFrozen(parsed.value), true);

  const unsupported = validateFilesystemPolicy({ ...policy, schema_version: 2 });
  assert.equal(unsupported.ok, false);
  const traversal = validateFilesystemPolicy({
    ...policy,
    scope: { ...policy.scope, write: ["../outside"] },
  });
  assert.equal(traversal.ok, false);
});

test("projection keeps Git mutation, claim ownership, and policy status separate", () => {
  const result = projectFilesystemPolicyEvidence(checkpoint, policy);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.paths.changed, checkpoint.paths.changed);
  assert.deepEqual(result.value.allowed, ["src/generated/new.ts", "src/updated.ts"]);
  assert.deepEqual(result.value.denied, ["docs/readme.md", "src/secret.ts"]);
  assert.deepEqual(result.value.unresolved, []);
  assert.deepEqual(result.value.in_claim, ["src/generated/new.ts", "src/updated.ts"]);
  assert.deepEqual(result.value.out_of_claim, ["docs/readme.md", "src/secret.ts"]);
  assert.deepEqual(
    result.value.entries.map((entry) => [entry.path, entry.status, entry.claim_status, entry.reason]),
    [
      ["docs/readme.md", "denied", "out_of_claim", "mutation-not-authorized"],
      ["src/generated/new.ts", "allowed", "in_claim", "allowed-create"],
      ["src/secret.ts", "denied", "out_of_claim", "denied-by-policy"],
      ["src/updated.ts", "allowed", "in_claim", "allowed-write-or-delete"],
    ],
  );
  assert.equal(result.value.observation.atomic, false);
  assert.equal(result.value.observation.point_in_time, true);
  assert.equal(result.value.complete, true);
  assert.equal(result.value.violations.length, 2);
  assert.equal(result.value.violations[0]?.code, "OUT_OF_POLICY");
  assert.match(result.value.evidence_hash, /^[0-9a-f]{64}$/u);
});

test("deny selectors override write selectors and policy provenance cannot go stale", () => {
  const broadPolicy = {
    ...policy,
    scope: { ...policy.scope, deny: ["src/**"] },
  };
  const denied = projectFilesystemPolicyEvidence(
    {
      ...checkpoint,
      paths: {
        ...checkpoint.paths,
        changed: ["src/updated.ts"],
        staged: ["src/updated.ts"],
        unstaged: [],
        untracked: [],
      },
      inClaim: ["src/updated.ts"],
      outOfClaim: [],
    },
    broadPolicy,
  );
  assert.equal(denied.ok, true);
  if (denied.ok) assert.deepEqual(denied.value.denied, ["src/updated.ts"]);

  const stale = projectFilesystemPolicyEvidence({ ...checkpoint, policy_id: "ews-472", policy_revision: 6 }, policy);
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "GIT_STATE_AMBIGUOUS");
});

test("incomplete observation is unresolved instead of being reported clean", () => {
  const incomplete = projectFilesystemPolicyEvidence(
    {
      ...checkpoint,
      observation_complete: false,
      incomplete_reasons: ["Git observation ended before the bounded status read completed"],
    },
    policy,
  );
  assert.equal(incomplete.ok, true);
  if (!incomplete.ok) return;
  assert.deepEqual(incomplete.value.allowed, []);
  assert.deepEqual(incomplete.value.denied, []);
  assert.deepEqual(incomplete.value.unresolved, checkpoint.paths.changed);
  assert.equal(incomplete.value.complete, false);
  assert.deepEqual(incomplete.value.observation.incomplete_reasons, [
    "Git observation ended before the bounded status read completed",
  ]);
});

test("an unproven claim classification keeps the evidence incomplete", () => {
  const unresolvedClaim = projectFilesystemPolicyEvidence(
    {
      ...checkpoint,
      inClaim: ["src/generated/new.ts"],
      outOfClaim: ["docs/readme.md", "src/secret.ts"],
    },
    policy,
  );
  assert.equal(unresolvedClaim.ok, true);
  if (!unresolvedClaim.ok) return;
  assert.equal(
    unresolvedClaim.value.entries.find((entry) => entry.path === "src/updated.ts")?.claim_status,
    "unresolved",
  );
  assert.equal(unresolvedClaim.value.complete, false);
});

test("serialization preserves observed paths and does not synthesize a read set", () => {
  const result = projectFilesystemPolicyEvidence(checkpoint, policy);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = serializeFilesystemPolicyEvidence(result.value);
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  const parsed = JSON.parse(serialized.value) as Record<string, unknown>;
  assert.equal(parsed.contract_id, FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID);
  assert.deepEqual((parsed.paths as { changed: string[] }).changed, checkpoint.paths.changed);
  assert.equal("read_set" in parsed, false);
  assert.equal("files_read" in parsed, false);
});

test("serialization rejects forged hashes, altered provenance, and unknown fields", () => {
  const result = projectFilesystemPolicyEvidence(checkpoint, policy);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const forgedHash = serializeFilesystemPolicyEvidence({
    ...result.value,
    evidence_hash: "0".repeat(64),
  });
  assert.equal(forgedHash.ok, false);

  const alteredProvenance = serializeFilesystemPolicyEvidence({
    ...result.value,
    policy: { ...result.value.policy, policy_id: "forged-policy" },
  });
  assert.equal(alteredProvenance.ok, false);

  const unknownField = serializeFilesystemPolicyEvidence({
    ...result.value,
    read_set: ["src/secret.ts"],
  });
  assert.equal(unknownField.ok, false);

  const malformedNested = serializeFilesystemPolicyEvidence({
    ...result.value,
    observation: { ...result.value.observation, atomic: true },
  });
  assert.equal(malformedNested.ok, false);
});

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
  working_set: {
    contract_id: "nawabari.working-set-runtime-projection.v1" as const,
    schema_version: 1 as const,
    working_set_id: "agent-ews",
    revision: 9,
    repository: { repositoryHost: "github.com", repositoryId: "1329799765" },
    base: { branch: "main", revision: "a".repeat(40) },
    scope: { readOnly: ["src/**"], write: ["src/allowed.ts"], create: [], delete: [], deny: ["src/secret.ts"] },
  },
};

const profile = {
  contract_id: "nawabari.verification-profile.v1" as const,
  schema_version: 1 as const,
  profile_id: "policy-check",
  profile_version: "1",
  executable: "/usr/bin/node",
  argv: ["--version"],
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

test("verification authority delegates protected execution without changing agent EWS", async () => {
  let observedRequest: SandboxExecutionRequest | null = null;
  const execute = async (sandboxRequest: SandboxExecutionRequest): Promise<DomainResult<SandboxExecutionResult>> => {
    observedRequest = sandboxRequest;
    return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 2 });
  };
  const authority = new VerificationExecutionAuthority({ execute });
  const evidence = await authority.executeEvidence(profile, request);
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  assert.equal(evidence.value.contract_id, VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID);
  assert.equal(evidence.value.verification.status, "passed");
  assert.equal(evidence.value.verification.working_set_mutated, false);
  assert.equal(observedRequest !== request, true);
  assert.deepEqual(request.runtime_projection?.working_set?.scope, runtimeProjection.working_set.scope);
  const projectedRequest = observedRequest as unknown as SandboxExecutionRequest;
  assert.deepEqual(projectedRequest.runtime_projection?.working_set?.scope, {
    readOnly: ["**"],
    write: [],
    create: [],
    delete: [],
    deny: [],
  });
});

test("verification serialization validates the nested result and keeps its explicit key", async () => {
  const authority = new VerificationExecutionAuthority({
    execute: async () => success({ exit_code: 1, signal: null, stdout: "", stderr: "failed", duration_ms: 1 }),
  });
  const evidence = await authority.executeEvidence(profile, request);
  assert.equal(evidence.ok, true);
  if (!evidence.ok) return;
  const serialized = serializeVerificationExecutionEvidence(evidence.value);
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  const parsed = JSON.parse(serialized.value) as Record<string, unknown>;
  assert.equal(parsed.contract_id, VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID);
  assert.equal(typeof parsed.verification, "object");
  assert.equal("result" in parsed, false);
  assert.equal("working_set" in parsed, false);
});
