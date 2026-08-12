import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { defaultGit, type GitCommandRunner } from "./git.js";
import { runCli } from "./cli.js";
import { SessionRegistry } from "./session-registry.js";
import { SessionRegistryError } from "./errors.js";

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly remote?: string;
  readonly session: ReturnType<SessionRegistry["provision"]>;
  readonly registry: SessionRegistry;
  readonly current: SessionRegistry;
  cleanup(): void;
}

function createFixture(withRemote = false): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-"));
  const worktree = `${root}-worktree`;
  let remote: string | undefined;
  runGit(["init", "-b", "main", root], root);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], root);
  runGit(["config", "user.name", "Nawabari Tests"], root);
  runGit(["config", "commit.gpgsign", "false"], root);
  runGit(["config", "core.hooksPath", "/dev/null"], root);
  fs.writeFileSync(path.join(root, "file.txt"), "initial\n");
  runGit(["add", "file.txt"], root);
  runGit(["commit", "-m", "initial"], root);
  if (withRemote) {
    remote = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-remote-"));
    runGit(["init", "--bare", remote], remote);
    runGit(["remote", "add", "origin", remote], root);
    runGit(["push", "origin", "main:main"], root);
  }
  const registry = new SessionRegistry({ cwd: root });
  const session = registry.provision({ worktreePath: worktree, branchName: "feature/mutation" });
  return {
    root,
    worktree,
    remote,
    session,
    registry,
    current: new SessionRegistry({ cwd: worktree }),
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", worktree], root);
      } catch {
        // Directory cleanup remains safe when Git already removed the worktree.
      }
      fs.rmSync(worktree, { recursive: true, force: true });
      if (remote !== undefined) fs.rmSync(remote, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function claim(fixture: Fixture, resource = "file.txt"): void {
  fixture.registry.claimResources({
    sessionId: fixture.session.sessionId,
    claims: [{ resource, mode: "exclusive-write" }],
  });
}

test("commit denies missing claims and does not mutate the worktree", () => {
  const fixture = createFixture();
  try {
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "denied\n");
    const before = runGit(["rev-parse", "HEAD"], fixture.worktree);
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "denied",
          resources: ["file.txt"],
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "MISSING_RESOURCE_CLAIM",
    );
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), before);
    assert.equal(runGit(["diff", "--cached", "--name-only"], fixture.worktree), "");
  } finally {
    fixture.cleanup();
  }
});

test("commit rejects unexpected changed or staged paths and returns its SHA", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "committed\n");
    fs.writeFileSync(path.join(fixture.worktree, "unexpected.txt"), "must not be included\n");
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "unexpected",
          resources: ["file.txt"],
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "UNEXPECTED_CHANGED_PATHS" &&
        Array.isArray(error.details.paths) &&
        error.details.paths.includes("unexpected.txt"),
    );
    assert.equal(runGit(["diff", "--cached", "--name-only"], fixture.worktree), "");
    fs.rmSync(path.join(fixture.worktree, "unexpected.txt"));

    fs.writeFileSync(path.join(fixture.worktree, "staged-unexpected.txt"), "must not be committed\n");
    runGit(["add", "staged-unexpected.txt"], fixture.worktree);
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "staged unexpected",
          resources: ["file.txt"],
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "UNEXPECTED_CHANGED_PATHS" &&
        Array.isArray(error.details.paths) &&
        error.details.paths.includes("staged-unexpected.txt"),
    );
    runGit(["reset", "--", "staged-unexpected.txt"], fixture.worktree);
    fs.rmSync(path.join(fixture.worktree, "staged-unexpected.txt"));

    const result = fixture.current.commit({
      sessionId: fixture.session.sessionId,
      message: "committed",
      resources: ["file.txt"],
    });
    assert.equal(result.message, "committed");
    assert.match(result.commitSha, /^[0-9a-f]{40}$/u);
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), result.commitSha);
    assert.equal(runGit(["show", "--format=%s", "--no-patch", "HEAD"], fixture.worktree), "committed");
  } finally {
    fixture.cleanup();
  }
});

test("CLI commit preserves the JSON mutation result contract", async () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "cli\n");
    const stdout: string[] = [];
    const exitCode = await runCli(
      ["commit", "--session", fixture.session.sessionId, "--message", "cli commit", "--resource", "file.txt", "--json"],
      { cwd: fixture.worktree, io: { stdout: (line) => stdout.push(line), stderr: () => undefined } },
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout[0] ?? "") as {
      ok: boolean;
      command: string;
      commit_sha: string;
    };
    assert.equal(result.ok, true);
    assert.equal(result.command, "commit");
    assert.match(result.commit_sha, /^[0-9a-f]{40}$/u);
  } finally {
    fixture.cleanup();
  }
});

test("CLI commit rejects a message that fails the caller-declared pattern and does not mutate", async () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "cli pattern\n");
    const before = runGit(["rev-parse", "HEAD"], fixture.worktree);
    const stdout: string[] = [];
    const exitCode = await runCli(
      [
        "commit",
        "--session",
        fixture.session.sessionId,
        "--message",
        "not conventional",
        "--resource",
        "file.txt",
        "--message-pattern",
        "^(feat|fix|docs|refactor|test|chore): .+$",
        "--json",
      ],
      { cwd: fixture.worktree, io: { stdout: (line) => stdout.push(line), stderr: () => undefined } },
    );
    assert.notEqual(exitCode, 0);
    const result = JSON.parse(stdout[0] ?? "") as { ok: boolean; code: string };
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_COMMIT_MESSAGE");
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), before);
  } finally {
    fixture.cleanup();
  }
});

test("commit reports partial staging and commit failures and can be retried", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "retry\n");
    let failStage = true;
    const stageFailGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "add" && failStage) {
          failStage = false;
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected staging failure", { exitCode: 7 });
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    const stageFailure = new SessionRegistry({ cwd: fixture.worktree, git: stageFailGit });
    assert.throws(
      () => stageFailure.commit({ sessionId: fixture.session.sessionId, message: "retry", resources: ["file.txt"] }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "COMMIT_STAGING_FAILED",
    );

    let failCommit = true;
    const commitFailGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "commit" && failCommit) {
          failCommit = false;
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected commit failure", { exitCode: 9 });
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    const commitFailure = new SessionRegistry({ cwd: fixture.worktree, git: commitFailGit });
    assert.throws(
      () => commitFailure.commit({ sessionId: fixture.session.sessionId, message: "retry", resources: ["file.txt"] }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "COMMIT_FAILED",
    );
    const retried = commitFailure.commit({
      sessionId: fixture.session.sessionId,
      message: "retry",
      resources: ["file.txt"],
    });
    assert.match(retried.commitSha, /^[0-9a-f]{40}$/u);
  } finally {
    fixture.cleanup();
  }
});

test("commit aborts when HEAD changes between verification and staging", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "stale\n");
    let injected = false;
    const git: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "add" && !injected) {
          injected = true;
          runGit(["commit", "--allow-empty", "-m", "external"], cwd);
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git }).commit({
          sessionId: fixture.session.sessionId,
          message: "stale",
          resources: ["file.txt"],
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_STATE_AMBIGUOUS",
    );
  } finally {
    fixture.cleanup();
  }
});

test("commit rejects a branch changed outside the owned physical context", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "wrong branch\n");
    runGit(["checkout", "-b", "feature/not-owned"], fixture.worktree);
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "wrong branch",
          resources: ["file.txt"],
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "BRANCH_MISMATCH",
    );
  } finally {
    fixture.cleanup();
  }
});

test("commit validates a caller-declared message pattern only when supplied", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "pattern\n");
    const before = runGit(["rev-parse", "HEAD"], fixture.worktree);
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "not conventional",
          resources: ["file.txt"],
          messagePattern: "^(feat|fix|docs|refactor|test|chore): .+$",
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "INVALID_COMMIT_MESSAGE" &&
        error.details.reason === "message-pattern-mismatch",
    );
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), before);
    assert.equal(runGit(["diff", "--cached", "--name-only"], fixture.worktree), "");

    const result = fixture.current.commit({
      sessionId: fixture.session.sessionId,
      message: "chore: record the pattern change",
      resources: ["file.txt"],
      messagePattern: "^(feat|fix|docs|refactor|test|chore): .+$",
    });
    assert.match(result.commitSha, /^[0-9a-f]{40}$/u);
  } finally {
    fixture.cleanup();
  }
});

test("commit rejects a caller-declared message pattern that is not a valid regular expression", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "invalid pattern\n");
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "chore: anything",
          resources: ["file.txt"],
          messagePattern: "(unterminated",
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "INVALID_COMMIT_MESSAGE" &&
        error.details.reason === "invalid-message-pattern",
    );
    assert.equal(runGit(["diff", "--cached", "--name-only"], fixture.worktree), "");
  } finally {
    fixture.cleanup();
  }
});

test("push distinguishes missing upstream, creates it explicitly, and reports the target", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
    } as const;
    assert.throws(
      () => fixture.current.push(options),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_NO_UPSTREAM",
    );
    const pushed = fixture.current.push({ ...options, createUpstream: true });
    assert.equal(pushed.target, `origin/${fixture.session.branchName}`);
    assert.equal(pushed.relation, "no-upstream");
    assert.equal(pushed.upstreamCreated, true);
    assert.equal(
      runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], fixture.worktree),
      `origin/${fixture.session.branchName}`,
    );
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "ahead\n");
    runGit(["add", "file.txt"], fixture.worktree);
    runGit(["commit", "-m", "ahead"], fixture.worktree);
    const ahead = fixture.current.push({ ...options, createUpstream: false });
    assert.equal(ahead.relation, "ahead");
  } finally {
    fixture.cleanup();
  }
});

test("push rejects explicit branch different from session branch", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    assert.throws(
      () =>
        fixture.current.push({
          sessionId: fixture.session.sessionId,
          resources: ["file.txt"],
          remote: "origin",
          branch: "different-branch",
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_TARGET_MISMATCH",
    );
  } finally {
    fixture.cleanup();
  }
});

test("CLI push preserves the explicit target in JSON", async () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const branch = fixture.session.branchName;
    fixture.current.push({
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch,
      createUpstream: true,
    });
    const stdout: string[] = [];
    const exitCode = await runCli(
      [
        "push",
        "--session",
        fixture.session.sessionId,
        "--resource",
        "file.txt",
        "--remote",
        "origin",
        "--branch",
        branch,
        "--json",
      ],
      { cwd: fixture.worktree, io: { stdout: (line) => stdout.push(line), stderr: () => undefined } },
    );
    assert.equal(exitCode, 0);
    const result = JSON.parse(stdout[0] ?? "") as { ok: boolean; command: string; target: string };
    assert.equal(result.ok, true);
    assert.equal(result.command, "push");
    assert.equal(result.target, `origin/${branch}`);
  } finally {
    fixture.cleanup();
  }
});

test("push reports remote inspection failure and preserves bounded timeout codes", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const failingInspectionGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "ls-remote") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "inspection failed", { exitCode: 11 });
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: failingInspectionGit }).push({
          sessionId: fixture.session.sessionId,
          resources: ["file.txt"],
          remote: "origin",
          branch: fixture.session.branchName,
          createUpstream: true,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_REMOTE_INSPECTION_FAILED",
    );

    const timeoutGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "ls-remote") return defaultGit.run(args, cwd);
        if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return defaultGit.run(args, cwd);
        if (args[0] === "rev-list") return "1 0";
        if (args[0] === "push") throw new SessionRegistryError("GIT_TIMEOUT", "injected timeout");
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    // Establish a real upstream so the timeout is reached after inspection.
    fixture.current.push({
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    });
    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: timeoutGit }).push({
          sessionId: fixture.session.sessionId,
          resources: ["file.txt"],
          remote: "origin",
          branch: fixture.session.branchName,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_TIMEOUT",
    );

    const outputLimitGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push") throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "injected output limit");
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: outputLimitGit }).push({
          sessionId: fixture.session.sessionId,
          resources: ["file.txt"],
          remote: "origin",
          branch: fixture.session.branchName,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_OUTPUT_LIMIT",
    );
  } finally {
    fixture.cleanup();
  }
});

test("push distinguishes behind and diverged histories and requires explicit force", () => {
  const fixture = createFixture(true);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-clone-"));
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    fixture.current.push(options);
    runGit(["clone", fixture.remote as string, clone], clone);
    runGit(["config", "user.email", "remote@example.invalid"], clone);
    runGit(["config", "user.name", "Remote"], clone);
    runGit(["checkout", "-b", fixture.session.branchName, `origin/${fixture.session.branchName}`], clone);
    fs.appendFileSync(path.join(clone, "file.txt"), "remote\n");
    runGit(["commit", "-am", "remote"], clone);
    runGit(["push", "origin", `HEAD:refs/heads/${fixture.session.branchName}`], clone);
    runGit(["fetch", "origin"], fixture.worktree);

    assert.throws(
      () => fixture.current.push({ ...options, createUpstream: false }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_BEHIND",
    );

    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local\n");
    runGit(["commit", "-am", "local"], fixture.worktree);
    assert.throws(
      () => fixture.current.push({ ...options, createUpstream: false }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_DIVERGED",
    );
    const forced = fixture.current.push({ ...options, createUpstream: false, force: true });
    assert.equal(forced.relation, "diverged");
    assert.equal(forced.force, true);
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fixture.cleanup();
  }
});

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", ["-c", "protocol.file.allow=always", ...args], {
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
