import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
  FILESYSTEM_POLICY_TOKEN_FENCE_FIELDS,
  FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
  FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
  FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEYS,
  createFilesystemPolicyToken,
  isFilesystemPolicyTokenCurrent,
  serializeFilesystemPolicyToken,
  validateFilesystemPolicyToken,
  type FilesystemPolicyToken,
} from "./filesystem-policy-revision.js";

const SESSION_ID = "0190f1e0-0000-7000-8000-000000000001";
const PROFILE_DIGEST = "a".repeat(64);

function input(overrides: Partial<FilesystemPolicyToken> = {}) {
  return {
    registry_revision: 7,
    session_runtime_epoch: 12,
    claim_set_generation: 8,
    working_set_revision: 4,
    profile_digest: PROFILE_DIGEST,
    session_id: SESSION_ID,
    ...overrides,
  };
}

function token(overrides: Partial<FilesystemPolicyToken> = {}): FilesystemPolicyToken {
  const result = createFilesystemPolicyToken(input(overrides));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test("creates an immutable token containing each execution-fence generation", () => {
  const value = token();

  assert.deepEqual(value, {
    contract_id: FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
    serialization_key: FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
    registry_revision: 7,
    session_runtime_epoch: 12,
    claim_set_generation: 8,
    working_set_revision: 4,
    profile_digest: PROFILE_DIGEST,
    session_id: SESSION_ID,
  });
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(FILESYSTEM_POLICY_TOKEN_FENCE_FIELDS, [
    "registry_revision",
    "session_runtime_epoch",
    "claim_set_generation",
    "working_set_revision",
    "profile_digest",
    "session_id",
  ]);
});

test("revalidates an unchanged token immediately before launch", () => {
  const expected = token();
  const actual = token();

  const result = validateFilesystemPolicyToken(actual, expected);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (result.ok) assert.deepEqual(result.value, actual);
  assert.equal(isFilesystemPolicyTokenCurrent(actual, expected), true);
});

test("rejects an old token when any execution-fence generation changes", () => {
  const original = token();
  const changedFields: Array<
    keyof Pick<
      FilesystemPolicyToken,
      | "registry_revision"
      | "session_runtime_epoch"
      | "claim_set_generation"
      | "working_set_revision"
      | "profile_digest"
      | "session_id"
    >
  > = [
    "registry_revision",
    "session_runtime_epoch",
    "claim_set_generation",
    "working_set_revision",
    "profile_digest",
    "session_id",
  ];

  for (const field of changedFields) {
    const value =
      field === "session_runtime_epoch"
        ? "13"
        : field === "profile_digest"
          ? "b".repeat(64)
          : field === "session_id"
            ? "0190f1e0-0000-7000-8000-000000000002"
            : (original[field] as number) + 1;
    const current = token({ [field]: value } as Partial<FilesystemPolicyToken>);
    const result = validateFilesystemPolicyToken(original, current);
    assert.equal(result.ok, false, field);
    if (!result.ok) {
      assert.equal(result.error.code, "STALE_REGISTRY", field);
      assert.equal(result.error.details?.field, field, field);
    }
    assert.equal(isFilesystemPolicyTokenCurrent(original, current), false, field);
  }
});

test("keeps the old execution fence immutable when working-set scope expands", () => {
  const oldExecution = token({ working_set_revision: 4 });
  const nextExecution = token({ working_set_revision: 5 });

  assert.equal(oldExecution.working_set_revision, 4);
  assert.equal(nextExecution.working_set_revision, 5);
  assert.equal(validateFilesystemPolicyToken(oldExecution, oldExecution).ok, true);
  assert.equal(validateFilesystemPolicyToken(oldExecution, nextExecution).ok, false);
});

test("rejects malformed and non-canonical producer facts", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["registry_revision", { registry_revision: -1 }],
    ["runtime epoch", { session_runtime_epoch: -1 }],
    ["claim generation", { claim_set_generation: 1.5 }],
    ["working-set revision", { working_set_revision: 0 }],
    ["profile digest", { profile_digest: "not-a-digest" }],
    ["session identity", { session_id: "not-a-uuid" }],
    ["contract", { contract_id: "other.contract.v1" }],
    ["serialization key", { serialization_key: "sandbox" }],
  ];

  for (const [label, overrides] of cases) {
    const result =
      label === "contract" || label === "serialization key"
        ? validateFilesystemPolicyToken({
            contract_id: FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
            schema_version: FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
            serialization_key: FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
            ...input(),
            ...overrides,
          })
        : createFilesystemPolicyToken({ ...input(), ...overrides });
    assert.equal(result.ok, false, label);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROJECTION_INVALID", label);
  }
});

test("supports string runtime epochs without treating numeric and textual epochs as equal", () => {
  const actual = token({ session_runtime_epoch: "epoch-12" });
  const same = token({ session_runtime_epoch: "epoch-12" });
  const numeric = token({ session_runtime_epoch: 12 });

  assert.equal(validateFilesystemPolicyToken(actual, same).ok, true);
  assert.equal(validateFilesystemPolicyToken(actual, numeric).ok, false);
});

test("serializes only a validated, canonical token", () => {
  const value = token();
  const serialized = serializeFilesystemPolicyToken(value);
  assert.equal(serialized.ok, true, serialized.ok ? "" : serialized.error.message);
  if (serialized.ok) {
    assert.equal(
      serialized.value,
      JSON.stringify({
        claim_set_generation: 8,
        contract_id: FILESYSTEM_POLICY_TOKEN_CONTRACT_ID,
        profile_digest: PROFILE_DIGEST,
        registry_revision: 7,
        schema_version: FILESYSTEM_POLICY_TOKEN_SCHEMA_VERSION,
        serialization_key: FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEY,
        session_id: SESSION_ID,
        session_runtime_epoch: 12,
        working_set_revision: 4,
      }),
    );
  }

  assert.equal(serializeFilesystemPolicyToken({ ...value, claim_set_generation: 9 }).ok, true);
  assert.equal(serializeFilesystemPolicyToken({ ...value, profile_digest: "broken" }).ok, false);
});

test("exposes the integration serialization surfaces without changing token identity", () => {
  assert.deepEqual(FILESYSTEM_POLICY_TOKEN_SERIALIZATION_KEYS, ["registry", "domain-session", "sandbox"]);
  const value = token();
  const copied = { ...value };
  assert.equal(validateFilesystemPolicyToken(copied, value).ok, true);
});
