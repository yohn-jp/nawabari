import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultControlRepositoryCatalogPath,
  listControlRepositories,
  openRepositoryLocator,
  readRepositoryLocators,
  registerRepositoryLocator,
  repositoryKey,
} from "./control-repositories.js";
import { REGISTRY_DIRECTORY_NAME, REGISTRY_FILE_NAME } from "./session-registry.js";

function temporaryRoot(t: test.TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-control-repositories-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repository(root: string, name: string, managed: boolean): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  execFileSync("git", ["init", "--quiet", "-b", "main", directory]);
  if (managed) {
    const registry = path.join(directory, ".git", REGISTRY_DIRECTORY_NAME);
    fs.mkdirSync(registry);
    fs.writeFileSync(path.join(registry, REGISTRY_FILE_NAME), "{}\n");
  }
  return directory;
}

test("default catalog path is machine-local XDG state and ignores relative overrides", () => {
  assert.equal(
    defaultControlRepositoryCatalogPath({ XDG_STATE_HOME: "/state" }),
    "/state/nawabari/control-repositories.json",
  );
  assert.equal(
    defaultControlRepositoryCatalogPath({ XDG_STATE_HOME: "relative" }),
    path.join(os.homedir(), ".local", "state", "nawabari", "control-repositories.json"),
  );
});

test("catalog records only identity/path locators for Nawabari-managed repositories", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "state", "control-repositories.json");
  const unmanaged = repository(root, "plain", false);
  const managed = repository(root, "managed", true);
  fs.mkdirSync(path.join(managed, "nested"));

  assert.deepEqual(registerRepositoryLocator(catalog, unmanaged), { ok: true, value: null });
  assert.equal(fs.existsSync(catalog), false);
  assert.deepEqual(registerRepositoryLocator(catalog, path.join(root, "missing")), { ok: true, value: null });

  const registered = registerRepositoryLocator(catalog, path.join(managed, "nested"));
  assert.deepEqual(registered, {
    ok: true,
    value: { repository_id: path.join(managed, ".git"), worktree_path: managed },
  });
  assert.deepEqual(registerRepositoryLocator(catalog, managed), registered);

  const document = JSON.parse(fs.readFileSync(catalog, "utf8")) as { repositories: Record<string, unknown>[] };
  assert.equal(document.repositories.length, 1);
  assert.deepEqual(Object.keys(document.repositories[0] ?? {}).sort(), ["repository_id", "worktree_path"]);
  assert.equal(fs.statSync(catalog).mode & 0o777, 0o600);
});

test("listing re-resolves every locator and reports drift as unavailable", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "control-repositories.json");
  const first = repository(root, "first", true);
  const second = repository(root, "second", true);
  assert.equal(registerRepositoryLocator(catalog, first).ok, true);
  assert.equal(registerRepositoryLocator(catalog, second).ok, true);

  const listed = listControlRepositories(catalog);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(
    listed.value.map((entry) => [entry.repository_key, entry.available]),
    [
      [repositoryKey(path.join(first, ".git")), true],
      [repositoryKey(path.join(second, ".git")), true],
    ],
  );

  fs.rmSync(path.join(second, ".git", REGISTRY_DIRECTORY_NAME), { recursive: true });
  const after = listControlRepositories(catalog);
  assert.equal(after.ok && after.value[1]?.available, false);
  const reopened = openRepositoryLocator({ repository_id: path.join(second, ".git"), worktree_path: second });
  assert.equal(reopened.ok, false);
  const forged = openRepositoryLocator({ repository_id: path.join(second, ".git"), worktree_path: first });
  assert.equal(forged.ok, false, "a locator whose path resolves to another repository is not reopened");
});

test("malformed or oversized catalog content fails closed", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "control-repositories.json");
  assert.deepEqual(readRepositoryLocators(catalog), { ok: true, value: [] });
  for (const content of [
    "not json",
    JSON.stringify({ schema_version: 2, repositories: [] }),
    JSON.stringify({ schema_version: 1, repositories: [{ repository_id: "relative", worktree_path: "/x" }] }),
    JSON.stringify({
      schema_version: 1,
      repositories: [{ repository_id: "/x/.git", worktree_path: "/x", sessions: [] }],
    }),
    "x".repeat(300 * 1024),
  ]) {
    fs.writeFileSync(catalog, content);
    const result = readRepositoryLocators(catalog);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_REGISTRY");
  }
});
