import assert from "node:assert/strict";
import test from "node:test";

import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import { pinWorktreeProfile } from "./worktree-profile-pinning.js";
import {
  inspectWorktreeProfile,
  serializeWorktreeProfileInspection,
  WORKTREE_PROFILE_INSPECTION_SCHEMA_VERSION,
  WORKTREE_PROFILE_INSPECTION_SERIALIZATION_KEY,
  type WorktreeProfileCatalogObservation,
  type WorktreeProfileRuntimeObservation,
} from "./worktree-profile-inspection.js";

const profile = {
  contract_id: "nawabari.worktree-runtime-profile.v1",
  schema_version: 1,
  id: "standard",
  version: "1",
  materialSelection: { profiles: ["development"] },
  filesystem: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [".git/**"], immutable: [".git/**"] },
  tools: [
    { entrypoint: "git", provider: { id: "git-provider", requirement_id: "git-package" } },
    { entrypoint: "node", provider: { id: "node-provider", requirement_id: "node-runtime" } },
  ],
  shell: { entrypoint: "node" },
  environment: {
    home: "session",
    xdg: { config: "session", cache: "session", data: "session", state: "session" },
    tmp: "execution",
  },
  git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
  execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "optional" },
} as const;

const provenance = {
  repository: { id: "repo", revision: "0123456789012345678901234567890123456789" },
  base: { revision: "0123456789012345678901234567890123456789" },
  catalog: { path: "nawabari.profiles.json", blob_oid: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" },
  selection: { profile: "standard", parameters: {} },
} as const;

const pinned = pinWorktreeProfile(profile, provenance);

function catalog(digest: string): WorktreeProfileCatalogObservation {
  return {
    status: "available",
    digest,
    catalog: {
      profiles: [
        {
          ...profile,
          extends: [],
        },
      ],
    },
  };
}

function runtime(
  status: WorktreeProfileRuntimeObservation["status"],
  providers: WorktreeProfileRuntimeObservation["providers"],
): WorktreeProfileRuntimeObservation {
  return { status, materializer: status === "available" ? "provided" : null, providers };
}

test("inspection keeps declared, pinned, current, and materialized views separate", () => {
  const result = inspectWorktreeProfile(
    pinned,
    catalog(provenance.catalog.blob_oid),
    runtime("available", [{ id: "node-provider", requirement_id: "node-runtime" }]),
  );

  assert.equal(result.schema_version, WORKTREE_PROFILE_INSPECTION_SCHEMA_VERSION);
  assert.equal(result.declared.catalog.digest, provenance.catalog.blob_oid);
  assert.equal(result.pinned.profile.id, "standard");
  assert.equal(result.current.drift, "same");
  assert.deepEqual(
    result.runtime.tools.map((tool) => [tool.entrypoint, tool.availability]),
    [
      ["git", "missing"],
      ["node", "available"],
    ],
  );
  assert.notEqual(result.current.catalog, pinned.resolved);
});

test("catalog drift is informational and never replaces the pinned profile", () => {
  const result = inspectWorktreeProfile(
    pinned,
    catalog("0123456789012345678901234567890123456789"),
    runtime("missing", []),
  );

  assert.equal(result.current.drift, "changed");
  assert.equal(result.pinned.profile.id, pinned.resolved.id);
  assert.equal(result.runtime.status, "missing");
  assert.ok(result.runtime.tools.every((tool) => tool.availability === "missing"));
});

test("unavailable catalog is unknown and unavailable runtime does not masquerade as declared capability", () => {
  const current: WorktreeProfileCatalogObservation = { status: "unknown", reason: "catalog could not be read" };
  const result = inspectWorktreeProfile(
    pinned,
    current,
    runtime("unknown", [
      { id: "node-provider", requirement_id: "node-runtime" },
      { id: "git-provider", requirement_id: "git-package" },
    ]),
  );

  assert.equal(result.current.drift, "unknown");
  assert.ok(result.runtime.tools.every((tool) => tool.availability === "unknown"));
  assert.equal(result.pinned.profile.tools.length, 2);
});

test("inspection serialization uses one stable public document key and is observational", () => {
  const result = inspectWorktreeProfile(pinned, catalog(provenance.catalog.blob_oid), runtime("available", []));
  const document = JSON.parse(serializeWorktreeProfileInspection(result)) as Record<string, unknown>;

  assert.deepEqual(Object.keys(document), [WORKTREE_PROFILE_INSPECTION_SERIALIZATION_KEY]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.runtime.tools), true);
  assert.equal(result.pinned.digest, pinned.digest);
});
