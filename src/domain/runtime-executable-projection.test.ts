import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CANONICAL_EXECUTABLE_ROOT,
  compileRuntimeExecutableProjection,
  runtimeExecutableProviderKey,
  type RuntimeExecutableProviderMaterialization,
} from "./runtime-executable-projection.js";
import {
  STRICT_RUNTIME_POLICY,
  validateSessionRuntimeProjection,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

function makeProjection(root: string, executables = ["node"]): SessionRuntimeProjection {
  const result = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "node-runtime", version: "1" },
    requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
    filesystem: [
      {
        source: root,
        target: "/runtime/node",
        access_mode: "read-only",
        provenance: "runtime-profile",
      },
    ],
    executables: executables.map((name) => ({
      name,
      target: "/runtime/node/bin/node",
      provider: { id: "node-provider", requirement_id: "node-runtime" },
      provenance: "runtime-profile",
    })),
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function materialization(
  projection: SessionRuntimeProjection,
  source: string,
): Map<string, RuntimeExecutableProviderMaterialization> {
  const provider = projection.executables[0]?.provider;
  if (provider === undefined) throw new Error("test projection has no provider");
  return new Map([[runtimeExecutableProviderKey(provider), { provider, source }]]);
}

test("projects one pinned provider and aliases onto the canonical executable surface", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-executable-projection-"));
  try {
    const bin = path.join(root, "bin");
    const executable = path.join(bin, "node");
    fs.mkdirSync(bin);
    fs.writeFileSync(executable, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const projection = makeProjection(root, ["node", "nodejs"]);

    const result = compileRuntimeExecutableProjection(projection);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(result.value.length, 2);
    assert.deepEqual(
      result.value.map((entry) => [entry.source, entry.target, entry.backing_target, entry.source_kind]),
      [
        [executable, `${CANONICAL_EXECUTABLE_ROOT}/node`, "/runtime/node", "file"],
        [executable, `${CANONICAL_EXECUTABLE_ROOT}/nodejs`, "/runtime/node", "file"],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("provider materializations are exact, complete, and reject undeclared or conflicting results", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-executable-projection-"));
  try {
    const bin = path.join(root, "bin");
    const executable = path.join(bin, "node");
    const other = path.join(bin, "other");
    fs.mkdirSync(bin);
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(other, "#!/bin/sh\n", { mode: 0o755 });
    const projection = makeProjection(root);
    const provider = projection.executables[0]?.provider;
    if (provider === undefined) throw new Error("test projection has no provider");

    const missing = compileRuntimeExecutableProjection(projection, new Map());
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "RUNTIME_PROVIDER_MISSING");

    const mismatch = compileRuntimeExecutableProjection(
      projection,
      materialization(projection, executable).set(runtimeExecutableProviderKey(provider), {
        provider: { ...provider, requirement_id: "other-runtime" },
        source: executable,
      }),
    );
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "RUNTIME_PROJECTION_INVALID");

    const conflict = compileRuntimeExecutableProjection(projection, materialization(projection, other));
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

    const undeclared = new Map(materialization(projection, executable));
    undeclared.set("undeclared-provider\u0000node-runtime", {
      provider: { id: "undeclared-provider", requirement_id: "node-runtime" },
      source: executable,
    });
    const undeclaredResult = compileRuntimeExecutableProjection(projection, undeclared);
    assert.equal(undeclaredResult.ok, false);
    if (!undeclaredResult.ok) assert.equal(undeclaredResult.error.code, "RUNTIME_PROJECTION_INVALID");

    fs.chmodSync(executable, 0o644);
    const nonExecutable = compileRuntimeExecutableProjection(projection);
    assert.equal(nonExecutable.ok, false);
    if (!nonExecutable.ok) assert.equal(nonExecutable.error.code, "RUNTIME_MATERIALIZATION_MISSING");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("projected executable targets cannot recurse through the canonical surface", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-executable-projection-"));
  try {
    const executable = path.join(root, "node");
    fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o755 });
    const invalid = validateSessionRuntimeProjection({
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "node-runtime", version: "1" },
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
      filesystem: [
        { source: root, target: CANONICAL_EXECUTABLE_ROOT, access_mode: "read-only", provenance: "runtime-profile" },
      ],
      executables: [
        {
          name: "node",
          target: `${CANONICAL_EXECUTABLE_ROOT}/node`,
          provider: { id: "node-provider", requirement_id: "node-runtime" },
          provenance: "runtime-profile",
        },
      ],
    });
    assert.equal(invalid.ok, true, invalid.ok ? "" : invalid.error.message);
    if (!invalid.ok) return;
    const result = compileRuntimeExecutableProjection(invalid.value);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROJECTION_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate public names fail during canonical runtime validation", () => {
  const result = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "node-runtime", version: "1" },
    requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
    filesystem: [],
    executables: [
      {
        name: "node",
        target: "/runtime/node",
        provider: { id: "a", requirement_id: "node-runtime" },
        provenance: "runtime-profile",
      },
      {
        name: "node",
        target: "/runtime/other",
        provider: { id: "b", requirement_id: "node-runtime" },
        provenance: "runtime-profile",
      },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");
});
