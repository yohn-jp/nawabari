import assert from "node:assert/strict";
import test from "node:test";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  resolveWorktreeProfile,
  validateWorktreeProfileCatalog,
  substituteProfileParameters,
} from "./worktree-profile-catalog.js";

const profile = (id: string, parents: string[] = []) => ({
  id,
  version: "1",
  extends: parents,
  materialSelection: { profiles: ["base"] },
  filesystem: { readOnly: ["src/*"], write: [], create: [], delete: [], deny: [], immutable: [] },
  tools: [{ entrypoint: "node", provider: { id: "node", requirement_id: "node-runtime" } }],
  shell: { entrypoint: "node" },
  environment: {
    home: "session",
    xdg: { config: "session", cache: "session", data: "session", state: "session" },
    tmp: "execution",
  },
  git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
  execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
});

test("catalog resolution is independent of declaration order and retains inherited material", () => {
  const catalog = validateWorktreeProfileCatalog({ profiles: [profile("child", ["base"]), profile("base")] });
  assert.equal(catalog.ok, true);
  if (!catalog.ok) return;
  const resolved = resolveWorktreeProfile({ profile: "child" }, catalog.value);
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.deepEqual(resolved.value.materialSelection.profiles, ["base"]);
});

test("cycles, missing parents, and unknown parameters fail closed", () => {
  const cycle = validateWorktreeProfileCatalog({ profiles: [profile("a", ["b"]), profile("b", ["a"])] });
  assert.equal(cycle.ok, true);
  if (cycle.ok) assert.equal(resolveWorktreeProfile({ profile: "a" }, cycle.value).ok, false);
  const missing = validateWorktreeProfileCatalog({ profiles: [profile("a", ["missing"])] });
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal(resolveWorktreeProfile({ profile: "a" }, missing.value).ok, false);
  const plain = validateWorktreeProfileCatalog({ profiles: [profile("a")] });
  assert.equal(plain.ok, true);
  if (plain.ok) {
    const resolved = resolveWorktreeProfile({ profile: "a" }, plain.value);
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(substituteProfileParameters(resolved.value, { command: "rm -rf" }).ok, false);
  }
});

test("profiles with differing versions fail closed during inheritance", () => {
  const catalog = validateWorktreeProfileCatalog({
    profiles: [profile("child", ["base"]), { ...profile("base"), version: "2" }],
  });
  assert.equal(catalog.ok, true);
  if (catalog.ok) assert.equal(resolveWorktreeProfile({ profile: "child" }, catalog.value).ok, false);
});

test("duplicate parent profiles fail closed during catalog validation", () => {
  const catalog = validateWorktreeProfileCatalog({ profiles: [profile("child", ["base", "base"])] });
  assert.equal(catalog.ok, false);
  if (!catalog.ok) assert.equal(catalog.error.code, "RUNTIME_PROFILE_AMBIGUOUS");
});
