import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
  AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
} from "./auxiliary-state-projection.js";
import {
  EFFECTIVE_FILESYSTEM_POLICY_CONTRACT_ID,
  compileEffectiveFilesystemPolicy,
  decideEffectivePathAccess,
  serializeEffectiveFilesystemPolicy,
  validateEffectiveFilesystemPolicy,
} from "./filesystem-policy.js";
import { canonicalClaimId } from "../resource-claims.js";

const PROFILE_DIGEST = "a".repeat(64);
const SESSION_ID = "0190f1e0-0000-7000-8000-000000000001";
const WORKTREE_PATH = "/tmp/nawabari-policy-worktree";

function claim(resource: string, mode: "read" | "write" | "exclusive-write") {
  return {
    schemaVersion: 2,
    claimId: canonicalClaimId(SESSION_ID, resource, mode),
    sessionId: SESSION_ID,
    repositoryId: "1329799765",
    worktreePath: WORKTREE_PATH,
    resource,
    mode,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

function workingSet(scope: Record<string, unknown>, revision = 4) {
  return {
    version: 1,
    kind: "effective-working-set",
    revision,
    id: "ews-policy-test",
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: "a".repeat(40) },
    scope,
  };
}

function policyInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: "a".repeat(40) },
    worktreePath: WORKTREE_PATH,
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
    working_set: workingSet({
      readOnly: ["src/**"],
      write: ["src/write.ts"],
      create: ["src/new.ts"],
      delete: ["src/delete.ts"],
      rename: ["src/**"],
      deny: [],
    }),
    claims: [
      claim("src/**", "read"),
      claim("src/write.ts", "write"),
      claim("src/new.ts", "write"),
      claim("src/delete.ts", "write"),
      claim("src/old.ts", "write"),
      claim("src/new-name.ts", "write"),
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
    working_set: workingSet(
      { readOnly: ["src/write.ts"], write: ["src/write.ts"], create: [], delete: [], deny: [] },
      1,
    ),
    claims: [claim("src/write.ts", "write")],
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
    working_set: workingSet({ readOnly: [], write: [], create: [], delete: [], deny: [] }, 1),
    claims: [claim("src/**", "read")],
    claim_set_generation: 1,
    backend_requirements: undefined,
  });
  assert.equal(decideEffectivePathAccess({ policy, operation: "READONLY", path: "src/file.ts" }).allowed, false);
  assert.equal(
    decideEffectivePathAccess({ policy, operation: "READONLY", path: "/nix/store/node", domain: "runtime" }).allowed,
    true,
  );
});

test("immutable profile areas override broader mutation scopes", () => {
  const policy = compile({
    profile: {
      status: "applied",
      digest: PROFILE_DIGEST,
      filesystem: {
        readOnly: ["src/**"],
        write: ["src/**"],
        immutable: ["src/frozen.ts"],
      },
    },
    working_set: workingSet({ readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] }),
    claims: [claim("src/frozen.ts", "write")],
    claim_set_generation: 1,
    backend_requirements: undefined,
  });
  assert.equal(decideEffectivePathAccess({ policy, operation: "WRITE", path: "src/frozen.ts" }).allowed, false);
  assert.equal(decideEffectivePathAccess({ policy, operation: "READONLY", path: "src/frozen.ts" }).allowed, true);
});

test("partial claims fail closed and compiled claims are detached immutable authority", () => {
  const partial = compileEffectiveFilesystemPolicy(
    policyInput({ claims: [{ resource: "src/**", mode: "read" }], claim_set_generation: 1 }),
  );
  assert.equal(partial.ok, false);

  const mutableClaim = claim("src/mutable.ts", "write");
  const policy = compile({
    claims: [mutableClaim],
    claim_set_generation: 1,
    profile: {
      status: "applied",
      digest: PROFILE_DIGEST,
      filesystem: { write: ["src/mutable.ts"], readOnly: ["src/mutable.ts"] },
    },
    working_set: workingSet({ write: ["src/mutable.ts"], readOnly: ["src/mutable.ts"], create: [], delete: [] }, 1),
    backend_requirements: undefined,
  });
  mutableClaim.resource = "src/changed.ts";
  assert.equal(policy.claims.claims[0]?.resource, "src/mutable.ts");
  assert.equal(Object.isFrozen(policy.claims.claims[0]), true);
});

test("partial working-set facts are not treated as an applied authority", () => {
  const result = compileEffectiveFilesystemPolicy(
    policyInput({ working_set: { scope: { readOnly: ["src/**"], write: [], create: [], delete: [] } } }),
  );
  assert.equal(result.ok, false);
});

test("rename and unknown operations fail closed before scope matching", () => {
  const policy = compile();
  assert.equal(decideEffectivePathAccess({ policy, operation: "RENAME", path: "src/old.ts" }).allowed, false);
  const unknown = decideEffectivePathAccess({ policy, operation: "REPLACE" as never, path: "src/old.ts" });
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.status, "deny");
});

test("effective working sets and claims are bound to the current repository and worktree", () => {
  const foreignWorkingSet = workingSet({ readOnly: ["src/**"], write: [], create: [], delete: [] });
  foreignWorkingSet.repository = { repositoryHost: "github.com", repositoryId: "foreign", repository: "foreign/repo" };
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ working_set: foreignWorkingSet })).ok, false);

  const foreignRepositoryClaim = claim("src/write.ts", "write");
  foreignRepositoryClaim.repositoryId = "foreign";
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ claims: [foreignRepositoryClaim] })).ok, false);

  const foreignWorktreeClaim = claim("src/write.ts", "write");
  foreignWorktreeClaim.worktreePath = "/tmp/foreign-worktree";
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ claims: [foreignWorktreeClaim] })).ok, false);
});

test("effective working sets are bound to the current base branch and revision", () => {
  const foreignBranch = workingSet({ readOnly: ["src/**"], write: [], create: [], delete: [] });
  foreignBranch.base = { branch: "feature/foreign", revision: "a".repeat(40) };
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ working_set: foreignBranch })).ok, false);

  const foreignRevision = workingSet({ readOnly: ["src/**"], write: [], create: [], delete: [] });
  foreignRevision.base = { branch: "main", revision: "b".repeat(40) };
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ working_set: foreignRevision })).ok, false);
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ base: undefined })).ok, false);
});

test("runtime status is closed and all producer aliases reject conflicts", () => {
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ runtime: { status: "not-a-status" } })).ok, false);
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ runtime: "not-an-authority" })).ok, false);
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        profile: { status: "applied", digest: PROFILE_DIGEST, filesystem: { readOnly: ["src/**"] } },
        worktree_profile: { status: "applied", digest: "b".repeat(64), filesystem: { readOnly: ["src/**"] } },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        profile: {
          status: "applied",
          digest: PROFILE_DIGEST,
          profile_digest: "b".repeat(64),
          filesystem: { readOnly: ["src/**"] },
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        profile: {
          status: "applied",
          digest: PROFILE_DIGEST,
          scope: { readOnly: ["src/**"] },
          filesystem: { readOnly: ["src/other.ts"] },
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        claims: { status: "applied", claims: [claim("src/write.ts", "write")], items: [claim("src/other.ts", "read")] },
        claim_set_generation: 8,
      }),
    ).ok,
    false,
  );
  assert.equal(compileEffectiveFilesystemPolicy(policyInput({ runtime_epoch: 12, runtimeEpoch: 13 })).ok, false);
});

test("backend, generation, and rename aliases reject contradictory authorities", () => {
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        backend_requirements: {
          requirements: [{ operation: "CREATE", path: "src/new.ts" }],
          items: [{ operation: "DELETE", path: "src/delete.ts" }],
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        profile: {
          status: "applied",
          digest: PROFILE_DIGEST,
          filesystem: { readOnly: ["src/**"], rename: ["src/**"], renames: ["src/other/**"] },
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        claims: { status: "applied", generation: 7, claims: policyInput().claims },
        claim_set_generation: 8,
      }),
    ).ok,
    false,
  );
});

test("auxiliary boundaries preserve status and require canonical declarations", () => {
  const declaration = {
    contract_id: AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
    schema_version: AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
    source: { kind: "repository-local", path: ".codegraph" },
    target: { kind: "managed-worktree", path: ".codegraph" },
    mode: "copy",
    durability: "durable",
  };
  const legacy = compileEffectiveFilesystemPolicy(
    policyInput({ auxiliary_state: { status: "unapplied-legacy", declarations: [declaration] } }),
  );
  assert.equal(legacy.ok, true);
  if (legacy.ok) assert.equal(legacy.value.auxiliary.status, "unapplied-legacy");

  for (const malformed of [
    { ...declaration, source: { kind: "host", path: ".codegraph" } },
    { ...declaration, mode: "link" },
    { ...declaration, durability: "process-local" },
  ]) {
    assert.equal(compileEffectiveFilesystemPolicy(policyInput({ auxiliary_state: [malformed] })).ok, false);
  }
});

test("auxiliary declarations are canonicalized before policy identity", () => {
  const declaration = {
    contract_id: AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
    schema_version: AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
    source: { kind: "repository-local", path: ".codegraph" },
    target: { kind: "managed-worktree", path: ".codegraph" },
    mode: "copy",
    durability: "durable",
  };
  const second = {
    ...declaration,
    source: { kind: "repository-local", path: ".nawabari" },
    target: { kind: "managed-worktree", path: ".nawabari" },
  };
  const forward = compile({ auxiliary_state: [declaration, second, declaration] });
  const reversed = compile({ auxiliary_state: [second, declaration] });
  assert.equal(forward.digest, reversed.digest);
  assert.deepEqual(forward.auxiliary.scope.readOnly, reversed.auxiliary.scope.readOnly);
});

test("unknown decision domains fail closed even when authorities are legacy", () => {
  const policy = compile({
    profile: undefined,
    working_set: undefined,
    claims: undefined,
    auxiliary_state: undefined,
    backend_requirements: undefined,
  });
  const result = decideEffectivePathAccess({
    policy,
    operation: "READONLY",
    path: "/nix/store/node",
    domain: "unknown" as never,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.status, "deny");
});

test("namespace selectors reject absolute dot segments and traversal aliases", () => {
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        profile: {
          status: "applied",
          digest: PROFILE_DIGEST,
          filesystem: { readOnly: [{ domain: "runtime", path: "/nix/./store/**" }] },
        },
      }),
    ).ok,
    false,
  );
  assert.equal(
    compileEffectiveFilesystemPolicy(
      policyInput({
        backend_requirements: [{ operation: "CREATE", path: "/nix/store/../node" }],
      }),
    ).ok,
    false,
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
