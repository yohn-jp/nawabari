import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILTIN_WORKTREE_PROFILE_AVAILABILITY,
  BUILTIN_WORKTREE_PROFILE_CATALOG,
  BUILTIN_WORKTREE_PROFILE_IDS,
  BUILTIN_WORKTREE_PROFILES,
  getBuiltinWorktreeProfile,
  resolveBuiltinWorktreeProfile,
  serializeBuiltinWorktreeProfiles,
} from "./worktree-profile-builtins.js";

test("built-ins are a validated catalog with deterministic identities", () => {
  assert.deepEqual(BUILTIN_WORKTREE_PROFILE_IDS, ["minimal", "standard-shell"]);
  assert.deepEqual(
    BUILTIN_WORKTREE_PROFILES.map((profile) => profile.id),
    ["minimal", "standard-shell"],
  );
  assert.deepEqual(
    BUILTIN_WORKTREE_PROFILES.map((profile) => profile.version),
    ["1", "1"],
  );
  assert.equal(BUILTIN_WORKTREE_PROFILE_CATALOG.profiles, BUILTIN_WORKTREE_PROFILES);
  assert.equal(Object.isFrozen(BUILTIN_WORKTREE_PROFILES), true);
  assert.equal(Object.isFrozen(BUILTIN_WORKTREE_PROFILES[0]), true);
});

test("minimal reuses development material and standard-shell declares Bash without claiming readiness", () => {
  const minimal = getBuiltinWorktreeProfile("minimal");
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  assert.deepEqual(minimal.value.materialSelection.profiles, ["development"]);
  assert.equal(minimal.value.shell.entrypoint, "node");
  assert.equal(minimal.value.execution.policy.mode, "strict");
  assert.equal(BUILTIN_WORKTREE_PROFILE_AVAILABILITY.minimal.availability, "available");
  assert.equal(BUILTIN_WORKTREE_PROFILE_AVAILABILITY.minimal.ready, true);

  const shell = getBuiltinWorktreeProfile("standard-shell");
  assert.equal(shell.ok, true);
  if (!shell.ok) return;
  assert.deepEqual(shell.value.materialSelection.profiles, ["development"]);
  assert.equal(shell.value.shell.entrypoint, "bash");
  assert.equal(
    shell.value.tools.some((tool) => tool.entrypoint === "bash"),
    true,
  );
  assert.deepEqual(BUILTIN_WORKTREE_PROFILE_AVAILABILITY["standard-shell"].missing, ["bash-runtime"]);
  assert.equal(BUILTIN_WORKTREE_PROFILE_AVAILABILITY["standard-shell"].ready, false);
});

test("built-ins resolve through the canonical catalog and reject unknown parameters", () => {
  const resolved = resolveBuiltinWorktreeProfile({ profile: "minimal" });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.value.contract_id, "nawabari.worktree-runtime-profile.v1");
    assert.deepEqual(resolved.value.materialSelection.profiles, ["development"]);
  }
  const unknownProfile = resolveBuiltinWorktreeProfile({ profile: "missing" });
  assert.equal(unknownProfile.ok, false);
  if (!unknownProfile.ok) assert.equal(unknownProfile.error.code, "RUNTIME_PROFILE_MISSING");
  const unknownParameter = resolveBuiltinWorktreeProfile({ profile: "minimal" }, { "unknown.field": true });
  assert.equal(unknownParameter.ok, false);
  if (!unknownParameter.ok) assert.equal(unknownParameter.error.code, "RUNTIME_PROFILE_INVALID");
});

test("built-in serialization has one stable catalog document", () => {
  const document = JSON.parse(serializeBuiltinWorktreeProfiles()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), ["profiles"]);
  assert.equal(Array.isArray(document.profiles), true);
});
