import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./errors.js";
import { SessionRegistry } from "../session-registry.js";
import type { SandboxProbe } from "./sandbox.js";
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

test("provision rejects required process tracking before persisting session or pinned runtime", () => {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-profile-pinning-"));
  const unavailableSandbox: SandboxProbe = {
    platform: () => "linux",
    uid: () => 1000,
    gid: () => 1000,
    hasBubblewrap: () => false,
    hasNamespaceSupport: () => false,
    hasCgroupsV2: () => false,
    hasLandlock: () => false,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
  };

  try {
    runGit(["init", "-b", "main"], repositoryPath);
    runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
    runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
    fs.writeFileSync(
      path.join(repositoryPath, "nawabari.profiles.json"),
      JSON.stringify({
        profiles: [{ ...profile, execution: { ...profile.execution, processTracking: "required" }, extends: [] }],
      }),
    );
    runGit(["add", "nawabari.profiles.json"], repositoryPath);
    runGit(["commit", "-m", "profile fixture"], repositoryPath);

    const registry = new SessionRegistry({ cwd: repositoryPath, sandboxProbe: unavailableSandbox });
    assert.throws(
      () =>
        registry.provision({
          branchName: "feature/required-process-tracking",
          profile: { selection: { profile: "standard" } },
        }),
      (error: unknown) => error instanceof DomainError && error.code === "SANDBOX_CAPABILITY_UNAVAILABLE",
    );
    assert.deepEqual(registry.list(), []);
    assert.equal(fs.existsSync(registry.paths.registry), false);
    if (fs.existsSync(registry.paths.registry)) {
      const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
        pinned_profiles?: readonly unknown[];
      };
      assert.equal(persisted.pinned_profiles?.length ?? 0, 0);
    }
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function runGit(args: readonly string[], cwd: string): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}
