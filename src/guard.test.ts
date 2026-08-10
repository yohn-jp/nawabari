import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "./cli.js";
import { SessionRegistry, toPersistedSessionRecord } from "./session-registry.js";

test("guard allows the owning active worktree and is side-effect free", () => {
  const fixture = createRepository();
  const worktreePath = `${fixture}-guard-owned`;
  try {
    const registry = new SessionRegistry({ cwd: fixture });
    const session = registry.provision({ worktreePath, branchName: "feature/guard-owned" });
    const before = fs.readFileSync(registry.paths.registry, "utf8");

    const decision = new SessionRegistry({ cwd: worktreePath }).guard();

    assert.equal(decision.allowed, true);
    assert.equal(decision.code, "ALLOWED");
    assert.equal(decision.sessionId, session.sessionId);
    assert.equal(decision.ownerSessionId, session.sessionId);
    assert.equal(decision.branchName, "feature/guard-owned");
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), before);
    assert.equal(fs.existsSync(registry.paths.lock), false);
  } finally {
    removeWorktree(fixture, worktreePath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("guard denies cross-session claims and the protected integration worktree", async () => {
  const fixture = createRepository();
  const firstWorktree = `${fixture}-guard-first`;
  const secondWorktree = `${fixture}-guard-second`;
  try {
    const registry = new SessionRegistry({ cwd: fixture });
    const first = registry.provision({ worktreePath: firstWorktree, branchName: "feature/guard-first" });
    const second = registry.provision({ worktreePath: secondWorktree, branchName: "feature/guard-second" });

    const output: string[] = [];
    const deniedExit = await runCli(["guard", "--session", second.sessionId, "--json"], {
      cwd: firstWorktree,
      io: { stdout: (line) => output.push(line), stderr: () => undefined },
    });

    assert.equal(deniedExit, 3);
    assert.deepEqual(JSON.parse(output[0]), {
      ok: false,
      command: "guard",
      code: "WORKTREE_OWNED_BY_OTHER_SESSION",
      message: "Guard denied the current worktree: WORKTREE_OWNED_BY_OTHER_SESSION.",
      allowed: false,
      details: {
        allowed: false,
        repository: fs.realpathSync.native(path.join(fixture, ".git")),
        worktree: fs.realpathSync.native(firstWorktree),
        branch: "feature/guard-first",
        session_id: first.sessionId,
        owner_session_id: first.sessionId,
        requested_session_id: second.sessionId,
        state: "active",
        details: {
          worktree: fs.realpathSync.native(firstWorktree),
          sessionId: second.sessionId,
          ownerSessionId: first.sessionId,
        },
      },
    });

    const protectedDecision = new SessionRegistry({ cwd: fixture }).guard();
    assert.equal(protectedDecision.allowed, false);
    assert.equal(protectedDecision.code, "PROTECTED_WORKTREE");
  } finally {
    removeWorktree(fixture, firstWorktree);
    removeWorktree(fixture, secondWorktree);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("guard fails closed for detached and corrupt ownership state", () => {
  const fixture = createRepository();
  const worktreePath = `${fixture}-guard-invalid`;
  try {
    const registry = new SessionRegistry({ cwd: fixture });
    registry.provision({ worktreePath, branchName: "feature/guard-invalid" });

    runGit(["checkout", "--detach"], worktreePath);
    const detached = new SessionRegistry({ cwd: worktreePath }).guard();
    assert.equal(detached.allowed, false);
    assert.equal(detached.code, "WORKTREE_IDENTITY_AMBIGUOUS");

    runGit(["checkout", "feature/guard-invalid"], worktreePath);
    fs.writeFileSync(registry.paths.registry, "{not-json\n", "utf8");
    const corrupt = new SessionRegistry({ cwd: worktreePath }).guard();
    assert.equal(corrupt.allowed, false);
    assert.equal(corrupt.code, "REGISTRY_CORRUPT");
  } finally {
    removeWorktree(fixture, worktreePath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("guard fails closed for ambiguous persisted ownership and maps it through the CLI", async () => {
  const fixture = createRepository();
  const worktreePath = `${fixture}-guard-ambiguous`;
  try {
    const registry = new SessionRegistry({ cwd: fixture });
    const session = registry.provision({ worktreePath, branchName: "feature/guard-ambiguous" });
    const persisted = toPersistedSessionRecord(session);
    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify(
        {
          schema_version: 1,
          repository_id: registry.repository.repositoryId,
          sessions: [persisted, { ...persisted, session_id: "01936f5e-7b00-7abc-8def-0123456789ab" }],
        },
        null,
        2,
      )}\n`,
    );

    const decision = new SessionRegistry({ cwd: worktreePath }).guard();
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "DUPLICATE_WORKTREE_OWNERSHIP");

    const output: string[] = [];
    const exitCode = await runCli(["guard", "--json"], {
      cwd: worktreePath,
      io: { stdout: (line) => output.push(line), stderr: () => undefined },
    });
    assert.equal(exitCode, 3);
    const response = JSON.parse(output[0]) as { code: string; allowed: boolean };
    assert.equal(response.code, "WORKTREE_OWNED_BY_OTHER_SESSION");
    assert.equal(response.allowed, false);
  } finally {
    removeWorktree(fixture, worktreePath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-paw-guard-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "git-paw-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "GitPaw Tests"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
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
    // The directory cleanup below is sufficient when the worktree was not created.
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
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}
