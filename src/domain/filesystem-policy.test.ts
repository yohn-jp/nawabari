import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID,
  compileEffectiveFilesystemPolicy,
  decideEffectivePathAccess,
  serializeEffectiveFilesystemPolicy,
  validateEffectiveFilesystemPolicy,
} from "./filesystem-policy.js";

const PROFILE_DIGEST = "a".repeat(64);

function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    profile: {
      status: "applied",
      digest: PROFILE_DIGEST,
      filesystem: {
        readOnly: ["src/**"],
        write: ["src/write.ts"],
        create: ["src/new.ts"],
        delete: ["src/delete.ts"],
        rename: ["src/**"],
        deny: ["src/private.ts"],
      },
    },
    working_set: {
      revision: 4,
      scope: {
        readOnly: ["src/**"],
        write: ["src/write.ts"],
        create: ["src/new.ts"],
        delete: ["src/delete.ts"],
        rename: ["src/**"],
        deny: [],
      },
    },
    claims: [
      { claimId: "read", resource: "src/**", mode: "read" },
      { claimId: "write", resource: "src/write.ts", mode: "write" },
      { claimId: "create", resource: "src/new.ts", mode: "write" },
      { claimId: "delete", resource: "src/delete.ts", mode: "write" },
      { claimId: "rename", resource: "src/old.ts", mode: "write" },
      { claimId: "rename-destination", resource: "src/new-name.ts", mode: "write" },
    ],
    claim_set_generation: 8,
    runtime_epoch: 12,
    backend_requirements: [
      { operation: "CREATE", path: "src/new.ts" },
      { operation: "DELETE", path: "src/delete.ts" },
      { operation: "RENAME", path: "src/old.ts", destination: "src/new-name.ts" },
    ],
    ...overrides,
  };
}

function compile(overrides: Record<string, unknown> = {}) {
  const result = compileEffectiveFilesystemPolicy(policyInput(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test("compiles a versioned policy and fixes all source revisions in provenance", () => {
  const policy = compile();
  assert.equal(policy.contract_id, EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID);
  assert.equal(policy.provenance.profile_digest, PROFILE_DIGEST);
  assert.equal(policy.provenance.working_set_revision, 4);
  assert.equal(policy.provenance.claim_set_generation, 8);
  assert.equal(policy.provenance.runtime_epoch, 12);
  assert.equal(policy.serialization_key, "filesystem-policy");
  assert.equal(Object.isFrozen(policy), true);
});

test("evaluates READ independently and never derives it from WRITE", () => {
  const policy = compile({
    profile: {
      status: "applied",
      digest: PROFILE_DIGEST,
      filesystem: { readOnly: [], write: ["src/write.ts"], create: [], delete: [], deny: [] },
    },
    working_set: {
      revision: 1,
      scope: { readOnly: ["src/write.ts"], write: ["src/write.ts"], create: [], delete: [], deny: [] },
    },
    claims: [{ claimId: "write", resource: "src/write.ts", mode: "write" }],
    claim_set_generation: 1,
    backend_requirements: undefined,
  });
  const read = decideEffectivePathAccess({ policy, operation: "READONLY", path: "src/write.ts" });
  assert.equal(read.allowed, false);
  assert.equal(read.status, "deny");
});

test("denies before evaluating broader allows", () => {
  const policy = compile();
  const result = decideEffectivePathAccess({ policy, operation: "READONLY", path: "src/private.ts" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "explicit deny matches");
});

test("checks each mutation independently against its own working-set scope, backend need, and claim", () => {
  const policy = compile();
  assert.equal(decideEffectivePathAccess({ policy, operation: "WRITE", path: "src/write.ts" }).allowed, true);
  assert.equal(decideEffectivePathAccess({ policy, operation: "CREATE", path: "src/new.ts" }).allowed, true);
  assert.equal(decideEffectivePathAccess({ policy, operation: "DELETE", path: "src/delete.ts" }).allowed, true);
  assert.equal(
    decideEffectivePathAccess({ policy, operation: "RENAME", path: "src/old.ts", destination: "src/new-name.ts" })
      .allowed,
    true,
  );
  assert.equal(decideEffectivePathAccess({ policy, operation: "WRITE", path: "src/new.ts" }).allowed, false);
});

test("distinguishes an unapplied legacy boundary from an applied unknown boundary", () => {
  const legacy = compile({ profile: undefined, working_set: undefined });
  const legacyDecision = decideEffectivePathAccess({ policy: legacy, operation: "READONLY", path: "src/write.ts" });
  assert.equal(legacyDecision.status, "allow");
  assert.ok(legacyDecision.legacy_boundaries.includes("profile"));

  const unknown = compile({
    profile: { status: "unknown", digest: PROFILE_DIGEST, filesystem: { readOnly: ["src/**"] } },
  });
  const unknownDecision = decideEffectivePathAccess({ policy: unknown, operation: "READONLY", path: "src/write.ts" });
  assert.equal(unknownDecision.status, "unresolved");
  assert.equal(unknownDecision.allowed, false);
});

test("runtime/package/infrastructure selectors do not authorize repository content", () => {
  const policy = compile({
    profile: {
      status: "applied",
      digest: PROFILE_DIGEST,
      filesystem: { readOnly: [{ domain: "runtime", path: "/nix/store/**" }] },
    },
    working_set: { revision: 1, scope: { readOnly: [], write: [], create: [], delete: [], deny: [] } },
    claims: [{ claimId: "runtime", resource: "src/**", mode: "read" }],
    claim_set_generation: 1,
    backend_requirements: undefined,
  });
  assert.equal(decideEffectivePathAccess({ policy, operation: "READONLY", path: "src/file.ts" }).allowed, false);
  assert.equal(
    decideEffectivePathAccess({ policy, operation: "READONLY", path: "/nix/store/node", domain: "runtime" }).allowed,
    true,
  );
});

test("serialization is canonical and rejects a changed policy identity", () => {
  const policy = compile();
  const serialized = serializeEffectiveFilesystemPolicy(policy);
  assert.equal(serialized.ok, true, serialized.ok ? "" : serialized.error.message);
  const parsed = JSON.parse(serialized.ok ? serialized.value : "{}") as Record<string, unknown>;
  assert.equal(parsed.serialization_key, "filesystem-policy");
  assert.equal(validateEffectiveFilesystemPolicy(policy).ok, true);
  assert.equal(validateEffectiveFilesystemPolicy({ ...policy, digest: "b".repeat(64) }).ok, false);
});
