import assert from "node:assert/strict";
import test from "node:test";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import { parsePinnedProfileRecord, pinWorktreeProfile } from "./worktree-profile-pinning.js";

const profile = {
  contract_id: "nawabari.worktree-runtime-profile.v1",
  schema_version: 1,
  id: "standard",
  version: "1",
  materialSelection: { profiles: ["base", "dev"] },
  filesystem: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [".git/**"], immutable: [".git/**"] },
  tools: [{ entrypoint: "node", provider: { id: "node", requirement_id: "node" } }],
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
  selection: { profile: "standard", parameters: { "shell.entrypoint": "node" } },
} as const;

test("pin preserves resolved content and parses a valid digest", () => {
  const pinned = pinWorktreeProfile(profile, provenance);
  assert.equal(parsePinnedProfileRecord(pinned).digest, pinned.digest);
  assert.deepEqual(pinned.resolved.materialSelection.profiles, ["base", "dev"]);
});

test("pin parser rejects tampered content and provenance", () => {
  const pinned = pinWorktreeProfile(profile, provenance);
  assert.throws(() => parsePinnedProfileRecord({ ...pinned, resolved: { ...pinned.resolved, id: "tampered" } }));
  assert.throws(() =>
    parsePinnedProfileRecord({ ...pinned, provenance: { ...pinned.provenance, base: { revision: "bad" } } }),
  );
});
