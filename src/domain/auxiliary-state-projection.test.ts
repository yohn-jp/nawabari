import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { machineContract } from "../contract.js";
import {
  AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
  AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
  materializeAuxiliaryStateProjection,
  serializeAuxiliaryStateDeclaration,
  validateAuxiliaryStateDeclaration,
} from "./auxiliary-state-projection.js";

test("machine capabilities expose the bounded auxiliary-state contract", () => {
  const capabilities = machineContract("test").capabilities as unknown as Array<Record<string, unknown>>;
  const capability = capabilities.find((candidate) => candidate.id === "auxiliary-state-projection");
  assert.ok(capability);
  assert.equal(capability.contract_id, AUXILIARY_STATE_PROJECTION_CONTRACT_ID);
  assert.equal(capability.schema_version, AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION);
  assert.deepEqual(capability.source_kinds, ["repository-local"]);
  assert.deepEqual(capability.target_kinds, ["managed-worktree"]);
  assert.deepEqual(capability.modes, ["copy"]);
  assert.deepEqual(capability.durability_classes, ["durable"]);
});

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

test("the declaration is typed, versioned, bounded, and deterministic", () => {
  const result = validateAuxiliaryStateDeclaration(declaration());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.source, { kind: "repository-local", path: ".codegraph" });
  assert.deepEqual(result.value.target, { kind: "managed-worktree", path: ".codegraph" });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.source), true);
  const serialized = serializeAuxiliaryStateDeclaration(declaration());
  assert.equal(serialized.ok, true);
  if (serialized.ok) assert.equal(serialized.value, JSON.stringify(result.value));
});

test("arbitrary host sources, worktree escapes, process-local state, and Git admin paths are rejected", () => {
  for (const candidate of [
    declaration({ source: { kind: "host", path: "/tmp/state" } }),
    declaration({ source: { kind: "repository-local", path: "../outside" } }),
    declaration({ target: { kind: "managed-worktree", path: "../outside" } }),
    declaration({ target: { kind: "managed-worktree", path: "/absolute" } }),
    declaration({ durability: "process-local" }),
    declaration({ source: { kind: "repository-local", path: ".git" } }),
    declaration({ target: { kind: "managed-worktree", path: ".git/config" } }),
  ]) {
    const result = validateAuxiliaryStateDeclaration(candidate);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "AUXILIARY_STATE_INVALID");
  }
});

test("materialization copies only declared state and leaves undeclared ignored state absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-auxiliary-state-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(repository);
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(repository, ".codegraph"));
  fs.writeFileSync(path.join(repository, ".codegraph", "index.json"), "declared\n");
  fs.writeFileSync(path.join(repository, ".ignored-state"), "must not be discovered\n");

  const result = materializeAuxiliaryStateProjection(declaration(), {
    repository_root: repository,
    worktree_root: worktree,
    tracked_paths: [],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(fs.readFileSync(path.join(worktree, ".codegraph", "index.json"), "utf8"), "declared\n");
  assert.equal(fs.existsSync(path.join(worktree, ".ignored-state")), false);
});

test("materialization rejects tracked anchors, target escapes, and symlink ambiguity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-auxiliary-state-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(path.join(repository, ".codegraph"), { recursive: true });
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(repository, ".codegraph", "index"), "state\n");

  const tracked = materializeAuxiliaryStateProjection(declaration(), {
    repository_root: repository,
    worktree_root: worktree,
    tracked_paths: [".codegraph/README.md"],
  });
  assert.equal(tracked.ok, false);
  if (!tracked.ok) assert.equal(tracked.error.code, "AUXILIARY_STATE_AMBIGUOUS");

  const escaped = materializeAuxiliaryStateProjection(
    declaration({ target: { kind: "managed-worktree", path: "nested/target" } }),
    { repository_root: repository, worktree_root: worktree, tracked_paths: [] },
  );
  assert.equal(escaped.ok, true);

  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const symlinkedWorktree = path.join(root, "worktree-link");
  fs.symlinkSync(worktree, symlinkedWorktree, "dir");
  const symlink = materializeAuxiliaryStateProjection(declaration(), {
    repository_root: repository,
    worktree_root: symlinkedWorktree,
    tracked_paths: [],
  });
  assert.equal(symlink.ok, false);
  if (!symlink.ok) assert.equal(symlink.error.code, "AUXILIARY_STATE_MATERIALIZATION_FAILED");
  assert.equal(fs.existsSync(outside), true);
});
