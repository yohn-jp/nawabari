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
import { RepositoryLock } from "./registry/lock.js";

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
    assert.deepEqual(result.resources, ["file.txt"]);
    assert.deepEqual(
      runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", result.commitSha], fixture.worktree).split(
        "\n",
      ),
      result.resources,
    );
  } finally {
    fixture.cleanup();
  }
});

test("commit reads back the actual committed paths and fails closed when the commit diverges from the authorized set", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "authorized\n");
    let injected = false;
    // Simulate index/staging drift that happens strictly between the last
    // pre-commit observation and the actual `git commit` invocation (e.g. a
    // concurrent process or hook), which pre-commit checks cannot observe.
    const driftGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "commit" && !injected) {
          injected = true;
          fs.writeFileSync(path.join(cwd, "drift.txt"), "unauthorized drift\n");
          runGit(["add", "drift.txt"], cwd);
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: driftGit }).commit({
          sessionId: fixture.session.sessionId,
          message: "drift",
          resources: ["file.txt"],
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "COMMIT_RESULT_DIVERGED" &&
        typeof error.details.commitSha === "string" &&
        Array.isArray(error.details.divergentResources) &&
        (error.details.divergentResources as string[]).includes("drift.txt") &&
        Array.isArray(error.details.committedResources) &&
        (error.details.committedResources as string[]).includes("drift.txt") &&
        Array.isArray(error.details.authorizedResources) &&
        !(error.details.authorizedResources as string[]).includes("drift.txt"),
    );

    // The underlying Git commit already happened; its SHA remains resolvable
    // from the error details for recovery/reconciliation even though the
    // governed result reports the divergence rather than an ordinary success.
    assert.equal(runGit(["show", "--format=%s", "--no-patch", "HEAD"], fixture.worktree), "drift");
    assert.equal(
      runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"], fixture.worktree),
      "drift.txt\nfile.txt",
    );
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

test("commit reconciles a transport failure after Git already committed", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "post-effect\n");
    const expectedHead = runGit(["rev-parse", "HEAD"], fixture.worktree);
    let injected = false;
    const postEffectFailureGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "commit" && !injected) {
          injected = true;
          defaultGit.run(args, cwd);
          throw new SessionRegistryError("GIT_TIMEOUT", "injected post-effect timeout");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    const result = new SessionRegistry({ cwd: fixture.worktree, git: postEffectFailureGit }).commit({
      sessionId: fixture.session.sessionId,
      message: "post-effect",
      resources: ["file.txt"],
    });
    assert.equal(result.reconciliation?.outcome, "proven-committed");
    assert.equal(result.reconciliation?.retrySafe, false);
    assert.equal(result.reconciliation?.expectedHead, expectedHead);
    assert.equal(result.reconciliation?.observedHead, result.commitSha);
    assert.deepEqual(result.reconciliation?.expectedResources, ["file.txt"]);
    assert.deepEqual(result.reconciliation?.observedResources, ["file.txt"]);
    assert.equal(runGit(["rev-parse", "HEAD"], fixture.worktree), result.commitSha);
  } finally {
    fixture.cleanup();
  }
});

test("commit classifies a transport failure without a Git effect as safely retryable", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "pre-effect\n");
    const expectedHead = runGit(["rev-parse", "HEAD"], fixture.worktree);
    let injected = false;
    const preEffectFailureGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "commit" && !injected) {
          injected = true;
          throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "injected pre-effect output limit");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: preEffectFailureGit }).commit({
          sessionId: fixture.session.sessionId,
          message: "pre-effect",
          resources: ["file.txt"],
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "GIT_OUTPUT_LIMIT" &&
        error.details.outcome === "proven-absent" &&
        error.details.retrySafe === true &&
        error.details.expectedHead === expectedHead &&
        error.details.observedHead === expectedHead,
    );

    const retry = new SessionRegistry({ cwd: fixture.worktree, git: preEffectFailureGit }).commit({
      sessionId: fixture.session.sessionId,
      message: "pre-effect retry",
      resources: ["file.txt"],
    });
    assert.equal(retry.reconciliation, undefined);
    assert.notEqual(retry.commitSha, expectedHead);
  } finally {
    fixture.cleanup();
  }
});

test("commit keeps retry safety false when post-effect path reconciliation is unavailable", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "unresolved\n");
    let injected = false;
    const unresolvedGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "commit" && !injected) {
          injected = true;
          defaultGit.run(args, cwd);
          throw new SessionRegistryError("GIT_TIMEOUT", "injected post-effect timeout");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        if (args[0] === "diff-tree") {
          throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "injected reconciliation output limit");
        }
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: unresolvedGit }).commit({
          sessionId: fixture.session.sessionId,
          message: "unresolved",
          resources: ["file.txt"],
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "GIT_TIMEOUT" &&
        error.details.outcome === "unresolved" &&
        error.details.retrySafe === false &&
        typeof error.details.observedHead === "string" &&
        error.details.reconciliationErrorCode === "GIT_OUTPUT_LIMIT",
    );
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

test("commit rejects a caller-declared message pattern that exceeds the bounded length", () => {
  const fixture = createFixture();
  try {
    claim(fixture);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "too long pattern\n");
    const oversizedPattern = `^(${"a".repeat(600)})$`;
    assert.throws(
      () =>
        fixture.current.commit({
          sessionId: fixture.session.sessionId,
          message: "chore: anything",
          resources: ["file.txt"],
          messagePattern: oversizedPattern,
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "INVALID_COMMIT_MESSAGE" &&
        error.details.reason === "message-pattern-too-long",
    );
    assert.equal(runGit(["diff", "--cached", "--name-only"], fixture.worktree), "");
  } finally {
    fixture.cleanup();
  }
});

test("commit validates a caller-declared message pattern before acquiring the repository lock", async () => {
  const fixture = createFixture();
  try {
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "unclaimed\n");
    const registry = new SessionRegistry({ cwd: fixture.worktree, lockTimeoutMs: 0 });
    const externalLock = new RepositoryLock({
      lockPath: registry.paths.lock,
      staleAfterMs: 60_000,
      acquireTimeoutMs: 0,
    });
    // Hold the repository lock externally: with lockTimeoutMs 0, a commit()
    // that still tried to acquire it would fail closed with
    // REGISTRY_LOCK_TIMEOUT instead of reaching message validation, proving
    // the pattern check genuinely runs before the lock is touched.
    const lease = await externalLock.acquire();
    try {
      assert.throws(
        () =>
          registry.commit({
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
    } finally {
      await lease.release();
    }
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
    assert.match(pushed.sourceSha, /^[0-9a-f]{40}$/u);
    assert.equal(pushed.targetRef, `refs/heads/${fixture.session.branchName}`);
    assert.equal(pushed.observedRemoteSha, null);
    assert.equal(pushed.relation, "no-upstream");
    assert.equal(pushed.upstreamCreated, true);
    assert.equal(
      runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], fixture.worktree),
      `origin/${fixture.session.branchName}`,
    );
    const upToDate = fixture.current.push({ ...options, createUpstream: false });
    assert.equal(upToDate.relation, "up-to-date");
    assert.equal(upToDate.sourceSha, pushed.sourceSha);
    assert.equal(upToDate.observedRemoteSha, pushed.sourceSha);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "ahead\n");
    runGit(["add", "file.txt"], fixture.worktree);
    runGit(["commit", "-m", "ahead"], fixture.worktree);
    const ahead = fixture.current.push({ ...options, createUpstream: false });
    assert.equal(ahead.relation, "ahead");
    assert.equal(ahead.observedRemoteSha, pushed.sourceSha);
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

test("push reconciles a transport failure after the exact remote update", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    const initial = fixture.current.push(options);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "post-effect-push\n");
    runGit(["commit", "-am", "post-effect-push"], fixture.worktree);
    const intendedSourceSha = runGit(["rev-parse", "HEAD"], fixture.worktree);
    let injected = false;
    const postEffectFailureGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && !injected) {
          injected = true;
          defaultGit.run(args, cwd);
          throw new SessionRegistryError("GIT_TIMEOUT", "injected post-effect push timeout");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    const result = new SessionRegistry({ cwd: fixture.worktree, git: postEffectFailureGit }).push({
      ...options,
      createUpstream: false,
    });
    assert.equal(result.sourceSha, intendedSourceSha);
    assert.equal(result.observedRemoteSha, initial.sourceSha);
    assert.equal(result.reconciliation?.outcome, "proven-pushed");
    assert.equal(result.reconciliation?.retrySafe, false);
    assert.equal(result.reconciliation?.repositoryId, fixture.registry.repository.repositoryId);
    assert.equal(result.reconciliation?.remote, "origin");
    assert.equal(result.reconciliation?.branch, fixture.session.branchName);
    assert.equal(result.reconciliation?.targetRef, `refs/heads/${fixture.session.branchName}`);
    assert.equal(result.reconciliation?.preconditionSha, initial.sourceSha);
    assert.equal(result.reconciliation?.intendedSourceSha, intendedSourceSha);
    assert.equal(result.reconciliation?.observedRemoteSha, intendedSourceSha);
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      intendedSourceSha,
    );
  } finally {
    fixture.cleanup();
  }
});

test("push classifies a transport failure before the remote update as retry-safe proven absent", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    const initial = fixture.current.push(options);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "pre-effect-push\n");
    runGit(["commit", "-am", "pre-effect-push"], fixture.worktree);
    const intendedSourceSha = runGit(["rev-parse", "HEAD"], fixture.worktree);
    let injected = true;
    const preEffectFailureGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && injected) {
          injected = false;
          throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "injected pre-effect push output limit");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: preEffectFailureGit }).push({
          ...options,
          createUpstream: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "GIT_OUTPUT_LIMIT");
        assert.equal(error.details.outcome, "proven-absent");
        assert.equal(error.details.retrySafe, true);
        assert.equal(error.details.repository, fixture.registry.repository.repositoryId);
        assert.equal(error.details.remote, "origin");
        assert.equal(error.details.branch, fixture.session.branchName);
        assert.equal(error.details.targetRef, `refs/heads/${fixture.session.branchName}`);
        assert.equal(error.details.preconditionSha, initial.sourceSha);
        assert.equal(error.details.intendedSourceSha, intendedSourceSha);
        assert.equal(error.details.observedRemoteSha, initial.sourceSha);
        const reconciliation = error.details.reconciliation;
        assert.ok(reconciliation !== null && typeof reconciliation === "object");
        const reconciliationRecord = reconciliation as {
          readonly outcome?: unknown;
          readonly retrySafe?: unknown;
        };
        assert.equal(reconciliationRecord.outcome, "proven-absent");
        assert.equal(reconciliationRecord.retrySafe, true);
        return true;
      },
    );

    const retry = new SessionRegistry({ cwd: fixture.worktree, git: preEffectFailureGit }).push({
      ...options,
      createUpstream: false,
    });
    assert.equal(retry.reconciliation, undefined);
    assert.equal(retry.sourceSha, intendedSourceSha);
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      intendedSourceSha,
    );
  } finally {
    fixture.cleanup();
  }
});

test("push keeps unresolved remote-generation outcomes non-retry-safe when post-failure observation cannot complete", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    const initial = fixture.current.push(options);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "unresolved-push\n");
    runGit(["commit", "-am", "unresolved-push"], fixture.worktree);
    const intendedSourceSha = runGit(["rev-parse", "HEAD"], fixture.worktree);
    let injected = false;
    const unresolvedGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && !injected) {
          injected = true;
          defaultGit.run(args, cwd);
          throw new SessionRegistryError("GIT_TIMEOUT", "injected unresolved push timeout");
        }
        if (
          injected &&
          args[0] === "ls-remote" &&
          args[1] === "--heads" &&
          args[3] === `refs/heads/${fixture.session.branchName}`
        ) {
          throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "injected reconciliation output limit");
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: unresolvedGit }).push({
          ...options,
          createUpstream: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "GIT_TIMEOUT");
        assert.equal(error.details.outcome, "unresolved");
        assert.equal(error.details.retrySafe, false);
        assert.equal(error.details.repository, fixture.registry.repository.repositoryId);
        assert.equal(error.details.remote, "origin");
        assert.equal(error.details.targetRef, `refs/heads/${fixture.session.branchName}`);
        assert.equal(error.details.preconditionSha, initial.sourceSha);
        assert.equal(error.details.intendedSourceSha, intendedSourceSha);
        assert.equal(error.details.reconciliationErrorCode, "GIT_OUTPUT_LIMIT");
        return true;
      },
    );
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      intendedSourceSha,
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
    const trackingShaBeforeRemoteAdvance = runGit(
      ["rev-parse", `refs/remotes/origin/${fixture.session.branchName}`],
      fixture.worktree,
    );
    runGit(["clone", fixture.remote as string, clone], clone);
    runGit(["config", "user.email", "remote@example.invalid"], clone);
    runGit(["config", "user.name", "Remote"], clone);
    runGit(["checkout", "-b", fixture.session.branchName, `origin/${fixture.session.branchName}`], clone);
    fs.appendFileSync(path.join(clone, "file.txt"), "remote\n");
    runGit(["commit", "-am", "remote"], clone);
    runGit(["push", "origin", `HEAD:refs/heads/${fixture.session.branchName}`], clone);

    const observedCommands: string[][] = [];
    const observingGit: GitCommandRunner = {
      run(args, cwd): string {
        observedCommands.push([...args]);
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        observedCommands.push([...args]);
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };
    const inspected = new SessionRegistry({ cwd: fixture.worktree, git: observingGit });

    assert.throws(
      () => inspected.push({ ...options, createUpstream: false }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_BEHIND",
    );
    const fetchCommand = observedCommands.find((args) => args[0] === "fetch");
    assert.ok(fetchCommand !== undefined);
    assert.ok(fetchCommand.includes("--no-tags"));
    assert.ok(fetchCommand.includes("--no-write-fetch-head"));
    assert.ok(fetchCommand.includes("--refmap="));
    assert.ok(fetchCommand.some((argument) => argument.startsWith(`+refs/heads/${fixture.session.branchName}:`)));
    assert.ok(!fetchCommand.includes("--all"));
    assert.ok(!fetchCommand.includes("--multiple"));
    assert.equal(
      runGit(["rev-parse", `refs/remotes/origin/${fixture.session.branchName}`], fixture.worktree),
      trackingShaBeforeRemoteAdvance,
    );
    assert.equal(
      runGit(["for-each-ref", "--format=%(refname)", "refs/nawabari/push-inspection"], fixture.worktree),
      "",
    );

    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local\n");
    runGit(["commit", "-am", "local"], fixture.worktree);
    assert.throws(
      () => inspected.push({ ...options, createUpstream: false }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PUSH_DIVERGED",
    );
    const forced = inspected.push({ ...options, createUpstream: false, force: true });
    assert.equal(forced.relation, "diverged");
    assert.equal(forced.force, true);
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("push sends the captured source SHA and exact observed remote lease", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
    } as const;
    const initial = fixture.current.push({ ...options, createUpstream: true });
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local\n");
    runGit(["commit", "-am", "local"], fixture.worktree);
    const sourceSha = runGit(["rev-parse", "HEAD"], fixture.worktree);
    const commands: string[][] = [];
    const observingGit: GitCommandRunner = {
      run(args, cwd): string {
        commands.push([...args]);
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        commands.push([...args]);
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    const result = new SessionRegistry({ cwd: fixture.worktree, git: observingGit }).push({
      ...options,
      createUpstream: false,
    });
    const pushCommand = commands.find((args) => args[0] === "push");
    assert.ok(pushCommand !== undefined);
    assert.ok(!pushCommand.some((argument) => argument.includes("HEAD:")));
    assert.ok(pushCommand.includes(`--force-with-lease=refs/heads/${fixture.session.branchName}:${initial.sourceSha}`));
    assert.ok(pushCommand.includes(`${sourceSha}:refs/heads/${fixture.session.branchName}`));
    assert.equal(result.sourceSha, sourceSha);
    assert.equal(result.targetRef, `refs/heads/${fixture.session.branchName}`);
    assert.equal(result.observedRemoteSha, initial.sourceSha);
  } finally {
    fixture.cleanup();
  }
});

test("new remote refs use an empty exact-generation lease when unchanged", () => {
  const fixture = createFixture(true);
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    const commands: string[][] = [];
    const observingGit: GitCommandRunner = {
      run(args, cwd): string {
        commands.push([...args]);
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        commands.push([...args]);
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    const result = new SessionRegistry({ cwd: fixture.worktree, git: observingGit }).push(options);
    const pushCommand = commands.find((args) => args[0] === "push");
    assert.ok(pushCommand !== undefined);
    assert.ok(pushCommand.includes(`--force-with-lease=refs/heads/${fixture.session.branchName}:`));
    assert.equal(result.observedRemoteSha, null);
    assert.equal(result.upstreamCreated, true);
  } finally {
    fixture.cleanup();
  }
});

test("push rejects a remote race after inspection with the exact lease", () => {
  const fixture = createFixture(true);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-race-"));
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
    } as const;
    const initial = fixture.current.push({ ...options, createUpstream: true });
    runGit(["clone", "--branch", fixture.session.branchName, fixture.remote as string, clone], clone);
    runGit(["config", "user.email", "race@example.invalid"], clone);
    runGit(["config", "user.name", "Race"], clone);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local\n");
    runGit(["commit", "-am", "local"], fixture.worktree);
    fs.appendFileSync(path.join(clone, "file.txt"), "remote-race\n");
    runGit(["commit", "-am", "remote race"], clone);

    let raced = false;
    const raceGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && !raced) {
          raced = true;
          runGit(["push", "origin", `HEAD:refs/heads/${fixture.session.branchName}`], clone);
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: raceGit }).push({
          ...options,
          force: true,
          createUpstream: false,
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "PUSH_FAILED" &&
        typeof error.details.command === "string" &&
        error.details.command.includes(
          `--force-with-lease=refs/heads/${fixture.session.branchName}:${initial.sourceSha}`,
        ),
    );
    assert.equal(raced, true);
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      runGit(["rev-parse", "HEAD"], clone),
    );
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("ordinary push rejects a remote advance even when the new tip is an ancestor of the source", () => {
  const fixture = createFixture(true);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-ordinary-race-"));
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
    } as const;
    const initial = fixture.current.push({ ...options, createUpstream: true });
    runGit(["clone", "--branch", fixture.session.branchName, fixture.remote as string, clone], clone);
    runGit(["config", "user.email", "race@example.invalid"], clone);
    runGit(["config", "user.name", "Race"], clone);
    fs.appendFileSync(path.join(clone, "file.txt"), "remote-advance\n");
    runGit(["commit", "-am", "remote advance"], clone);
    const remoteAdvanceSha = runGit(["rev-parse", "HEAD"], clone);

    // Put the same remote advance into the local source before inspection.
    // The remote itself remains at initial.sourceSha until the race hook runs,
    // making remoteAdvanceSha an ancestor of the intended local source.
    runGit(["fetch", clone, `HEAD:refs/nawabari/push-test/${remoteAdvanceSha}`], fixture.worktree);
    runGit(["merge", "--ff-only", `refs/nawabari/push-test/${remoteAdvanceSha}`], fixture.worktree);
    fs.appendFileSync(path.join(fixture.worktree, "file.txt"), "local-source\n");
    runGit(["commit", "-am", "local source"], fixture.worktree);

    let raced = false;
    const raceGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && !raced) {
          raced = true;
          runGit(["push", "origin", `HEAD:refs/heads/${fixture.session.branchName}`], clone);
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () =>
        new SessionRegistry({ cwd: fixture.worktree, git: raceGit }).push({
          ...options,
          createUpstream: false,
        }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "PUSH_FAILED" &&
        typeof error.details.command === "string" &&
        error.details.command.includes(
          `--force-with-lease=refs/heads/${fixture.session.branchName}:${initial.sourceSha}`,
        ),
    );
    assert.equal(raced, true);
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      remoteAdvanceSha,
    );
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("new remote refs use an empty lease and reject creation races", () => {
  const fixture = createFixture(true);
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-mutation-new-ref-race-"));
  try {
    claim(fixture);
    const options = {
      sessionId: fixture.session.sessionId,
      resources: ["file.txt"],
      remote: "origin",
      branch: fixture.session.branchName,
      createUpstream: true,
    } as const;
    runGit(["clone", fixture.remote as string, clone], clone);
    runGit(["config", "user.email", "race@example.invalid"], clone);
    runGit(["config", "user.name", "Race"], clone);
    runGit(["checkout", "-b", fixture.session.branchName, "origin/main"], clone);
    fs.appendFileSync(path.join(clone, "file.txt"), "remote-creation\n");
    runGit(["commit", "-am", "remote creation"], clone);
    const remoteCreationSha = runGit(["rev-parse", "HEAD"], clone);

    let raced = false;
    const raceGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "push" && !raced) {
          raced = true;
          runGit(["push", "origin", `HEAD:refs/heads/${fixture.session.branchName}`], clone);
        }
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () => new SessionRegistry({ cwd: fixture.worktree, git: raceGit }).push(options),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "PUSH_FAILED" &&
        typeof error.details.command === "string" &&
        error.details.command.includes(`--force-with-lease=refs/heads/${fixture.session.branchName}:`),
    );
    assert.equal(raced, true);
    assert.equal(
      runGit(["rev-parse", `refs/heads/${fixture.session.branchName}`], fixture.remote as string),
      remoteCreationSha,
    );
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
