import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY,
  projectDeclaredToolMaterial,
  serializeDeclaredToolMaterial,
  validateDeclaredToolMaterial,
} from "./runtime-provider-declared.js";
import type { RuntimeRequirement } from "./runtime-projection.js";

const requirement: RuntimeRequirement = Object.freeze({
  id: "codegraph-runtime",
  kind: "package",
  name: "codegraph",
  version: "1.4.0",
});

function snapshot(source: string): Record<string, unknown> {
  const stat = fs.statSync(source, { bigint: true });
  const bytes = fs.readFileSync(source);
  return {
    source,
    digest: createHash("sha256").update(bytes).digest("hex"),
    identity: { dev: stat.dev.toString(10), ino: stat.ino.toString(10) },
  };
}

function fixture(): { root: string; material: Record<string, unknown>; executable: string; dependency: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-declared-tool-"));
  const executable = path.join(root, "codegraph");
  const dependency = path.join(root, "index.mjs");
  fs.writeFileSync(executable, "#!/usr/bin/env node\nconsole.log('codegraph');\n", { mode: 0o755 });
  fs.writeFileSync(dependency, "export const index = true;\n", { mode: 0o644 });
  const executableEvidence = snapshot(executable);
  const material = {
    id: "codegraph-material",
    requirement_id: requirement.id,
    version: requirement.version,
    entrypoint: "codegraph",
    executable: executableEvidence,
    source_closure: [executableEvidence, snapshot(dependency)],
  };
  return { root, material, executable, dependency };
}

function assertFailure(result: { readonly ok: boolean }): asserts result is { readonly ok: false } {
  assert.equal(result.ok, false);
}

test("validates an explicit executable and exact regular-file source closure", () => {
  const fixtureValue = fixture();
  try {
    const result = validateDeclaredToolMaterial(fixtureValue.material, requirement);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(result.value.contract_id, "nawabari.declared-tool-material.v1");
    assert.equal(result.value.schema_version, 1);
    assert.deepEqual(
      result.value.source_closure.map((file) => file.source),
      [fixtureValue.dependency, fixtureValue.executable].sort(),
    );
    assert.equal(Object.isFrozen(result.value), true);
    assert.equal(Object.isFrozen(result.value.source_closure), true);
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("projects the declared entrypoint by name without PATH discovery or a directory bind", () => {
  const fixtureValue = fixture();
  try {
    const result = projectDeclaredToolMaterial(
      fixtureValue.material,
      { material_id: "codegraph-material" },
      requirement,
    );
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(result.value.executable.name, "codegraph");
    assert.equal(result.value.executable.target, fixtureValue.executable);
    assert.equal(result.value.provider_materialization.source, fixtureValue.executable);
    assert.deepEqual(
      result.value.filesystem.map((entry) => entry.source),
      [fixtureValue.dependency, fixtureValue.executable].sort(),
    );
    assert.equal(
      result.value.filesystem.some((entry) => entry.source === fixtureValue.root),
      false,
    );
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects an unselected provider/material identity instead of pretending it is available", () => {
  const fixtureValue = fixture();
  try {
    const result = projectDeclaredToolMaterial(
      fixtureValue.material,
      {
        material_id: "other-material",
        provider: { id: "other-material", requirement_id: requirement.id },
      },
      requirement,
    );
    assertFailure(result);
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects ambient-only declarations and executable aliases", () => {
  const fixtureValue = fixture();
  try {
    const ambient = { ...fixtureValue.material, executable: "codegraph", source_closure: [] };
    assertFailure(validateDeclaredToolMaterial(ambient, requirement));

    const symlink = path.join(fixtureValue.root, "alias");
    fs.symlinkSync(fixtureValue.executable, symlink);
    const aliasEvidence = snapshot(symlink);
    const aliased = {
      ...fixtureValue.material,
      executable: aliasEvidence,
      source_closure: [aliasEvidence],
    };
    assertFailure(validateDeclaredToolMaterial(aliased, requirement));
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects closure aliases and recursive canonical executable targets", () => {
  const fixtureValue = fixture();
  try {
    const hardlink = path.join(fixtureValue.root, "hardlink");
    fs.linkSync(fixtureValue.dependency, hardlink);
    const hardlinkEvidence = snapshot(hardlink);
    assertFailure(
      validateDeclaredToolMaterial(
        {
          ...fixtureValue.material,
          source_closure: [fixtureValue.material.executable, snapshot(fixtureValue.dependency), hardlinkEvidence],
        },
        requirement,
      ),
    );
    assertFailure(
      validateDeclaredToolMaterial(
        {
          ...fixtureValue.material,
          executable: {
            ...(fixtureValue.material.executable as Record<string, unknown>),
            source: "/nawabari/bin/codegraph",
          },
          source_closure: [
            { ...(fixtureValue.material.executable as Record<string, unknown>), source: "/nawabari/bin/codegraph" },
          ],
        },
        requirement,
      ),
    );
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("rejects digest and inode changes before projection", () => {
  const fixtureValue = fixture();
  try {
    const materialResult = validateDeclaredToolMaterial(fixtureValue.material, requirement);
    assert.equal(materialResult.ok, true, materialResult.ok ? "" : JSON.stringify(materialResult.error));
    fs.appendFileSync(fixtureValue.dependency, "changed\n");
    const stale = projectDeclaredToolMaterial(
      fixtureValue.material,
      { material_id: "codegraph-material" },
      requirement,
    );
    assertFailure(stale);

    const fresh = fixture();
    try {
      const staleIdentity = { ...fresh.material };
      const replacement = `${fresh.dependency}.replacement`;
      fs.writeFileSync(replacement, "export const index = true;\n", { mode: 0o644 });
      fs.renameSync(replacement, fresh.dependency);
      assertFailure(projectDeclaredToolMaterial(staleIdentity, { material_id: "codegraph-material" }, requirement));
    } finally {
      fs.rmSync(fresh.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});

test("requires exact requirement id and version and serializes under runtime-resolution", () => {
  const fixtureValue = fixture();
  try {
    assertFailure(validateDeclaredToolMaterial(fixtureValue.material, { ...requirement, id: "other" }));
    assertFailure(validateDeclaredToolMaterial({ ...fixtureValue.material, version: "2.0.0" }, requirement));
    const serialized = serializeDeclaredToolMaterial(fixtureValue.material, requirement);
    assert.equal(serialized.ok, true, serialized.ok ? "" : JSON.stringify(serialized.error));
    if (!serialized.ok) return;
    const document = JSON.parse(serialized.value) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document), [DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY]);
    assert.equal(
      (document[DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY] as Record<string, unknown>).contract_id,
      "nawabari.declared-tool-material.v1",
    );
  } finally {
    fs.rmSync(fixtureValue.root, { recursive: true, force: true });
  }
});
