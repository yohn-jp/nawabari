import assert from "node:assert/strict";
import test from "node:test";

import {
  BASE_RUNTIME_PROFILE,
  CANONICAL_RUNTIME_PROFILES,
  DEVELOPMENT_RUNTIME_PROFILE,
  composeRuntimeProfiles,
  isRuntimeProfileError,
  resolveRuntimeProfile,
} from "./runtime-profile.js";

test("canonical base and development profiles resolve to logical material only", () => {
  const base = resolveRuntimeProfile({ profiles: ["base"] });
  assert.equal(base.ok, true);
  if (!base.ok) return;
  assert.deepEqual(base.value.profile, { id: "base", version: "1" });
  assert.deepEqual(base.value.requirements, [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }]);
  assert.equal("filesystem" in base.value, false);
  assert.equal("executables" in base.value, false);
  assert.equal("provider" in base.value, false);

  const development = resolveRuntimeProfile({ profiles: ["development"] });
  assert.equal(development.ok, true);
  if (!development.ok) return;
  assert.deepEqual(development.value.requirements, [
    { id: "git-package", kind: "package", name: "git", version: ">=2" },
    { id: "pnpm-package", kind: "package", name: "pnpm", version: ">=11" },
    { id: "node-runtime", kind: "runtime", name: "node", version: ">=24" },
  ]);
  assert.deepEqual(development.value.selected_profiles, [{ id: "development", version: "1" }]);
});

test("profile resolution is deterministic and canonicalizes selection and requirements", () => {
  const first = resolveRuntimeProfile({ profiles: ["development", "base"] });
  const second = resolveRuntimeProfile({ profiles: ["base", "development"] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, second.value);
  assert.deepEqual(first.value.selected_profiles, [
    { id: "base", version: "1" },
    { id: "development", version: "1" },
  ]);
  assert.equal(Object.isFrozen(first.value), true);
  assert.equal(Object.isFrozen(first.value.requirements), true);

  const customCatalog = [
    {
      id: "development",
      version: "1",
      extends: ["base"],
      requirements: [
        { id: "pnpm-package", kind: "package", name: "pnpm", version: ">=11" },
        { id: "git-package", kind: "package", name: "git", version: ">=2" },
      ],
    },
    {
      id: "base",
      version: "1",
      extends: [],
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
    },
  ] as const;
  const reordered = resolveRuntimeProfile({ profiles: ["development"] }, customCatalog);
  const canonical = resolveRuntimeProfile({ profiles: ["development"] });
  assert.equal(reordered.ok, true);
  assert.equal(canonical.ok, true);
  if (!reordered.ok || !canonical.ok) return;
  assert.deepEqual(reordered.value, canonical.value);
});

test("explicit add, remove, and override operations are deterministic and visible in identity", () => {
  const result = composeRuntimeProfiles(
    ["base"],
    [
      { operation: "override", requirement: { id: "node-runtime", kind: "runtime", name: "node", version: ">=25" } },
      { operation: "add", requirement: { id: "python-runtime", kind: "runtime", name: "python", version: ">=3.12" } },
      { operation: "remove", requirement_id: "python-runtime" },
      { operation: "add", requirement: { id: "git-package", kind: "package", name: "git", version: ">=2" } },
    ],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.profile, {
    id: "composition-base-custom",
    version: "1:git-package=package:git@>=2,node-runtime=runtime:node@>=25",
  });
  assert.deepEqual(result.value.requirements, [
    { id: "git-package", kind: "package", name: "git", version: ">=2" },
    { id: "node-runtime", kind: "runtime", name: "node", version: ">=25" },
  ]);
});

test("unknown, duplicate, cyclic, and conflicting composition fails closed with typed errors", () => {
  const unknown = resolveRuntimeProfile({ profiles: ["missing"] });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "RUNTIME_PROFILE_MISSING");

  const duplicate = resolveRuntimeProfile({ profiles: ["base", "base"] });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "RUNTIME_PROFILE_AMBIGUOUS");

  const cycle = resolveRuntimeProfile({ profiles: ["one"] }, [
    { id: "one", version: "1", extends: ["two"], requirements: [] },
    { id: "two", version: "1", extends: ["one"], requirements: [] },
  ]);
  assert.equal(cycle.ok, false);
  if (!cycle.ok) assert.equal(cycle.error.code, "RUNTIME_PROFILE_AMBIGUOUS");

  const conflict = resolveRuntimeProfile({ profiles: ["one", "two"] }, [
    {
      id: "one",
      version: "1",
      extends: [],
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
    },
    {
      id: "two",
      version: "1",
      extends: [],
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=25" }],
    },
  ]);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.error.code, "RUNTIME_PROFILE_REQUIREMENT_CONFLICT");

  const kindConflict = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "override", requirement: { id: "node-runtime", kind: "package", name: "node", version: ">=24" } },
    ],
  });
  assert.equal(kindConflict.ok, false);
  if (!kindConflict.ok) assert.equal(kindConflict.error.code, "RUNTIME_PROFILE_REQUIREMENT_CONFLICT");
});

test("invalid package operations and host/path-shaped material fail closed", () => {
  const duplicateAdd = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "add", requirement: { id: "node-runtime", kind: "runtime", name: "node", version: ">=24" } },
    ],
  });
  assert.equal(duplicateAdd.ok, false);
  if (!duplicateAdd.ok) assert.equal(duplicateAdd.error.code, "RUNTIME_PROFILE_REQUIREMENT_CONFLICT");

  const missingRemove = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [{ operation: "remove", requirement_id: "nope" }],
  });
  assert.equal(missingRemove.ok, false);
  if (!missingRemove.ok) assert.equal(missingRemove.error.code, "RUNTIME_PROFILE_REQUIREMENT_MISSING");

  const hostPath = resolveRuntimeProfile({ profiles: ["host"] }, [
    {
      id: "host",
      version: "1",
      extends: [],
      requirements: [{ id: "usr", kind: "package", name: "/usr", version: "any" }],
    },
  ]);
  assert.equal(hostPath.ok, false);
  if (!hostPath.ok) assert.equal(hostPath.error.code, "RUNTIME_PROFILE_INVALID");
});

test("canonical definitions are explicit and profile errors have a stable type guard", () => {
  assert.deepEqual(BASE_RUNTIME_PROFILE.extends, []);
  assert.deepEqual(DEVELOPMENT_RUNTIME_PROFILE.extends, ["base"]);
  assert.deepEqual(
    CANONICAL_RUNTIME_PROFILES.map((profile) => profile.id),
    ["base", "development"],
  );

  const result = resolveRuntimeProfile({ profiles: [] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(isRuntimeProfileError(result.error), true);
});
