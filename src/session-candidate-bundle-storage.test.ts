import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GIT_SOURCE_MAX_DEPTH, GIT_SOURCE_MAX_PATHS } from "./git.js";
import {
  inspectSessionCandidateBundleScratch,
  removeSessionCandidateBundleScratch,
  sessionCandidateBundleRepositoryPath,
  sessionCandidateBundleStagingRootPath,
  type SessionCandidateBundleStorageIdentity,
} from "./session-candidate-bundle-storage.js";

function git(cwd: string, ...args: string[]): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).trim();
}

function candidateFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-candidate-release-")));
  const worktree = path.join(root, "worktree");
  fs.mkdirSync(worktree, { mode: 0o700 });
  const identityBase = {
    candidate_digest: `sha256:${"a".repeat(64)}`,
    project_id: "project-1",
    source_id: "source-1",
    bundle_sha256: `sha256:${"b".repeat(64)}`,
  };
  const stagingRoot = sessionCandidateBundleStagingRootPath(
    worktree,
    identityBase.candidate_digest,
    identityBase.project_id,
    identityBase.source_id,
  );
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  const repositoryPath = sessionCandidateBundleRepositoryPath(
    worktree,
    identityBase.candidate_digest,
    identityBase.project_id,
    identityBase.source_id,
  );
  fs.mkdirSync(repositoryPath, { mode: 0o700 });
  git(repositoryPath, "init", "--quiet", "-b", "main");
  git(repositoryPath, "config", "user.name", "Candidate Release Test");
  git(repositoryPath, "config", "user.email", "candidate-release@example.invalid");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "base\n");
  git(repositoryPath, "add", "README.md");
  git(repositoryPath, "commit", "--quiet", "-m", "base");
  const baseCommit = git(repositoryPath, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "candidate\n");
  git(repositoryPath, "commit", "--quiet", "-am", "candidate");
  const candidateCommit = git(repositoryPath, "rev-parse", "HEAD");
  const candidateTree = git(repositoryPath, "rev-parse", "HEAD^{tree}");
  const candidateHex = identityBase.candidate_digest.slice("sha256:".length);
  const derivedSourceKey = createHash("sha256")
    .update(`${identityBase.project_id}\0${identityBase.source_id}`)
    .digest("hex")
    .slice(0, 24);
  const expectedBranch = `nawabari-candidate-${candidateHex}-${derivedSourceKey}`;
  git(repositoryPath, "update-ref", `refs/nawabari/bases/${candidateHex}`, baseCommit);
  git(repositoryPath, "update-ref", `refs/nawabari/candidates/${candidateHex}/${derivedSourceKey}`, candidateCommit);
  git(repositoryPath, "checkout", "--quiet", "-B", expectedBranch, candidateCommit);
  git(repositoryPath, "update-ref", "-d", "refs/heads/main");
  const identity: SessionCandidateBundleStorageIdentity = {
    ...identityBase,
    base_commit: baseCommit,
    candidate_commit: candidateCommit,
    candidate_tree: candidateTree,
  };
  return { root, worktree, stagingRoot, repositoryPath, identity, candidateCommit, candidateTree };
}

test("candidate scratch release removes only an exact clean owner repository", (t) => {
  const fixture = candidateFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const inspected = inspectSessionCandidateBundleScratch(fixture.worktree, fixture.identity);
  assert.equal(inspected.staging_root, fixture.stagingRoot);
  assert.equal(inspected.repository_path, fixture.repositoryPath);
  assert.equal(inspected.head_id, fixture.candidateCommit);
  assert.equal(inspected.tree_id, fixture.candidateTree);

  const removed = removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity);
  assert.deepEqual(removed, inspected);
  assert.throws(() => fs.lstatSync(fixture.stagingRoot), { code: "ENOENT" });
  assert.ok(fs.existsSync(fixture.worktree));
});

test("candidate scratch release preserves dirty, nested, and unexpected recoverable data", (t) => {
  const fixture = candidateFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(fixture.repositoryPath, "untracked.txt"), "recoverable\n");
  assert.throws(() => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity), /dirty or recoverable/u);
  assert.equal(fs.readFileSync(path.join(fixture.repositoryPath, "untracked.txt"), "utf8"), "recoverable\n");
  fs.rmSync(path.join(fixture.repositoryPath, "untracked.txt"));

  fs.mkdirSync(path.join(fixture.repositoryPath, "nested", ".git"), { recursive: true, mode: 0o700 });
  assert.throws(
    () => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity),
    /nested Git repository/u,
  );
  assert.ok(fs.existsSync(path.join(fixture.repositoryPath, "nested", ".git")));
  fs.rmSync(path.join(fixture.repositoryPath, "nested"), { recursive: true });

  const transfer = path.join(fixture.stagingRoot, `.candidate-${fixture.identity.bundle_sha256.slice(7)}.bundle`);
  fs.writeFileSync(transfer, "recoverable transfer");
  fs.chmodSync(transfer, 0o600);
  assert.throws(
    () => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity),
    /unexpected or recoverable/u,
  );
  assert.equal(fs.readFileSync(transfer, "utf8"), "recoverable transfer");
});

test("candidate scratch release rejects a symlinked owner source root without following it", (t) => {
  const fixture = candidateFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const held = `${fixture.stagingRoot}.held`;
  fs.renameSync(fixture.stagingRoot, held);
  fs.symlinkSync(held, fixture.stagingRoot, "dir");

  assert.throws(() => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity), /owner-private/u);
  assert.equal(fs.existsSync(path.join(held, "repo", "README.md")), true);
  assert.equal(fs.lstatSync(fixture.stagingRoot).isSymbolicLink(), true);
});

test("candidate scratch release ignores ambient Git redirection and preserves dirty source data", (t) => {
  const fixture = candidateFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const keys = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG_KEY_1",
    "GIT_CONFIG_VALUE_1",
  ] as const;
  const original = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.GIT_DIR = path.join(fixture.root, "redirected.git");
  process.env.GIT_WORK_TREE = path.join(fixture.root, "redirected-worktree");
  process.env.GIT_OBJECT_DIRECTORY = path.join(fixture.root, "redirected-objects");
  process.env.GIT_CONFIG_COUNT = "2";
  process.env.GIT_CONFIG_KEY_0 = "core.bare";
  process.env.GIT_CONFIG_VALUE_0 = "true";
  process.env.GIT_CONFIG_KEY_1 = "core.worktree";
  process.env.GIT_CONFIG_VALUE_1 = path.join(fixture.root, "redirected-worktree");
  try {
    assert.equal(
      inspectSessionCandidateBundleScratch(fixture.worktree, fixture.identity).head_id,
      fixture.candidateCommit,
    );
    const dirty = path.join(fixture.repositoryPath, "recoverable.txt");
    fs.writeFileSync(dirty, "preserve me\n");
    assert.throws(
      () => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity),
      /dirty or recoverable/u,
    );
    assert.equal(fs.readFileSync(dirty, "utf8"), "preserve me\n");
    fs.rmSync(dirty);
    assert.equal(
      removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity).head_id,
      fixture.candidateCommit,
    );
  } finally {
    for (const key of keys) {
      const value = original.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("candidate scratch release fails closed at the established source path and depth bounds", (t) => {
  const tooDeep = candidateFixture();
  t.after(() => fs.rmSync(tooDeep.root, { recursive: true, force: true }));
  let nested = tooDeep.repositoryPath;
  for (let depth = 0; depth <= GIT_SOURCE_MAX_DEPTH; depth += 1) {
    nested = path.join(nested, "d");
    fs.mkdirSync(nested);
  }
  assert.throws(() => inspectSessionCandidateBundleScratch(tooDeep.worktree, tooDeep.identity), /depth bound/u);
  assert.ok(fs.existsSync(nested));

  const tooMany = candidateFixture();
  t.after(() => fs.rmSync(tooMany.root, { recursive: true, force: true }));
  for (let index = 0; index < GIT_SOURCE_MAX_PATHS; index += 1) {
    fs.writeFileSync(path.join(tooMany.repositoryPath, `source-${index}`), "x");
  }
  assert.throws(() => inspectSessionCandidateBundleScratch(tooMany.worktree, tooMany.identity), /path bound/u);
  assert.equal(fs.existsSync(path.join(tooMany.repositoryPath, `source-${GIT_SOURCE_MAX_PATHS - 1}`)), true);
});
