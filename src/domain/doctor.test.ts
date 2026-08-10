import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runDoctor } from "./doctor.js";

function temporaryRepository(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "git-paw-doctor-"));
  execFileSync("git", ["init", "--quiet", directory]);
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
    mkdirSync(path.join(directory, ".git", "gitpaw"));
    writeFileSync(path.join(directory, ".git", "gitpaw", "registry.json"), "not-json\n");

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
  const directory = mkdtempSync(path.join(os.tmpdir(), "git-paw-doctor-"));
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
