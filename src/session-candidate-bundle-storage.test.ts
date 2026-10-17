import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

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
  assert.throws(() => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity), /nested Git repository/u);
  assert.ok(fs.existsSync(path.join(fixture.repositoryPath, "nested", ".git")));
  fs.rmSync(path.join(fixture.repositoryPath, "nested"), { recursive: true });

  const transfer = path.join(fixture.stagingRoot, `.candidate-${fixture.identity.bundle_sha256.slice(7)}.bundle`);
  fs.writeFileSync(transfer, "recoverable transfer");
  fs.chmodSync(transfer, 0o600);
  assert.throws(() => removeSessionCandidateBundleScratch(fixture.worktree, fixture.identity), /unexpected or recoverable/u);
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
