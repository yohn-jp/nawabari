import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { defaultGit, type GitCommandRunner, resolveRepositoryContext } from "./git.js";
import { SessionRegistry } from "./session-registry.js";

test("provision creates one dedicated worktree and one mutable branch", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-one");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/provisioned-one",
      label: "worker",
    });

    assert.equal(session.state, "active");
    assert.equal(session.worktreePath, fs.realpathSync.native(worktreePath));
    assert.equal(session.branchName, "feature/provisioned-one");
    assert.equal(session.branchId, "refs/heads/feature/provisioned-one");
    assert.notEqual(session.sessionId, session.branchName);
    assert.equal(runGit(["symbolic-ref", "--short", "HEAD"], worktreePath), "feature/provisioned-one");
    assert.equal(new SessionRegistry({ cwd: worktreePath }).resolveCurrentSession().sessionId, session.sessionId);
    assert.equal(registry.list().length, 1);

    assertRegistryError(
      () => new SessionRegistry({ cwd: fixture.repositoryPath }).resolveCurrentSession(),
      "SESSION_NOT_FOUND",
    );
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("invalid base refs expose bounded recovery metadata", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-invalid-base");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assert.throws(
      () => registry.provision({ worktreePath, branchName: "feature/invalid-base", baseRef: "missing-base-ref" }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "INVALID_BASE_REF");
        assert.deepEqual(error.details, {
          baseRef: "missing-base-ref",
          reason: "does-not-resolve-to-commit",
          defaultBaseRef: "HEAD",
          recoveryHints: ["Omit --base to use HEAD, then retry session create."],
        });
        return true;
      },
    );
    assert.equal(fs.existsSync(worktreePath), false);
    assert.deepEqual(registry.list(), []);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("provision rejects protected, invalid, and already-owned resources deterministically", () => {
  const fixture = createRepositoryFixture();
  const firstPath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-conflict");
  const externalPath = path.join(path.dirname(fixture.repositoryPath), "nawabari-external-conflict");
  const existingBranchPath = path.join(path.dirname(fixture.repositoryPath), "nawabari-existing-branch");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.provision({ worktreePath: firstPath, branchName: "feature/conflict" });

    assertRegistryError(
      () =>
        registry.provision({
          worktreePath: path.join(path.dirname(firstPath), "nawabari-other"),
          branchName: first.branchName,
        }),
      "DUPLICATE_BRANCH_OWNERSHIP",
    );
    assertRegistryError(
      () => registry.provision({ worktreePath: firstPath, branchName: "feature/other" }),
      "DUPLICATE_WORKTREE_OWNERSHIP",
    );
    assertRegistryError(
      () => registry.provision({ worktreePath: fixture.repositoryPath, branchName: "feature/default-path" }),
      "PROTECTED_WORKTREE",
    );
    assertRegistryError(
      () =>
        registry.provision({
          worktreePath: path.join(path.dirname(firstPath), "nawabari-protected-branch"),
          branchName: "main",
        }),
      "PROTECTED_BRANCH",
    );
    assertRegistryError(
      () =>
        registry.provision({
          worktreePath: path.join(path.dirname(firstPath), "nawabari-invalid"),
          branchName: "bad name",
        }),
      "INVALID_BRANCH_ID",
    );

    fs.mkdirSync(externalPath);
    assertRegistryError(
      () => registry.provision({ worktreePath: externalPath, branchName: "feature/external-path" }),
      "WORKTREE_ALREADY_EXISTS",
    );
    runGit(["branch", "feature/external-branch"], fixture.repositoryPath);
    assertRegistryError(
      () => registry.provision({ worktreePath: existingBranchPath, branchName: "feature/external-branch" }),
      "BRANCH_ALREADY_EXISTS",
    );

    runGit(["branch", "feature/ref-namespace"], fixture.repositoryPath);
    assertRegistryError(
      () =>
        registry.provision({
          worktreePath: path.join(path.dirname(firstPath), "nawabari-ref-namespace"),
          branchName: "feature/ref-namespace/child",
        }),
      "BRANCH_ALREADY_EXISTS",
    );
  } finally {
    removeWorktree(fixture.repositoryPath, firstPath);
    removeWorktree(fixture.repositoryPath, existingBranchPath);
    runGitQuiet(["branch", "-D", "feature/external-branch"], fixture.repositoryPath);
    runGitQuiet(["branch", "-D", "feature/ref-namespace"], fixture.repositoryPath);
    fs.rmSync(externalPath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("provision rejects a dangling worktree path symlink before invoking Git", () => {
  const fixture = createRepositoryFixture();
  const danglingPath = `${fixture.repositoryPath}-dangling-worktree`;
  try {
    fs.symlinkSync(`${danglingPath}-missing`, danglingPath, "dir");
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assertRegistryError(
      () => registry.provision({ worktreePath: danglingPath, branchName: "feature/dangling-path" }),
      "INVALID_WORKTREE_PATH",
    );
  } finally {
    fs.unlinkSync(danglingPath);
    fixture.cleanup();
  }
});

test("provision rejects a symlink to an existing directory before resolving its target", () => {
  const fixture = createRepositoryFixture();
  const symlinkPath = `${fixture.repositoryPath}-symlink-worktree`;
  try {
    fs.symlinkSync(fixture.repositoryPath, symlinkPath, "dir");
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assertRegistryError(
      () => registry.provision({ worktreePath: symlinkPath, branchName: "feature/symlink-path" }),
      "INVALID_WORKTREE_PATH",
    );
  } finally {
    fs.unlinkSync(symlinkPath);
    fixture.cleanup();
  }
});

test("provision rejects managed-root traversal and intermediate symlink escapes", () => {
  const fixture = createRepositoryFixture();
  const managedRoot = path.join(fixture.repositoryPath, "managed-worktrees");
  const outsideRoot = path.join(path.dirname(fixture.repositoryPath), "nawabari-managed-outside");
  try {
    fs.mkdirSync(managedRoot);
    fs.mkdirSync(outsideRoot);
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath, worktreeRoot: managedRoot });

    assertRegistryError(
      () =>
        registry.provision({ worktreePath: path.join(managedRoot, "..", "escaped"), branchName: "feature/escaped" }),
      "INVALID_WORKTREE_PATH",
    );

    const redirect = path.join(managedRoot, "redirect");
    fs.symlinkSync(outsideRoot, redirect, "dir");
    assertRegistryError(
      () => registry.provision({ worktreePath: path.join(redirect, "nested"), branchName: "feature/redirect" }),
      "INVALID_WORKTREE_PATH",
    );

    const rootLink = `${managedRoot}-link`;
    fs.symlinkSync(outsideRoot, rootLink, "dir");
    assertRegistryError(
      () => new SessionRegistry({ cwd: fixture.repositoryPath, worktreeRoot: rootLink }),
      "INVALID_WORKTREE_PATH",
    );
    fs.unlinkSync(rootLink);
  } finally {
    fs.rmSync(outsideRoot, { recursive: true, force: true });
    fs.rmSync(managedRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("a Git provisioning failure leaves no active registry ownership or worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-failure");
  const branchName = "feature/injected-failure";
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    runGit(["branch", branchName], fixture.repositoryPath);
    const failingGit: GitCommandRunner = {
      run(args, cwd): string {
        if (args[0] === "show-ref" && args[1] === "--verify") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected missing branch", { cwd });
        }
        if (args[0] === "worktree" && args[1] === "add") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected worktree failure", {
            command: args.join(" "),
            cwd,
          });
        }
        return defaultGit.run(args, cwd);
      },
    };
    const registry = new SessionRegistry({ repository, git: failingGit });

    assertRegistryError(() => registry.provision({ worktreePath, branchName }), "GIT_COMMAND_FAILED");
    assert.equal(fs.existsSync(worktreePath), false);
    assert.deepEqual(registry.list(), []);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      true,
    );
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("simultaneous provisioning serializes ownership and creates distinct worktrees", { timeout: 30_000 }, async () => {
  const fixture = createRepositoryFixture();
  const worktreePaths = Array.from({ length: 4 }, (_, index) =>
    path.join(path.dirname(fixture.repositoryPath), `nawabari-provisioned-concurrent-${index}`),
  );
  try {
    const workerModule = new URL("./session-registry.ts", import.meta.url).href;
    const results = await Promise.all(
      worktreePaths.map((worktreePath, index) =>
        runProvisionWorker(workerModule, fixture.repositoryPath, worktreePath, `feature/concurrent-${index}`),
      ),
    );
    assert.equal(new Set(results).size, worktreePaths.length);
    const records = new SessionRegistry({ cwd: fixture.repositoryPath }).list();
    assert.equal(records.length, worktreePaths.length);
    assert.equal(new Set(records.map((record) => record.worktreePath)).size, records.length);
    assert.equal(new Set(records.map((record) => record.branchName)).size, records.length);
    for (const worktreePath of worktreePaths) {
      assert.equal(fs.existsSync(worktreePath), true);
    }
  } finally {
    for (const worktreePath of worktreePaths) removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-provisioning-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return {
    repositoryPath,
    cleanup(): void {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  runGitQuiet(["worktree", "remove", "--force", worktreePath], repositoryPath);
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runProvisionWorker(
  workerModule: string,
  repositoryPath: string,
  worktreePath: string,
  branchName: string,
): Promise<string> {
  const script = `
    import { SessionRegistry } from ${JSON.stringify(workerModule)};
    const session = new SessionRegistry({ cwd: process.env.NAWABARI_REPOSITORY }).provision({
      worktreePath: process.env.NAWABARI_WORKTREE,
      branchName: process.env.NAWABARI_BRANCH,
    });
    process.stdout.write(session.sessionId);
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], {
      cwd: path.dirname(fileURLToPath(import.meta.url)),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        NAWABARI_REPOSITORY: repositoryPath,
        NAWABARI_WORKTREE: worktreePath,
        NAWABARI_BRANCH: branchName,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolve(stdout.trim());
      else reject(new Error(`provision worker exited with ${exitCode}: ${stderr}`));
    });
  });
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

function runGitQuiet(args: readonly string[], cwd: string): boolean {
  try {
    runGit(args, cwd);
    return true;
  } catch {
    return false;
  }
}
