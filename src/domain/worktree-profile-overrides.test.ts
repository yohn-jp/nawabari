import assert from "node:assert/strict";
import test from "node:test";

import { STRICT_RUNTIME_POLICY, EXPLICIT_COMPATIBILITY_RUNTIME_POLICY } from "./runtime-projection.js";
import { pinWorktreeProfile } from "./worktree-profile-pinning.js";
import {
  applyWorktreeProfileOverrides,
  serializeWorktreeProfileOverride,
  validateWorktreeProfileOverride,
} from "./worktree-profile-overrides.js";

const revision = "0123456789012345678901234567890123456789";
const blob = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

function profile() {
  return {
    contract_id: "nawabari.worktree-runtime-profile.v1",
    schema_version: 1,
    id: "standard",
    version: "1",
    materialSelection: { profiles: ["base"], operations: [] },
    filesystem: {
      readOnly: ["src/**", "docs/**"],
      write: ["src/**"],
      create: ["tmp/**"],
      delete: ["tmp/**"],
      deny: [".git/**"],
      immutable: [".git/**"],
    },
    tools: [
      { entrypoint: "bash", provider: { id: "runtime", requirement_id: "bash" } },
      { entrypoint: "node", provider: { id: "runtime", requirement_id: "node" } },
      { entrypoint: "git", provider: { id: "runtime", requirement_id: "git" } },
    ],
    shell: { entrypoint: "bash" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "shared-read-only", data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "governed" },
    execution: { policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY, processTracking: "optional" },
  } as const;
}

function pinned() {
  return pinWorktreeProfile(profile(), {
    repository: { id: "repo", revision },
    base: { revision },
    catalog: { path: "nawabari.profiles.json", blob_oid: blob },
    selection: { profile: "standard", parameters: {} },
  });
}

function auth(filesystem: Record<string, readonly string[]> = {}, baselineRequirements: readonly string[] = []) {
  return { externalScope: { filesystem, baselineRequirements } };
}

test("accepts bounded parameter changes, tool removal, restrictions, and baseline additions", () => {
  const result = applyWorktreeProfileOverrides(
    pinned(),
    {
      parameters: { "shell.entrypoint": "node" },
      removeTools: ["git"],
      restrictions: {
        filesystem: { readOnly: ["src/lib/**"], write: ["src/lib/**"], deny: ["src/secrets/**"] },
        execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
        environment: { xdg: { cache: "session" } },
        git: { hooks: "disabled" },
      },
      baselineRequirements: [{ id: "jq", kind: "package", name: "jq", version: "1" }],
    },
    auth({ readOnly: ["src/**"], write: ["src/**"] }, ["jq"]),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.resolved.filesystem.readOnly, ["src/lib/**"]);
  assert.deepEqual(result.value.resolved.filesystem.write, ["src/lib/**"]);
  assert.deepEqual(result.value.resolved.filesystem.deny, [".git/**", "src/secrets/**"]);
  assert.deepEqual(
    result.value.resolved.tools.map((tool) => tool.entrypoint),
    ["bash", "node"],
  );
  assert.equal(result.value.resolved.shell.entrypoint, "node");
  assert.equal(result.value.resolved.execution.policy.mode, "strict");
  assert.equal(result.value.resolved.execution.processTracking, "required");
  assert.deepEqual(result.value.resolved.materialSelection.operations, [
    { operation: "add", requirement: { id: "jq", kind: "package", name: "jq", version: "1" } },
  ]);
  assert.deepEqual(result.value.provenance.selection.parameters["worktree-profile.override"], {
    parameters: { "shell.entrypoint": "node" },
    removeTools: ["git"],
    restrictions: {
      environment: { xdg: { cache: "session" } },
      execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
      filesystem: { deny: ["src/secrets/**"], readOnly: ["src/lib/**"], write: ["src/lib/**"] },
      git: { hooks: "disabled" },
    },
    baselineRequirements: [{ id: "jq", kind: "package", name: "jq", version: "1" }],
  });
  assert.notEqual(result.value.digest, pinned().digest);
});

test("keeps operation-specific ceilings independent and rejects host paths or expansion", () => {
  const base = pinned();
  const readExpansion = applyWorktreeProfileOverrides(
    base,
    { restrictions: { filesystem: { readOnly: ["tmp/**"] } } },
    auth({ readOnly: ["tmp/**"] }),
  );
  assert.equal(readExpansion.ok, false);
  const writeExpansion = applyWorktreeProfileOverrides(
    base,
    { restrictions: { filesystem: { write: ["docs/**"] } } },
    auth({ write: ["docs/**"] }),
  );
  assert.equal(writeExpansion.ok, false);
  const hostPath = applyWorktreeProfileOverrides(
    base,
    { restrictions: { filesystem: { readOnly: ["/tmp/**"] } } },
    auth({ readOnly: ["/tmp/**"] }),
  );
  assert.equal(hostPath.ok, false);
});

test("DENY and immutable selectors cannot be removed, and strict policy cannot be weakened", () => {
  const base = pinned();
  const strictBase = pinWorktreeProfile(
    { ...profile(), execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" } },
    {
      repository: { id: "repo", revision },
      base: { revision },
      catalog: { path: "nawabari.profiles.json", blob_oid: blob },
      selection: { profile: "standard", parameters: {} },
    },
  );
  const badPolicy = applyWorktreeProfileOverrides(
    strictBase,
    { restrictions: { execution: { policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY } } },
    auth(),
  );
  assert.equal(badPolicy.ok, false);
  const badProcessTracking = applyWorktreeProfileOverrides(
    strictBase,
    { restrictions: { execution: { processTracking: "optional" } } },
    auth(),
  );
  assert.equal(badProcessTracking.ok, false);
  const restricted = applyWorktreeProfileOverrides(
    base,
    { restrictions: { filesystem: { deny: ["src/private/**"], immutable: ["src/locked/**"] } } },
    auth(),
  );
  assert.equal(restricted.ok, true);
  if (restricted.ok) {
    assert.deepEqual(restricted.value.resolved.filesystem.deny, [".git/**", "src/private/**"]);
    assert.deepEqual(restricted.value.resolved.filesystem.immutable, [".git/**", "src/locked/**"]);
  }
});

test("baseline additions require explicit external authority and tool removal cannot orphan the shell", () => {
  const base = pinned();
  const unauthorized = applyWorktreeProfileOverrides(
    base,
    { baselineRequirements: [{ id: "jq", kind: "package", name: "jq", version: "1" }] },
    auth(),
  );
  assert.equal(unauthorized.ok, false);
  const orphanedShell = applyWorktreeProfileOverrides(base, { removeTools: ["bash"] }, auth());
  assert.equal(orphanedShell.ok, false);
  const unknownTool = applyWorktreeProfileOverrides(base, { removeTools: ["missing"] }, auth());
  assert.equal(unknownTool.ok, false);
});

test("canonicalizes equivalent requests and records serialized provenance", () => {
  const base = pinned();
  const one = applyWorktreeProfileOverrides(
    base,
    { removeTools: ["git"], parameters: { "shell.entrypoint": "node" } },
    auth(),
  );
  const two = applyWorktreeProfileOverrides(
    base,
    { parameters: { "shell.entrypoint": "node" }, removeTools: ["git"] },
    auth(),
  );
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  if (one.ok && two.ok) {
    assert.equal(one.value.digest, two.value.digest);
    assert.deepEqual(one.value.resolved, two.value.resolved);
  }
  const serialized = serializeWorktreeProfileOverride({ parameters: { "shell.entrypoint": "node" } });
  assert.equal(serialized.ok, true);
  const parsed = validateWorktreeProfileOverride(JSON.parse(serialized.ok ? serialized.value : "{}"));
  assert.equal(parsed.ok, true);
});

test("rejects generic patches, ambiguous arrays, and missing authorization", () => {
  assert.equal(validateWorktreeProfileOverride({ execution: { policy: STRICT_RUNTIME_POLICY } }).ok, false);
  assert.equal(validateWorktreeProfileOverride({ removeTools: ["node", "node"] }).ok, false);
  assert.equal(applyWorktreeProfileOverrides(pinned(), {}, undefined).ok, false);
});
