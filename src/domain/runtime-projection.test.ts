import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  STRICT_RUNTIME_POLICY,
  projectSessionRuntimeProjection,
  runtimeMaterializationMissingError,
  runtimeProviderMissingError,
  serializeSessionRuntimeProjection,
  validateRuntimePolicy,
  validateSessionRuntimeProjection,
} from "./runtime-projection.js";

function projection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "node-development", version: "1" },
    requirements: [
      { id: "node-runtime", kind: "runtime", name: "node", version: ">=24" },
      { id: "git-package", kind: "package", name: "git", version: "2" },
    ],
    filesystem: [
      {
        source: "/materialized/node",
        target: "/runtime/node",
        access_mode: "read-only",
        provenance: "runtime-profile",
      },
      {
        source: "/session/worktree",
        target: "/workspace",
        access_mode: "read-write",
        provenance: "session",
      },
    ],
    executables: [
      {
        name: "node",
        target: "/runtime/node/bin/node",
        provider: { id: "node-profile-provider", requirement_id: "node-runtime" },
        provenance: "runtime-profile",
      },
    ],
    ...overrides,
  };
}

test("strict policy is explicit default-deny and keeps runtime profiles separate from executable projections", () => {
  const missingPolicy = validateRuntimePolicy(undefined);
  assert.equal(missingPolicy.ok, false);

  const result = validateSessionRuntimeProjection(projection());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.policy.mode, "strict");
  assert.equal(result.value.policy.host_visibility, "default-deny");
  assert.equal(result.value.policy.unrestricted_host_fallback, "forbidden");
  assert.deepEqual(result.value.profile, { id: "node-development", version: "1" });
  assert.equal("executables" in result.value.profile, false);
  assert.equal(result.value.executables[0]?.provider.requirement_id, "node-runtime");
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.filesystem), true);
});

test("canonical projection and serialization are deterministic regardless of declaration order", () => {
  const first = projectSessionRuntimeProjection(projection());
  const second = projectSessionRuntimeProjection(
    projection({
      requirements: [...(projection().requirements as unknown[]).reverse()],
      filesystem: [...(projection().filesystem as unknown[]).reverse()],
    }),
  );
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;

  assert.deepEqual(first.value, second.value);
  const serialized = serializeSessionRuntimeProjection(projection());
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  assert.equal(serialized.value, JSON.stringify(first.value));
});

test("compatibility visibility is accepted only under the explicit compatibility policy", () => {
  const result = validateSessionRuntimeProjection(
    projection({
      policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
      filesystem: [
        {
          source: "/host/runtime",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "compatibility",
        },
      ],
      executables: [
        {
          name: "host-tool",
          target: "/runtime/host-tool",
          provider: { id: "compatibility-provider", requirement_id: "node-runtime" },
          provenance: "compatibility",
        },
      ],
    }),
  );
  assert.equal(result.ok, true);
});

test("strict policy rejects compatibility projections and cannot be weakened by an alternate fallback value", () => {
  const compatibilityProjection = validateSessionRuntimeProjection(
    projection({
      filesystem: [
        {
          source: "/host/runtime",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "compatibility",
        },
      ],
    }),
  );
  assert.equal(compatibilityProjection.ok, false);
  if (!compatibilityProjection.ok) assert.equal(compatibilityProjection.error.code, "RUNTIME_PROJECTION_INVALID");

  const weakenedPolicy = validateSessionRuntimeProjection(
    projection({
      policy: { ...STRICT_RUNTIME_POLICY, unrestricted_host_fallback: "explicit-only" },
    }),
  );
  assert.equal(weakenedPolicy.ok, false);
  if (!weakenedPolicy.ok) assert.equal(weakenedPolicy.error.code, "RUNTIME_PROJECTION_INVALID");
});

test("duplicate or nested filesystem targets fail as deterministic ambiguity errors", () => {
  const duplicate = validateSessionRuntimeProjection(
    projection({
      filesystem: [
        {
          source: "/one",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
        {
          source: "/two",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "package",
        },
      ],
    }),
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.equal(duplicate.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

  const nested = validateSessionRuntimeProjection(
    projection({
      filesystem: [
        {
          source: "/one",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
        {
          source: "/two",
          target: "/runtime/bin",
          access_mode: "read-only",
          provenance: "package",
        },
      ],
    }),
  );
  assert.equal(nested.ok, false);
  if (!nested.ok) assert.equal(nested.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

  // Lexicographic target order places a sibling between an ancestor and its
  // descendant ("/runtime" < "/runtime-alt" < "/runtime/tool"), so overlap
  // detection must compare every pair, not just adjacent ones in sort order.
  const nonAdjacentOverlap = validateSessionRuntimeProjection(
    projection({
      filesystem: [
        { source: "/one", target: "/runtime", access_mode: "read-only", provenance: "runtime-profile" },
        { source: "/two", target: "/runtime-alt", access_mode: "read-only", provenance: "package" },
        { source: "/three", target: "/runtime/tool", access_mode: "read-only", provenance: "package" },
      ],
    }),
  );
  assert.equal(nonAdjacentOverlap.ok, false);
  if (!nonAdjacentOverlap.ok) assert.equal(nonAdjacentOverlap.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");
});

test("dangling provider references fail validation, not runtime provider resolution", () => {
  const result = validateSessionRuntimeProjection(
    projection({
      executables: [
        {
          name: "node",
          target: "/runtime/node/bin/node",
          provider: { id: "missing-provider", requirement_id: "not-declared" },
          provenance: "runtime-profile",
        },
      ],
    }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROJECTION_INVALID");

  const runtimeFailure = runtimeProviderMissingError("missing-provider", "node", "node-runtime");
  assert.equal(runtimeFailure.code, "RUNTIME_PROVIDER_MISSING");
  assert.deepEqual(runtimeFailure.details, {
    provider_id: "missing-provider",
    entrypoint: "node",
    requirement_id: "node-runtime",
  });
});

test("invalid paths and missing materialization use typed deterministic failures", () => {
  const invalid = validateSessionRuntimeProjection(
    projection({
      filesystem: [
        {
          source: "/materialized/../host",
          target: "/runtime",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
      ],
    }),
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "RUNTIME_PROJECTION_INVALID");

  const first = runtimeMaterializationMissingError("node-runtime", "runtime");
  const second = runtimeMaterializationMissingError("node-runtime", "runtime");
  assert.equal(first.code, "RUNTIME_MATERIALIZATION_MISSING");
  assert.equal(first.exitCode, 4);
  assert.equal(first.message, second.message);
  assert.deepEqual(first.details, second.details);
});
