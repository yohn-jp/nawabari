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
  const worktreePath = path.join(path.dirname(repositoryPath), "git-paw-domain-session");
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
  const worktreePath = path.join(path.dirname(repositoryPath), "git-paw-cli-session");
  const stdout: string[] = [];
  const stderr: string[] = [];
  try {
    const exitCode = await runCli(
      ["session", "create", "--branch", "feature/cli", "--worktree", worktreePath, "--json"],
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
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-paw-domain-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "git-paw-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "GitPaw Tests"], repositoryPath);
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
  return String(execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}
