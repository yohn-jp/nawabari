import assert from "node:assert/strict";
import test from "node:test";

import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import { resolveRuntimeProfile as resolveMaterialProfile } from "./runtime-profile.js";
import {
  WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY,
  WORKTREE_RUNTIME_PROFILE_DESCRIPTOR,
  serializeWorktreeRuntimeProfile,
  validateWorktreeRuntimeProfile,
} from "./worktree-runtime-profile.js";

function profileInput(): Record<string, unknown> {
  return {
    id: "standard-shell",
    version: "1",
    materialSelection: {
      profiles: ["development", "base"],
      operations: [],
    },
    filesystem: {
      readOnly: ["src/**", ".github/**"],
      write: ["src/**"],
      create: ["tmp/**"],
      delete: ["tmp/**"],
      deny: [".git/**"],
      immutable: [".git/**"],
    },
    tools: [
      { entrypoint: "node", provider: { id: "fhs", requirement_id: "node-runtime" } },
      { entrypoint: "bash", provider: { id: "fhs", requirement_id: "bash-runtime" } },
    ],
    shell: { entrypoint: "bash" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "shared-read-only", data: "session", state: "session" },
      tmp: "execution",
    },
    git: {
      config: "session-private",
      globalConfig: "excluded",
      credentialHelpers: "disabled",
      hooks: "disabled",
    },
    execution: {
      policy: STRICT_RUNTIME_POLICY,
      processTracking: "required",
    },
  };
}

function assertInvalid(input: unknown): void {
  const result = validateWorktreeRuntimeProfile(input);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.code, /^RUNTIME_PROFILE_(INVALID|AMBIGUOUS)$/u);
}

test("validates and canonically orders the bounded profile sections", () => {
  const result = validateWorktreeRuntimeProfile(profileInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.value.materialSelection.profiles, ["base", "development"]);
  assert.deepEqual(result.value.filesystem.readOnly, [".github/**", "src/**"]);
  assert.deepEqual(result.value.filesystem.write, ["src/**"]);
  assert.deepEqual(result.value.filesystem.create, ["tmp/**"]);
  assert.deepEqual(result.value.filesystem.delete, ["tmp/**"]);
  assert.deepEqual(result.value.filesystem.deny, [".git/**"]);
  assert.deepEqual(result.value.filesystem.immutable, [".git/**"]);
  assert.deepEqual(
    result.value.tools.map((tool) => tool.entrypoint),
    ["bash", "node"],
  );
  assert.equal(result.value.shell.entrypoint, "bash");
  assert.equal(result.value.contract_id, "nawabari.worktree-runtime-profile.v1");
  assert.equal(result.value.schema_version, 1);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.filesystem), true);
  assert.equal(Object.isFrozen(result.value.filesystem.write), true);
});

test("keeps filesystem operations independent and preserves deny/immutable precedence data", () => {
  const input = profileInput();
  const filesystem = input.filesystem as Record<string, unknown>;
  filesystem.readOnly = ["docs/**"];
  filesystem.write = ["src/**"];
  filesystem.create = [];
  filesystem.delete = [];
  filesystem.deny = ["src/secrets/**"];
  filesystem.immutable = ["src/locked/**"];

  const result = validateWorktreeRuntimeProfile(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.filesystem, {
    readOnly: ["docs/**"],
    write: ["src/**"],
    create: [],
    delete: [],
    deny: ["src/secrets/**"],
    immutable: ["src/locked/**"],
  });
  assert.deepEqual(WORKTREE_RUNTIME_PROFILE_DESCRIPTOR.filesystem_precedence, [
    "DENY",
    "immutable",
    "operation-specific allow",
  ]);
});

test("does not resolve or extend the existing material profile authority", () => {
  const input = profileInput();
  const selection = input.materialSelection as Record<string, unknown>;
  selection.profiles = ["repository-defined-material"];
  const result = validateWorktreeRuntimeProfile(input);
  assert.equal(result.ok, true);

  const materialWithFilesystem = resolveMaterialProfile({ profiles: ["base"] }, [
    {
      id: "base",
      version: "1",
      extends: [],
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
      filesystem: [],
    },
  ]);
  assert.equal(materialWithFilesystem.ok, false);
});

test("rejects unknown, duplicate, null, host-path, and shell-command data", () => {
  const unknownRoot = profileInput();
  unknownRoot.agent = "worker";
  assertInvalid(unknownRoot);

  const unknownFilesystem = profileInput();
  (unknownFilesystem.filesystem as Record<string, unknown>).read = ["src/**"];
  assertInvalid(unknownFilesystem);

  const duplicateTool = profileInput();
  (duplicateTool.tools as Array<Record<string, unknown>>).push({
    entrypoint: "bash",
    provider: { id: "other", requirement_id: "bash-runtime" },
  });
  assertInvalid(duplicateTool);

  const nullEnvironment = profileInput();
  nullEnvironment.environment = null;
  assertInvalid(nullEnvironment);

  const hostPath = profileInput();
  (hostPath.filesystem as Record<string, unknown>).write = ["/tmp/**"];
  assertInvalid(hostPath);

  const shellCommand = profileInput();
  shellCommand.shell = { entrypoint: "bash -lc" };
  assertInvalid(shellCommand);
});

test("serializes only the canonical profile under the worktree-profile key", () => {
  const result = serializeWorktreeRuntimeProfile(profileInput());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const document = JSON.parse(result.value) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), [WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY]);
  assert.equal(
    (document[WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY] as Record<string, unknown>).contract_id,
    "nawabari.worktree-runtime-profile.v1",
  );
});
