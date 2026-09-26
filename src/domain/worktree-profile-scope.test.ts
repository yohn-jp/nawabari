import assert from "node:assert/strict";
import test from "node:test";

import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  FILESYSTEM_POLICY_SERIALIZATION_KEY,
  resolveProfileRuntimeScope,
  serializeProfileRuntimeScope,
} from "./worktree-profile-scope.js";

const profile = {
  contract_id: "nawabari.worktree-runtime-profile.v1",
  schema_version: 1,
  id: "bounded",
  version: "1",
  materialSelection: { profiles: ["base"] },
  filesystem: {
    readOnly: ["README.md"],
    write: ["src/index.ts"],
    create: [],
    delete: [],
    deny: [".git/config"],
    immutable: [".git/HEAD"],
  },
  tools: [{ entrypoint: "node", provider: { id: "node", requirement_id: "node-runtime" } }],
  shell: { entrypoint: "node" },
  environment: {
    home: "session",
    xdg: { config: "session", cache: "session", data: "session", state: "session" },
    tmp: "execution",
  },
  git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
  execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "optional" },
} as const;

function pathEvidence() {
  return {
    paths: ["README.md", "src/index.ts"],
    requests: [
      { path: "README.md", operation: "READONLY" },
      { path: "src/index.ts", operation: "WRITE" },
    ],
  } as const;
}

function ews() {
  return {
    contract_id: "nawabari.working-set-runtime-projection.v1",
    schema_version: 1,
    working_set_id: "ews-1",
    revision: 4,
    repository: { repositoryHost: "github.com", repositoryId: "repo", repository: "yohn-jp/nawabari" },
    base: { branch: "epic/401-worktree-runtime-profiles", revision: "a".repeat(40) },
    scope: { readOnly: ["README.md", "src/**"], write: ["src/index.ts"], create: [], delete: [], deny: [] },
  };
}

test("compiles finite standalone profile requests without fabricating an EWS artifact", () => {
  const result = resolveProfileRuntimeScope(profile, { repositoryId: "repo" }, pathEvidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "ready");
  assert.equal(result.value.working_set, undefined);
  assert.deepEqual(result.value.scope.readOnly, ["README.md"]);
  assert.deepEqual(result.value.scope.write, ["src/index.ts"]);
  assert.equal(result.value.profile_boundary.profile_id, "bounded");
});

test("narrows an external EWS while preserving its identity and revision", () => {
  const result = resolveProfileRuntimeScope(profile, { repositoryId: "repo", workingSet: ews() }, pathEvidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "ready");
  assert.equal(result.value.working_set?.working_set_id, "ews-1");
  assert.equal(result.value.working_set?.revision, 4);
  assert.deepEqual(result.value.working_set?.scope.readOnly, ["README.md"]);
  assert.deepEqual(result.value.working_set?.scope.write, ["src/index.ts"]);
});

test("does not convert an absent external artifact into a ready result", () => {
  const result = resolveProfileRuntimeScope(profile, { repositoryId: "repo", externalArtifact: true }, pathEvidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "unsupported");
  assert.match(result.value.diagnostics[0]?.reason ?? "", /Effective Working Set/u);
});

test("does not compile a ready scope when required claim evidence is omitted", () => {
  const result = resolveProfileRuntimeScope(profile, { repositoryId: "repo", claimsRequired: true }, pathEvidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "unsupported");
  assert.match(result.value.diagnostics[0]?.reason ?? "", /required ResourceClaim evidence/u);
});

test("projects finite evidence through broad ceilings and still rejects unsupported operations and denied intersections", () => {
  const broad = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, readOnly: ["src/**"], write: [] } },
    { repositoryId: "repo" },
    { paths: ["src/index.ts"], requests: [{ path: "src/index.ts", operation: "READONLY" }] },
  );
  assert.equal(broad.ok, true);
  if (!broad.ok) return;
  assert.equal(broad.value.status, "ready");
  assert.deepEqual(broad.value.scope.readOnly, ["src/index.ts"]);
  assert.deepEqual(broad.value.scope.write, []);

  const broadWithoutEvidence = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, readOnly: ["src/**"], write: [] } },
    { repositoryId: "repo" },
    undefined,
  );
  assert.equal(broadWithoutEvidence.ok, true);
  if (!broadWithoutEvidence.ok) return;
  assert.equal(broadWithoutEvidence.value.status, "ready");
  assert.deepEqual(broadWithoutEvidence.value.scope.readOnly, []);
  assert.deepEqual(broadWithoutEvidence.value.scope.write, []);

  const outsideCeiling = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, readOnly: ["src/**"], write: [] } },
    { repositoryId: "repo" },
    { paths: ["docs/readme.md"], requests: [{ path: "docs/readme.md", operation: "READONLY" }] },
  );
  assert.equal(outsideCeiling.ok, true);
  if (!outsideCeiling.ok) return;
  assert.equal(outsideCeiling.value.status, "unsupported");

  const selectorAsEvidence = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, readOnly: ["src/**"], write: [] } },
    { repositoryId: "repo" },
    { paths: ["src/**"], requests: [{ path: "src/**", operation: "READONLY" }] },
  );
  assert.equal(selectorAsEvidence.ok, false);

  const broadCreate = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, create: ["src/**"] } },
    { repositoryId: "repo" },
    pathEvidence(),
  );
  assert.equal(broadCreate.ok, true);
  if (!broadCreate.ok) return;
  assert.equal(broadCreate.value.status, "unsupported");

  const unsupportedOperation = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, create: ["src/new.ts"] } },
    { repositoryId: "repo" },
    { paths: ["src/new.ts"], requests: [{ path: "src/new.ts", operation: "CREATE" }] },
  );
  assert.equal(unsupportedOperation.ok, true);
  if (!unsupportedOperation.ok) return;
  assert.equal(unsupportedOperation.value.status, "unsupported");

  const denied = resolveProfileRuntimeScope(
    { ...profile, filesystem: { ...profile.filesystem, deny: ["src/index.ts"] } },
    { repositoryId: "repo" },
    pathEvidence(),
  );
  assert.equal(denied.ok, true);
  if (!denied.ok) return;
  assert.equal(denied.value.status, "unsupported");
});

test("serializes the scope under the filesystem-policy key", () => {
  const result = resolveProfileRuntimeScope(profile, { repositoryId: "repo" }, pathEvidence());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = serializeProfileRuntimeScope(result.value);
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  const document = JSON.parse(serialized.value) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), [FILESYSTEM_POLICY_SERIALIZATION_KEY]);
});
