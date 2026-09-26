import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FILESYSTEM_POLICY_SERIALIZATION_KEY,
  materializeFilesystemPolicy,
  resolveWorkingSetPathsWithEvidence,
  selectFilesystemEnforcement,
  type MaterializedFilesystemPolicy,
} from "./filesystem-policy-materialization.js";
import { validateWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";

const BASE = "a".repeat(40);

function projection(scope: Record<string, readonly string[]>) {
  const result = validateWorkingSetRuntimeProjection({
    contract_id: "nawabari.working-set-runtime-projection.v1",
    schema_version: 1,
    working_set_id: "working-set-test",
    revision: 1,
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: BASE },
    scope: {
      readOnly: [],
      write: [],
      create: [],
      delete: [],
      deny: [],
      ...scope,
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function fixture(): { readonly root: string; readonly cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-policy-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "allowed.ts"), "allowed");
  fs.writeFileSync(path.join(root, "src", "secret.ts"), "secret");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("exact CREATE grants one registry operation and never a sibling directory grant", () => {
  const fixtureValue = fixture();
  try {
    const result = materializeFilesystemPolicy(fixtureValue.root, projection({ create: ["src/generated.ts"] }));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.registry_operations.length, 1);
    assert.equal(result.value.registry_operations[0]?.operation, "CREATE");
    assert.equal(result.value.registry_operations[0]?.relativePath, "src/generated.ts");
    assert.equal(result.value.rules.length, 0);
  } finally {
    fixtureValue.cleanup();
  }
});

test("DENY holes prevent a broad subtree grant", () => {
  const fixtureValue = fixture();
  try {
    const result = materializeFilesystemPolicy(
      fixtureValue.root,
      projection({ readOnly: ["src/**"], deny: ["src/secret.ts"] }),
    );
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    const selection = selectFilesystemEnforcement(result.value);
    assert.equal(selection.status, "unsupported");
    assert.equal(selection.nativeNamespace.length, 0);
    assert.equal(
      selection.unsupported.some((entry) => entry.reason.includes("DENY")),
      true,
    );
  } finally {
    fixtureValue.cleanup();
  }
});

test("DENY overrides every exact operation capability", () => {
  const fixtureValue = fixture();
  try {
    const cases = [
      { operation: "READONLY", scope: { readOnly: ["src/allowed.ts"], deny: ["src/allowed.ts"] } },
      { operation: "WRITE", scope: { write: ["src/allowed.ts"], deny: ["src/allowed.ts"] } },
      { operation: "CREATE", scope: { create: ["src/new.ts"], deny: ["src/new.ts"] } },
      { operation: "DELETE", scope: { delete: ["src/secret.ts"], deny: ["src/secret.ts"] } },
    ] as const;

    for (const entry of cases) {
      const result = materializeFilesystemPolicy(fixtureValue.root, projection(entry.scope));
      assert.equal(result.ok, true, result.ok ? "" : result.error.message);
      if (!result.ok) continue;
      const selection = selectFilesystemEnforcement(result.value);
      assert.equal(selection.status, "unsupported", entry.operation);
      assert.equal(selection.nativePathRules.length, 0, entry.operation);
      assert.equal(selection.nativeNamespace.length, 0, entry.operation);
      assert.equal(selection.registryOperations.length, 0, entry.operation);
      assert.equal(
        selection.unsupported.some((capability) => capability.operation === entry.operation),
        true,
        entry.operation,
      );
    }
  } finally {
    fixtureValue.cleanup();
  }
});

test("read failures and expansion limits do not produce a successful subset", () => {
  const fixtureValue = fixture();
  try {
    const evidence = resolveWorkingSetPathsWithEvidence(fixtureValue.root, ["src/**"], { maxPaths: 1 });
    assert.equal(evidence.truncated, true);
    assert.equal(evidence.complete, false);

    const result = materializeFilesystemPolicy(fixtureValue.root, projection({ readOnly: ["src/**"] }), {
      maxPaths: 1,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PHYSICAL_OBSERVATION_UNAVAILABLE");
  } finally {
    fixtureValue.cleanup();
  }
});

test("materialization is serializable under the working-set runtime key", () => {
  const fixtureValue = fixture();
  try {
    const result = materializeFilesystemPolicy(fixtureValue.root, projection({ readOnly: ["src/allowed.ts"] }));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    const policy: MaterializedFilesystemPolicy = result.value;
    assert.equal(policy.serialization_key, FILESYSTEM_POLICY_SERIALIZATION_KEY);
    assert.equal(JSON.parse(JSON.stringify(policy)).serialization_key, "working-set-runtime");
  } finally {
    fixtureValue.cleanup();
  }
});
