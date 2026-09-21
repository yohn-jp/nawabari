import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { machineContract } from "./contract.js";
import { LocalSessionBackend } from "./domain/session-backend.js";
import type { SandboxProbe } from "./domain/sandbox.js";
import { SessionRegistry } from "./session-registry.js";
import {
  applyWorktreeProfileOverrides,
  type WorktreeProfileOverrideAuthorization,
} from "./domain/worktree-profile-overrides.js";
import { projectDeclaredToolMaterial, validateDeclaredToolMaterial } from "./domain/runtime-provider-declared.js";
import { inspectWorktreeProfile, serializeWorktreeProfileInspection } from "./public-state.js";
import {
  builtinWorktreeProfileRevision,
  parsePinnedProfileRecord,
  pinWorktreeProfile,
} from "./domain/worktree-profile-pinning.js";
import { resolveWorktreeProfileCliRequest } from "./worktree-profile-cli.js";
import type { ResolvedWorktreeRuntimeProfile } from "./domain/worktree-runtime-profile.js";

function profile(): ResolvedWorktreeRuntimeProfile {
  const resolved = resolveWorktreeProfileCliRequest({ command: "profile show", profile: "builtin:minimal" });
  assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));
  if (!resolved.ok || resolved.value.command !== "profile show") throw new Error("builtin profile did not resolve");
  return resolved.value.profile;
}

function authorization(): WorktreeProfileOverrideAuthorization {
  return {};
}

function fileEvidence(source: string): { source: string; digest: string; identity: { dev: string; ino: string } } {
  const stat = fs.statSync(source, { bigint: true });
  return {
    source,
    digest: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
    identity: { dev: stat.dev.toString(10), ino: stat.ino.toString(10) },
  };
}

test("central contract and public-state expose the accepted profile producers", () => {
  const lifecycle = (machineContract("integration-test").capabilities as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === "session-lifecycle",
  );
  assert.ok(lifecycle);
  const worktreeProfile = lifecycle.worktree_profile as Record<string, unknown>;
  assert.equal(worktreeProfile.contract_id, "nawabari.worktree-runtime-profile.v1");
  assert.deepEqual(worktreeProfile.commands, ["session create", "profile list", "profile show"]);
  assert.equal((worktreeProfile.cli as Record<string, unknown>).contract_id, "nawabari.worktree-profile-cli.v1");
  assert.equal(
    (worktreeProfile.runtime as Record<string, unknown>).contract_id,
    "nawabari.worktree-profile-runtime.v1",
  );
  assert.equal((worktreeProfile.inspection as Record<string, unknown>).projection, "public-state");
  assert.equal((worktreeProfile.filesystem as Record<string, unknown>).contract_id, "nawabari.filesystem-policy.v1");
  assert.equal(
    (worktreeProfile.declared_tool_material as Record<string, unknown>).contract_id,
    "nawabari.declared-tool-material.v1",
  );
  assert.deepEqual((worktreeProfile.pinning as Record<string, unknown>).catalog_sources, ["repository", "builtin"]);
  assert.equal(
    ((worktreeProfile.runtime as Record<string, unknown>).declared_material as Record<string, unknown>).input,
    "declared_materials",
  );

  const resolved = profile();
  const pinned = pinWorktreeProfile(resolved, {
    repository: { id: "repo", revision: "0123456789abcdef0123456789abcdef01234567" },
    base: { revision: "0123456789abcdef0123456789abcdef01234567" },
    catalog: { path: "nawabari.profiles.json", blob_oid: "abcdef0123456789abcdef0123456789abcdef01" },
    selection: { profile: "builtin:minimal", parameters: {} },
  });
  const inspection = inspectWorktreeProfile(
    pinned,
    { status: "unknown" },
    {
      status: "available",
      materializer: "fhs",
      providers: resolved.tools.map((tool) => tool.provider),
    },
  );
  assert.equal(inspection.pinned.profile.id, "minimal");
  assert.equal(inspection.current.drift, "unknown");
  assert.deepEqual(
    inspection.runtime.tools.filter((tool) => tool.availability === "available").map((tool) => tool.entrypoint),
    ["git", "ls", "node"],
  );
  const serialized = serializeWorktreeProfileInspection(inspection);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), ["worktree-profile-inspection"]);
});

test("built-in pinning and inspection use the canonical non-Git source revision", () => {
  const resolved = profile();
  const revision = builtinWorktreeProfileRevision("minimal");
  const pinned = pinWorktreeProfile(resolved, {
    repository: { id: "repo", revision: "0123456789abcdef0123456789abcdef01234567" },
    base: { revision: "0123456789abcdef0123456789abcdef01234567" },
    catalog: { kind: "builtin", id: "minimal", revision },
    selection: { profile: "minimal", parameters: {} },
  });
  const inspection = inspectWorktreeProfile(
    pinned,
    { status: "unknown" },
    { status: "available", materializer: "provided", providers: resolved.tools.map((tool) => tool.provider) },
  );
  assert.deepEqual(inspection.declared.catalog, { kind: "builtin", id: "minimal", revision });
  assert.equal(inspection.current.drift, "same");
  assert.equal(inspection.current.catalog.status, "available");
  assert.equal("blob_oid" in pinned.provenance.catalog, false);
});

test("accepted override and declared-material producers compose without ambient fallback", () => {
  const base = profile();
  const overridden = applyWorktreeProfileOverrides(
    pinWorktreeProfile(base, {
      repository: { id: "repo", revision: "0123456789abcdef0123456789abcdef01234567" },
      base: { revision: "0123456789abcdef0123456789abcdef01234567" },
      catalog: { path: "nawabari.profiles.json", blob_oid: "abcdef0123456789abcdef0123456789abcdef01" },
      selection: { profile: "builtin:minimal", parameters: {} },
    }),
    { removeTools: ["ls"] },
    authorization(),
  );
  assert.equal(overridden.ok, true, overridden.ok ? "" : JSON.stringify(overridden.error));
  if (!overridden.ok) return;
  assert.deepEqual(
    overridden.value.resolved.tools.map((tool) => tool.entrypoint),
    ["git", "node"],
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-profile-integration-"));
  try {
    const executable = path.join(root, "tool");
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const executableEvidence = fileEvidence(executable);
    const requirement = { id: "declared-tool", kind: "package" as const, name: "tool", version: "1" };
    const material = {
      id: "declared-tool-material",
      requirement_id: requirement.id,
      version: requirement.version,
      entrypoint: "tool",
      executable: executableEvidence,
      source_closure: [executableEvidence],
    };
    const validated = validateDeclaredToolMaterial(material, requirement);
    assert.equal(validated.ok, true, validated.ok ? "" : JSON.stringify(validated.error));
    const projected = projectDeclaredToolMaterial(material, { material_id: material.id }, requirement);
    assert.equal(projected.ok, true, projected.ok ? "" : JSON.stringify(projected.error));
    if (projected.ok) {
      assert.equal(projected.value.executable.name, "tool");
      assert.equal(projected.value.executable.target, executable);
      assert.deepEqual(
        projected.value.filesystem.map((entry) => entry.source),
        [executable],
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the real backend pins a built-in profile with canonical non-Git provenance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-builtin-profile-session-"));
  const worktree = path.join(root, "worktree");
  try {
    git(root, ["init", "-b", "main"]);
    git(root, ["config", "user.name", "Nawabari Integration"]);
    git(root, ["config", "user.email", "nawabari-integration@example.invalid"]);
    fs.writeFileSync(path.join(root, "README.md"), "integration\n");
    git(root, ["add", "README.md"]);
    git(root, ["commit", "-m", "integration fixture"]);

    const backend = new LocalSessionBackend({ sandboxProbe: readySandboxProbe() });
    const created = await backend.createSession(
      { cwd: root },
      {
        branch: "feature/builtin-profile",
        worktree,
        label: null,
        base: null,
        profile: { selection: { profile: "builtin:minimal" }, parameters: {} },
      },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));

    const registryPath = new SessionRegistry({ cwd: root }).paths.registry;
    const registry = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
      pinned_profiles?: readonly unknown[];
    };
    assert.equal(registry.pinned_profiles?.length, 1);
    const pinned = parsePinnedProfileRecord(registry.pinned_profiles?.[0]);
    assert.deepEqual(pinned.provenance.catalog, {
      kind: "builtin",
      id: "minimal",
      revision: builtinWorktreeProfileRevision("minimal"),
    });
    assert.equal("blob_oid" in pinned.provenance.catalog, false);
  } finally {
    if (fs.existsSync(worktree)) git(root, ["worktree", "remove", "--force", worktree]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function readySandboxProbe(): SandboxProbe {
  return {
    platform: () => "linux",
    uid: () => 1_000,
    gid: () => 1_000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => false,
    hasLandlock: () => false,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
  };
}

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}
