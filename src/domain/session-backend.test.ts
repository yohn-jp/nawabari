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

test("status exposes the resolved managed root and bounded history selection", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-status-root`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/status-root", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const status = await backend.status({ cwd: repositoryPath });
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.value.managed_worktree_root, path.dirname(fs.realpathSync.native(repositoryPath)));
    assert.equal(status.value.history_included, false);
    assert.equal(
      status.value.sessions.some((session) => session.session_id === created.value.session_id),
      true,
    );

    const closed = await backend.closeSession({ cwd: repositoryPath }, { session_id: created.value.session_id });
    assert.equal(closed.ok, true);
    const bounded = await backend.status({ cwd: repositoryPath });
    assert.equal(bounded.ok, true);
    if (!bounded.ok) return;
    assert.equal(
      bounded.value.sessions.some((session) => session.session_id === created.value.session_id),
      false,
    );
    const history = await backend.status({ cwd: repositoryPath }, { include_closed: true });
    assert.equal(history.ok, true);
    if (!history.ok) return;
    assert.equal(history.value.history_included, true);
    assert.equal(
      history.value.sessions.find((session) => session.session_id === created.value.session_id)?.state,
      "closed",
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resource claims expose canonical machine fields through the backend and CLI", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-claim-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/claim-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const claimed = await backend.claimResources(
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        repository: created.value.repository,
        claims: [{ resource: "README.md", mode: "read" }],
      },
    );
    assert.equal(claimed.ok, true, claimed.ok ? "claim succeeded" : JSON.stringify(claimed.error));
    if (!claimed.ok) return;
    assert.equal(claimed.value.claims.length, 1);
    assert.equal(claimed.value.claims[0]?.schema_version, 2);
    assert.match(claimed.value.claims[0]?.claim_id ?? "", /^claim-[0-9a-f]{64}$/u);
    assert.equal(claimed.value.claims[0]?.resource, "README.md");
    assert.equal(claimed.value.claims[0]?.mode, "read");

    const stdout: string[] = [];
    const exitCode = await runCli(["session", "claims", "--session", created.value.session_id, "--json"], {
      cwd: worktreePath,
      io: { stdout: (line) => stdout.push(line), stderr: () => undefined },
    });
    assert.equal(exitCode, 0);
    const listed = JSON.parse(stdout[0] ?? "") as {
      ok: boolean;
      command: string;
      claims: Array<{ resource: string; mode: string }>;
    };
    assert.equal(listed.ok, true);
    assert.equal(listed.command, "session claims");
    assert.deepEqual(
      listed.claims.map((claim) => [claim.resource, claim.mode]),
      [["README.md", "read"]],
    );

    const released = await backend.releaseClaims(
      { cwd: worktreePath },
      { session_id: created.value.session_id, claim_ids: null },
    );
    assert.equal(released.ok, true);
    if (!released.ok) return;
    assert.equal(released.value.released.length, 1);
    assert.equal(released.value.remaining.length, 0);
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

test("the CLI gc path recovers a prunable worktree before branch reuse", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-cli-prunable`;
  const branchName = "feature/cli-prunable";
  try {
    const created = await runJsonCli<{
      ok: boolean;
      command: string;
      session_id: string;
      state: string;
    }>(repositoryPath, ["session", "create", "--branch", branchName, "--worktree", worktreePath]);
    assert.equal(created.ok, true);
    assert.equal(created.command, "session create");
    assert.equal(created.state, "active");

    fs.rmSync(worktreePath, { recursive: true, force: true });
    const worktreeList = runGit(["worktree", "list", "--porcelain"], repositoryPath).split(/\r?\n/u);
    assert.equal(worktreeList.includes(`worktree ${worktreePath}`), true);
    assert.equal(
      worktreeList.some((line) => line.startsWith("prunable ")),
      true,
    );

    const dryRun = await runJsonCli<{
      ok: boolean;
      command: string;
      apply: boolean;
      candidates: Array<{ session_id: string }>;
      cleaned: unknown[];
      blocked: unknown[];
    }>(repositoryPath, ["gc", "--dry-run"]);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.command, "gc");
    assert.equal(dryRun.apply, false);
    assert.deepEqual(
      dryRun.candidates.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.deepEqual(dryRun.cleaned, []);
    assert.deepEqual(dryRun.blocked, []);

    const applied = await runJsonCli<{
      ok: boolean;
      command: string;
      apply: boolean;
      candidates: Array<{ session_id: string; state: string }>;
      cleaned: Array<{ session_id: string; state: string }>;
      blocked: unknown[];
    }>(repositoryPath, ["gc", "--apply"]);
    assert.equal(applied.ok, true);
    assert.equal(applied.command, "gc");
    assert.equal(applied.apply, true);
    assert.deepEqual(
      applied.candidates.map((candidate) => candidate.session_id),
      [created.session_id],
    );
    assert.equal(applied.cleaned.length, 1);
    assert.equal(applied.cleaned[0]?.session_id, created.session_id);
    assert.equal(applied.cleaned[0]?.state, "closed");
    assert.deepEqual(applied.blocked, []);

    const listed = await runJsonCli<{
      sessions: Array<{ session_id: string; state: string }>;
    }>(repositoryPath, ["session", "list", "--all"]);
    assert.equal(listed.sessions.find((session) => session.session_id === created.session_id)?.state, "closed");

    const reused = await runJsonCli<{
      ok: boolean;
      session_id: string;
      branch: string;
      state: string;
    }>(repositoryPath, ["session", "create", "--branch", branchName, "--worktree", worktreePath]);
    assert.equal(reused.ok, true);
    assert.notEqual(reused.session_id, created.session_id);
    assert.equal(reused.branch, branchName);
    assert.equal(reused.state, "active");
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
      { branch: "main", worktree: repositoryPath, label: null, base: null },
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

test("the local backend exposes close and gc as stable automation results", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-lifecycle-contract`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/lifecycle-contract", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const closed = await backend.closeSession({ cwd: worktreePath }, { session_id: null });
    assert.equal(closed.ok, true, closed.ok ? "close succeeded" : JSON.stringify(closed.error));
    if (!closed.ok) return;
    assert.equal(closed.value.session.session_id, created.value.session_id);
    assert.equal(closed.value.session.state, "closed");
    assert.equal(closed.value.worktree_removed, true);
    assert.equal(closed.value.branch_removed, true);

    const output: string[] = [];
    const exitCode = await runCli(["gc", "--dry-run", "--json"], {
      cwd: repositoryPath,
      io: { stdout: (line) => output.push(line), stderr: () => undefined },
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(output[0]), {
      ok: true,
      command: "gc",
      apply: false,
      candidates: [],
      cleaned: [],
      blocked: [],
    });
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-domain-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
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

async function runJsonCli<T>(cwd: string, args: readonly string[]): Promise<T> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([...args, "--json"], {
    cwd,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  });
  assert.equal(exitCode, 0, stderr.join("\n"));
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0]) as T;
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
