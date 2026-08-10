import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../cli.js";
import { LocalSessionBackend } from "./session-backend.js";

test("local session backend provisions through the domain contract", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-domain-session`;
  try {
    const backend = new LocalSessionBackend();
    const result = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/domain", worktree: worktreePath, label: "domain", base: null },
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.branch, "feature/domain");
    assert.equal(result.value.worktree, fs.realpathSync.native(worktreePath));
    assert.equal(result.value.label, "domain");
    assert.equal(result.value.state, "active");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the CLI create command uses the local backend and emits stable JSON", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-cli-session`;
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture v2\n");
    runGit(["add", "README.md"], repositoryPath);
    runGit(["commit", "-m", "second"], repositoryPath);
    const baseRef = runGit(["rev-parse", "HEAD"], repositoryPath);
    const exitCode = await runCli(
      ["session", "create", "--branch", "feature/cli", "--worktree", worktreePath, "--base", baseRef, "--json"],
      {
        cwd: repositoryPath,
        io: {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      },
    );

    assert.equal(exitCode, 0);
    assert.equal(stderr.length, 0);
    assert.equal(stdout.length, 1);
    const response = JSON.parse(stdout[0]) as {
      ok: boolean;
      command: string;
      session_id: string;
      branch: string;
      worktree: string;
    };
    assert.equal(response.ok, true);
    assert.equal(response.command, "session create");
    assert.match(response.session_id, /^[0-9a-f-]{36}$/u);
    assert.equal(response.branch, "feature/cli");
    assert.equal(response.worktree, fs.realpathSync.native(worktreePath));
    assert.equal(runGit(["rev-parse", "HEAD"], worktreePath), baseRef);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("the local backend preserves unexpected error diagnostics", async () => {
  const repositoryPath = createRepository();
  const expectedError = new TypeError("injected backend failure");
  try {
    const backend = new LocalSessionBackend({
      registry: {
        idGenerator: () => {
          throw expectedError;
        },
      },
    });
    const result = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/unexpected", worktree: `${repositoryPath}-unexpected`, label: null, base: null },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "INTERNAL_ERROR");
    assert.equal(result.error.details?.cause, "TypeError: injected backend failure");
    assert.equal(result.error.cause, expectedError);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-paw-domain-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "git-paw-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "GitPaw Tests"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
  runGit(["config", "tag.gpgsign", "false"], repositoryPath);
  runGit(["config", "core.hooksPath", "/dev/null"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The directory cleanup below is sufficient when Git never created it.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }),
  ).trim();
}
