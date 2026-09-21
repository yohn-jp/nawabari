import assert from "node:assert/strict";
import test from "node:test";

import {
  AUXILIARY_STATE_POLICY_CONTRACT_ID,
  AUXILIARY_STATE_POLICY_SCHEMA_VERSION,
  serializeAuxiliaryStatePolicy,
  validateAuxiliaryStatePolicy,
  type AuxiliaryStatePolicyEvidence,
} from "./auxiliary-state-policy.js";
import {
  AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
  AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
} from "./auxiliary-state-projection.js";

const REVISION = "a".repeat(40);
const ROOT = "/worktrees/nawabari-473";

function declaration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract_id: AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
    schema_version: AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
    source: { kind: "repository-local", path: ".codegraph" },
    target: { kind: "managed-worktree", path: ".codegraph" },
    mode: "copy",
    durability: "durable",
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "epic/402-filesystem-authority", revision: REVISION },
    worktree_root: ROOT,
    scope: {
      readOnly: ["src/**", "README.md"],
      write: [],
      create: [],
      delete: [],
      deny: ["src/private/**"],
    },
    ...overrides,
  };
}

function evidence(overrides: Partial<AuxiliaryStatePolicyEvidence> = {}): Record<string, unknown> {
  return {
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "epic/402-filesystem-authority", revision: REVISION },
    root: ROOT,
    revision: REVISION,
    covered_scope: ["src/**"],
    content_paths: ["src/index.ts", "src/domain/auxiliary-state-projection.ts"],
    ...overrides,
  };
}

test("compiles a read-only auxiliary visibility with repository/base/scope provenance", () => {
  const result = validateAuxiliaryStatePolicy(declaration(), profile(), evidence());
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.contract_id, AUXILIARY_STATE_POLICY_CONTRACT_ID);
  assert.equal(result.value.schema_version, AUXILIARY_STATE_POLICY_SCHEMA_VERSION);
  assert.equal(result.value.visibility, "bounded");
  assert.equal(result.value.auxiliary.access, "READONLY");
  assert.deepEqual(result.value.auxiliary.scope, ["src/**"]);
  assert.deepEqual(result.value.provenance?.covered_scope, ["src/**"]);
  assert.equal(result.value.provenance?.revision, REVISION);
  assert.match(result.value.provenance?.evidence_digest ?? "", /^[0-9a-f]{64}$/u);
});

test("requires explicit declaration and refuses an index that contains out-of-scope content", () => {
  const result = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ covered_scope: ["src/**", "src/private/**"], content_paths: ["src/private/secret.ts"] }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "AUXILIARY_STATE_AMBIGUOUS");

  const missingDeclaration = validateAuxiliaryStatePolicy(
    { ...declaration(), source: undefined },
    profile(),
    evidence(),
  );
  assert.equal(missingDeclaration.ok, false);
  if (!missingDeclaration.ok) assert.equal(missingDeclaration.error.code, "AUXILIARY_STATE_INVALID");
});

test("proves covered selector containment instead of treating a narrower glob as a prefix match", () => {
  const leaked = validateAuxiliaryStatePolicy(
    declaration(),
    profile({
      scope: { readOnly: ["src/*"], write: [], create: [], delete: [], deny: [] },
    }),
    evidence({ covered_scope: ["src/**"], content_paths: ["src/index.ts"] }),
  );
  assert.equal(leaked.ok, false);
  if (!leaked.ok) assert.equal(leaked.error.code, "AUXILIARY_STATE_AMBIGUOUS");

  const nested = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ covered_scope: ["src/domain/**"], content_paths: ["src/domain/auxiliary-state-projection.ts"] }),
  );
  assert.equal(nested.ok, true, nested.ok ? "" : nested.error.message);
});

test("index and Git evidence paths are concrete and cannot smuggle wildcard selectors", () => {
  const wildcardContent = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ content_paths: ["src/**"] }),
  );
  assert.equal(wildcardContent.ok, false);
  if (!wildcardContent.ok) assert.equal(wildcardContent.error.code, "AUXILIARY_STATE_INVALID");

  const wildcardTracked = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ tracked_paths: [".codegraph/**"] }),
  );
  assert.equal(wildcardTracked.ok, false);
  if (!wildcardTracked.ok) assert.equal(wildcardTracked.error.code, "AUXILIARY_STATE_INVALID");
});

test("stale root/revision evidence closes as unsupported and never grants a read scope", () => {
  const noRoot = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ root: undefined, revision: undefined }),
  );
  assert.equal(noRoot.ok, true, noRoot.ok ? "" : noRoot.error.message);
  if (!noRoot.ok) return;
  assert.equal(noRoot.value.visibility, "unsupported");
  assert.deepEqual(noRoot.value.auxiliary.scope, []);
  assert.deepEqual(noRoot.value.auxiliary.deny, ["**"]);
  assert.equal(noRoot.value.provenance, null);

  const wrongRevision = validateAuxiliaryStatePolicy(declaration(), profile(), evidence({ revision: "b".repeat(40) }));
  assert.equal(wrongRevision.ok, false);
  if (!wrongRevision.ok) assert.equal(wrongRevision.error.code, "AUXILIARY_STATE_AMBIGUOUS");
});

test("target shadow and process-local auxiliary state are rejected", () => {
  const targetShadow = validateAuxiliaryStatePolicy(
    declaration(),
    profile(),
    evidence({ tracked_paths: [".codegraph/index.json"] }),
  );
  assert.equal(targetShadow.ok, false);
  if (!targetShadow.ok) assert.equal(targetShadow.error.code, "AUXILIARY_STATE_AMBIGUOUS");

  const processLocal = validateAuxiliaryStatePolicy(
    declaration({ source: { kind: "repository-local", path: ".codegraph/logs" } }),
    profile(),
    evidence(),
  );
  assert.equal(processLocal.ok, false);
  if (!processLocal.ok) assert.equal(processLocal.error.code, "AUXILIARY_STATE_INVALID");
});

test("serialization accepts only the canonical closed projection", () => {
  const result = validateAuxiliaryStatePolicy(declaration(), profile(), evidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = serializeAuxiliaryStatePolicy(result.value);
  assert.equal(serialized.ok, true, serialized.ok ? "" : serialized.error.message);
  if (serialized.ok) {
    const parsed = JSON.parse(serialized.value) as Record<string, unknown>;
    assert.equal(parsed.contract_id, AUXILIARY_STATE_POLICY_CONTRACT_ID);
    assert.equal((parsed.auxiliary as Record<string, unknown>).access, "READONLY");
  }

  const weakened = serializeAuxiliaryStatePolicy({
    ...result.value,
    auxiliary: { ...result.value.auxiliary, access: "WRITE" },
  });
  assert.equal(weakened.ok, false);
  if (!weakened.ok) assert.equal(weakened.error.code, "AUXILIARY_STATE_INVALID");

  const missingProvenance = serializeAuxiliaryStatePolicy({ ...result.value, provenance: null });
  assert.equal(missingProvenance.ok, false);
  if (!missingProvenance.ok) assert.equal(missingProvenance.error.code, "AUXILIARY_STATE_INVALID");

  const malformedProvenance = serializeAuxiliaryStatePolicy({
    ...result.value,
    provenance: { repository: {}, base: {}, covered_scope: [], root: ROOT, revision: REVISION },
  });
  assert.equal(malformedProvenance.ok, false);
  if (!malformedProvenance.ok) assert.equal(malformedProvenance.error.code, "AUXILIARY_STATE_INVALID");
});
