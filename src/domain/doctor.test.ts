import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runDoctor } from "./doctor.js";
import type { SandboxProbe } from "./sandbox.js";

function sandboxProbe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
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
    ...overrides,
  };
}

function temporaryRepository(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nawabari-doctor-"));
  execFileSync("git", ["init", "--quiet", directory], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return directory;
}

test("doctor resolves Git and repository state locally without a registry", async () => {
  const directory = temporaryRepository();
  try {
    const result = await runDoctor(directory);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.ok, true);
    assert.equal(result.value.repository?.top_level, path.resolve(directory));
    assert.equal(result.value.checks.find((check) => check.name === "git")?.status, "ok");
    assert.equal(result.value.checks.find((check) => check.name === "repository")?.status, "ok");
    assert.equal(result.value.checks.find((check) => check.name === "registry")?.status, "not_configured");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor rejects malformed local registry state", async () => {
  const directory = temporaryRepository();
  try {
    mkdirSync(path.join(directory, ".git", "nawabari"));
    writeFileSync(path.join(directory, ".git", "nawabari", "session-registry.json"), "not-json\n");

    const result = await runDoctor(directory);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.ok, false);
    const registryCheck = result.value.checks.find((check) => check.name === "registry");
    assert.equal(registryCheck?.status, "error");
    assert.equal(registryCheck?.code, "REGISTRY_CORRUPT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor reports a non-repository directory without contacting external services", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nawabari-doctor-"));
  try {
    const result = await runDoctor(directory);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.ok, false);
    assert.equal(result.value.repository, null);
    assert.equal(result.value.checks.find((check) => check.name === "repository")?.code, "NOT_GIT_REPOSITORY");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("doctor exposes canonical protected-execution readiness from the injected sandbox probe", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nawabari-doctor-"));
  try {
    const result = await runDoctor(directory, sandboxProbe({ hasBubblewrap: () => false }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.sandbox.contract_id, "nawabari.sandbox-execution.v1");
    assert.equal(result.value.sandbox.schema_version, 1);
    assert.equal(result.value.sandbox.platform_supported, true);
    assert.equal(result.value.sandbox.ready, false);
    assert.deepEqual(result.value.sandbox.missing_required, ["bubblewrap"]);
    const runtime = result.value.checks.find((check) => check.name === "runtime");
    const runtimeSandbox = runtime?.details.sandbox;
    assert.ok(runtimeSandbox && typeof runtimeSandbox === "object" && !Array.isArray(runtimeSandbox));
    assert.equal((runtimeSandbox as { ready?: boolean }).ready, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
