import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import {
  canonicalizeGitObservedPaths,
  createGitCommandRunner,
  defaultGit,
  listGitWorktrees,
  normalizeBranchId,
  observeGitCheckpoint,
  observeGitMutationPaths,
  readBoundedGitDiff,
  readCanonicalCommitChangedPaths,
  resolveRepositoryContext,
  resolveWorktreeIdentity,
  verifyPhysicalExecutionContext,
} from "./git.js";

test("resolves the same repository identity from linked worktrees", () => {
  const fixture = createRepositoryFixture();
  try {
    const main = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const linked = resolveRepositoryContext({ cwd: fixture.linkedWorktreePath });

    assert.equal(main.repositoryId, linked.repositoryId);
    assert.equal(main.commonGitDirectory, linked.commonGitDirectory);
    assert.notEqual(main.worktreePath, linked.worktreePath);

    const identity = resolveWorktreeIdentity({ cwd: fixture.linkedWorktreePath });
    assert.equal(identity.worktreePath, linked.worktreePath);
    assert.equal(identity.worktreeId, linked.worktreePath);
    assert.equal(identity.branchName, "feature/linked");
    assert.equal(identity.branchId, "refs/heads/feature/linked");
  } finally {
    fixture.cleanup();
  }
});

test("rejects a detached worktree as an ambiguous branch identity", () => {
  const fixture = createRepositoryFixture();
  const detachedPath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-detached`,
  );
  try {
    runGit(["worktree", "add", "--detach", detachedPath, "HEAD"], fixture.repositoryPath);

    assert.throws(
      () => resolveWorktreeIdentity({ cwd: detachedPath }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "WORKTREE_IDENTITY_AMBIGUOUS",
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", detachedPath], fixture.repositoryPath);
    } catch {
      // Cleanup below is sufficient if the temporary worktree was already removed.
    }
    fs.rmSync(detachedPath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("verifies repository, worktree, branch, and HEAD from physical Git state", () => {
  const fixture = createRepositoryFixture();
  const other = createRepositoryFixture();
  const detachedPath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-verify-detached`,
  );
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const verified = verifyPhysicalExecutionContext({ cwd: fixture.linkedWorktreePath });
    assert.equal(verified.repositoryId, repository.repositoryId);
    assert.equal(verified.worktreePath, fs.realpathSync.native(fixture.linkedWorktreePath));
    assert.equal(verified.branchName, "feature/linked");
    assert.equal(verified.headId, runGit(["rev-parse", "HEAD"], fixture.linkedWorktreePath));

    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: other.repositoryPath, repository }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REPOSITORY_MISMATCH",
    );
    assert.throws(
      () =>
        verifyPhysicalExecutionContext({
          cwd: fixture.linkedWorktreePath,
          expectedWorktreePath: fixture.repositoryPath,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "WORKTREE_MISMATCH",
    );
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: fixture.linkedWorktreePath, branchName: "main" }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "BRANCH_MISMATCH",
    );

    runGit(["worktree", "add", "--detach", detachedPath, "HEAD"], fixture.repositoryPath);
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: detachedPath }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "DETACHED_HEAD",
    );
    assert.throws(
      () => verifyPhysicalExecutionContext({ repository, worktreePath: `${fixture.repositoryPath}-missing` }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "MISSING_WORKTREE",
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", detachedPath], fixture.repositoryPath);
    } catch {
      // Cleanup below is sufficient if the temporary worktree was already removed.
    }
    fs.rmSync(detachedPath, { recursive: true, force: true });
    fixture.cleanup();
    other.cleanup();
  }
});

test("keeps bounded Git subprocess failures distinct", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-process-"));
  try {
    assert.throws(
      () => createGitCommandRunner({ executable: path.join(directory, "missing-git") }).run([], directory),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_SPAWN_FAILED",
    );
    assert.throws(
      () =>
        createGitCommandRunner({ executable: process.execPath, timeoutMs: 250 }).run(
          ["-e", "setTimeout(() => {}, 2_000)"],
          directory,
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_TIMEOUT",
    );
    assert.throws(
      () =>
        createGitCommandRunner({ executable: process.execPath, maxOutputBytes: 16 }).run(
          ["-e", "process.stdout.write('x'.repeat(10_000))"],
          directory,
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_OUTPUT_LIMIT",
    );
    assert.throws(
      () => createGitCommandRunner({ executable: process.execPath }).run(["-e", "process.exit(7)"], directory),
      (error: unknown) =>
        error instanceof SessionRegistryError && error.code === "GIT_COMMAND_FAILED" && error.details.exitCode === 7,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not let ambient repository or config authority splice another repository", () => {
  const fixture = createRepositoryFixture();
  const foreign = createRepositoryFixture();
  try {
    const foreignGitDirectory = path.join(foreign.repositoryPath, ".git");
    const git = createGitCommandRunner({
      env: {
        GIT_DIR: foreignGitDirectory,
        GIT_WORK_TREE: foreign.repositoryPath,
        GIT_COMMON_DIR: foreignGitDirectory,
        GIT_INDEX_FILE: path.join(foreignGitDirectory, "index"),
        GIT_OBJECT_DIRECTORY: path.join(foreignGitDirectory, "objects"),
        GIT_OBJECT_DIRECTORY_RELATIVE: "objects",
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignGitDirectory, "objects"),
        GIT_QUARANTINE_PATH: path.join(foreignGitDirectory, "quarantine"),
        GIT_NAMESPACE: "foreign",
        GIT_CEILING_DIRECTORIES: path.dirname(foreign.repositoryPath),
        GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(foreign.repositoryPath, "config"),
        GIT_CONFIG_SYSTEM: path.join(foreign.repositoryPath, "config"),
        GIT_CONFIG_NOSYSTEM: "0",
        GIT_CONFIG_PARAMETERS: "'core.worktree=/foreign'",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: foreign.repositoryPath,
      },
    });

    const resolved = resolveRepositoryContext({ cwd: fixture.repositoryPath, git });
    assert.equal(resolved.repositoryId, fs.realpathSync.native(path.join(fixture.repositoryPath, ".git")));
    assert.equal(resolved.worktreePath, fs.realpathSync.native(fixture.repositoryPath));
    assert.equal(
      verifyPhysicalExecutionContext({ cwd: fixture.repositoryPath, git }).worktreePath,
      resolved.worktreePath,
    );
  } finally {
    fixture.cleanup();
    foreign.cleanup();
  }
});

test("keeps foreign index and object directories out of governed observation and mutation", () => {
  const fixture = createRepositoryFixture();
  const foreign = createRepositoryFixture();
  try {
    const foreignGitDirectory = path.join(foreign.repositoryPath, ".git");
    const foreignIndex = path.join(foreignGitDirectory, "index");
    const foreignIndexBefore = fs.readFileSync(foreignIndex);
    const foreignObjects = listDirectoryEntries(path.join(foreignGitDirectory, "objects"));
    const foreignHead = runGit(["rev-parse", "HEAD"], foreign.repositoryPath);
    const git = createGitCommandRunner({
      env: {
        GIT_INDEX_FILE: foreignIndex,
        GIT_OBJECT_DIRECTORY: path.join(foreignGitDirectory, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignGitDirectory, "objects"),
      },
    });

    const resource = "governed.txt";
    fs.writeFileSync(path.join(fixture.repositoryPath, resource), "target\n");
    assert.deepEqual(observeGitCheckpoint(git, fixture.repositoryPath).untracked, [resource]);
    git.run(["add", "--", resource], fixture.repositoryPath);
    const targetHead = git.run(["rev-parse", "HEAD"], fixture.repositoryPath);
    git.run(["commit", "-m", "governed"], fixture.repositoryPath);

    assert.notEqual(targetHead, git.run(["rev-parse", "HEAD"], fixture.repositoryPath));
    assert.equal(foreignHead, runGit(["rev-parse", "HEAD"], foreign.repositoryPath));
    assert.deepEqual(fs.readFileSync(foreignIndex), foreignIndexBefore);
    assert.deepEqual(listDirectoryEntries(path.join(foreignGitDirectory, "objects")), foreignObjects);
    assert.equal(
      runGit(
        ["cat-file", "-e", `${git.run(["rev-parse", "HEAD"], fixture.repositoryPath)}^{commit}`],
        fixture.repositoryPath,
      ),
      "",
    );
  } finally {
    fixture.cleanup();
    foreign.cleanup();
  }
});

test("preserves explicit transport authentication variables while enforcing local Git policy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-environment-"));
  try {
    const git = createGitCommandRunner({
      executable: process.execPath,
      env: {
        GIT_SSH_COMMAND: "ssh -i /explicit/key",
        GIT_SSH_VARIANT: "ssh",
        GIT_ASKPASS: "/explicit/askpass",
        GIT_PROXY_COMMAND: "/explicit/proxy",
        GIT_DIR: "/foreign/.git",
        GIT_CONFIG_PARAMETERS: "'core.worktree=/foreign'",
      },
    });
    const observed = JSON.parse(
      git.run(
        [
          "-e",
          "process.stdout.write(JSON.stringify({ssh: process.env.GIT_SSH_COMMAND, variant: process.env.GIT_SSH_VARIANT, askpass: process.env.GIT_ASKPASS, proxy: process.env.GIT_PROXY_COMMAND, dir: process.env.GIT_DIR, config: process.env.GIT_CONFIG_PARAMETERS, global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM, nosystem: process.env.GIT_CONFIG_NOSYSTEM}))",
        ],
        directory,
      ),
    ) as Record<string, string | undefined>;

    assert.equal(observed.ssh, "ssh -i /explicit/key");
    assert.equal(observed.variant, "ssh");
    assert.equal(observed.askpass, "/explicit/askpass");
    assert.equal(observed.proxy, "/explicit/proxy");
    assert.equal(observed.dir, undefined);
    assert.equal(observed.config, undefined);
    assert.equal(observed.global, "/dev/null");
    assert.equal(observed.system, "/dev/null");
    assert.equal(observed.nosystem, "1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sanitizes Git authority environment regardless of key casing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-environment-"));
  try {
    const git = createGitCommandRunner({
      executable: process.execPath,
      env: {
        git_dir: "/foreign/.git",
        Git_Work_Tree: "/foreign",
        GIT_CONFIG_count: "1",
        git_config_key_0: "core.worktree",
        git_config_value_0: "/foreign",
        git_external_diff: "/explicit/evil-diff",
      },
    });
    const observed = JSON.parse(
      git.run(
        [
          "-e",
          "process.stdout.write(JSON.stringify({dir: process.env.git_dir ?? process.env.GIT_DIR, worktree: process.env.Git_Work_Tree ?? process.env.GIT_WORK_TREE, configCount: process.env.GIT_CONFIG_count ?? process.env.GIT_CONFIG_COUNT, externalDiff: process.env.git_external_diff ?? process.env.GIT_EXTERNAL_DIFF}))",
        ],
        directory,
      ),
    ) as Record<string, string | undefined>;

    assert.equal(observed.dir, undefined);
    assert.equal(observed.worktree, undefined);
    assert.equal(observed.configCount, undefined);
    assert.equal(observed.externalDiff, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("sanitizes Git environment that changes local observation or mutation semantics", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-environment-"));
  try {
    const git = createGitCommandRunner({
      executable: process.execPath,
      env: {
        GIT_EXTERNAL_DIFF: "/explicit/evil-diff",
        GIT_PAGER: "/explicit/evil-pager",
        GIT_EDITOR: "/explicit/evil-editor",
        GIT_SEQUENCE_EDITOR: "/explicit/evil-sequence-editor",
        GIT_ICASE_PATHSPECS: "1",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_GLOB_PATHSPECS: "1",
        GIT_NOGLOB_PATHSPECS: "1",
        GIT_ATTR_SOURCE: "refs/heads/foreign",
        GIT_SSH_COMMAND: "ssh -i /explicit/key",
      },
    });
    const observed = JSON.parse(
      git.run(
        [
          "-e",
          "process.stdout.write(JSON.stringify({externalDiff: process.env.GIT_EXTERNAL_DIFF, pager: process.env.GIT_PAGER, editor: process.env.GIT_EDITOR, sequenceEditor: process.env.GIT_SEQUENCE_EDITOR, icasePathspecs: process.env.GIT_ICASE_PATHSPECS, literalPathspecs: process.env.GIT_LITERAL_PATHSPECS, globPathspecs: process.env.GIT_GLOB_PATHSPECS, noglobPathspecs: process.env.GIT_NOGLOB_PATHSPECS, attrSource: process.env.GIT_ATTR_SOURCE, ssh: process.env.GIT_SSH_COMMAND}))",
        ],
        directory,
      ),
    ) as Record<string, string | undefined>;

    assert.equal(observed.externalDiff, undefined);
    assert.equal(observed.pager, undefined);
    assert.equal(observed.editor, undefined);
    assert.equal(observed.sequenceEditor, undefined);
    assert.equal(observed.icasePathspecs, undefined);
    assert.equal(observed.literalPathspecs, undefined);
    assert.equal(observed.globPathspecs, undefined);
    assert.equal(observed.noglobPathspecs, undefined);
    assert.equal(observed.attrSource, undefined);
    assert.equal(observed.ssh, "ssh -i /explicit/key");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not let GIT_EXTERNAL_DIFF substitute an external process for evidence diffs", () => {
  const fixture = createRepositoryFixture();
  try {
    const canaryPath = path.join(fixture.repositoryPath, "external-diff-ran.txt");
    const script = path.join(fixture.repositoryPath, "external-diff.cjs");
    fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(canaryPath)}, "ran");\nprocess.exit(0);\n`);
    fs.writeFileSync(path.join(fixture.repositoryPath, "README.md"), "changed\n");

    const git = createGitCommandRunner({
      env: {
        GIT_EXTERNAL_DIFF: `${process.execPath} ${script}`,
      },
    });

    git.run(["diff"], fixture.repositoryPath);

    assert.equal(fs.existsSync(canaryPath), false);
  } finally {
    fixture.cleanup();
  }
});

test("does not collapse unexpected Git exits or unavailable observations", () => {
  const fixture = createRepositoryFixture();
  try {
    const unexpectedExitGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected unexpected exit", { exitCode: 7 });
        }
        return defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () => resolveRepositoryContext({ cwd: fixture.repositoryPath, git: unexpectedExitGit }),
      (error: unknown) =>
        error instanceof SessionRegistryError && error.code === "GIT_COMMAND_FAILED" && error.details.exitCode === 7,
    );

    const unavailableGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "worktree" && args[1] === "list") throw new Error("injected physical observation failure");
        return defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: fixture.repositoryPath, git: unavailableGit }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PHYSICAL_OBSERVATION_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects a lock-suffixed component in a branch identity", () => {
  assert.throws(
    () => normalizeBranchId("feature/locked.lock/name"),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_BRANCH_ID",
  );
  assert.throws(
    () => normalizeBranchId("feature/ends-at@"),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_BRANCH_ID",
  );
});

test("preserves prunable status from Git's porcelain worktree inventory", () => {
  const prunablePath = "/tmp/nawabari-prunable-parser";
  const healthyPath = "/tmp/nawabari-healthy-parser";
  const output = [
    `worktree ${prunablePath}`,
    "HEAD 0123456789012345678901234567890123456789",
    "branch refs/heads/feature/prunable",
    "prunable gitdir file points to non-existent location",
    "",
    `worktree ${healthyPath}`,
    "HEAD 0123456789012345678901234567890123456789",
    "branch refs/heads/main",
    "",
  ].join("\n");

  const worktrees = listGitWorktrees(
    {
      run(args: readonly string[], cwd: string): string {
        assert.deepEqual(args, ["worktree", "list", "--porcelain"]);
        assert.equal(cwd, process.cwd());
        return output;
      },
    },
    process.cwd(),
  );

  assert.deepEqual(worktrees, [
    { worktreePath: path.resolve(prunablePath), branchName: "feature/prunable", prunable: true },
    { worktreePath: path.resolve(healthyPath), branchName: "main", prunable: false },
  ]);
});

test("shares canonical checkpoint and mutation observations without dropping literal path characters", () => {
  const fixture = createRepositoryFixture();
  try {
    fs.writeFileSync(path.join(fixture.repositoryPath, "literal*?.txt"), "untracked\n");

    const checkpoint = observeGitCheckpoint(defaultGit, fixture.repositoryPath);
    const mutation = observeGitMutationPaths(defaultGit, fixture.repositoryPath);

    assert.deepEqual(checkpoint.untracked, ["literal*?.txt"]);
    assert.deepEqual(mutation.changed, checkpoint.changed);
    assert.deepEqual(mutation.staged, checkpoint.staged);
    assert.throws(
      () => canonicalizeGitObservedPaths(["../escape.txt"], fixture.repositoryPath),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_STATE_AMBIGUOUS",
    );
  } finally {
    fixture.cleanup();
  }
});

test("canonicalizes the exact paths reported for a resulting commit", () => {
  const fixture = createRepositoryFixture();
  try {
    fs.appendFileSync(path.join(fixture.repositoryPath, "README.md"), "committed\n");
    runGit(["add", "README.md"], fixture.repositoryPath);
    runGit(["commit", "-m", "changed"], fixture.repositoryPath);
    const commitSha = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);

    assert.deepEqual(readCanonicalCommitChangedPaths(defaultGit, fixture.repositoryPath, commitSha), ["README.md"]);
  } finally {
    fixture.cleanup();
  }
});

test("reads bounded literal-path stats and patch evidence without widening the selection", () => {
  const fixture = createRepositoryFixture();
  try {
    const literalPath = "literal*?.txt";
    fs.writeFileSync(path.join(fixture.repositoryPath, literalPath), "before\n");
    runGit(["add", "--", literalPath], fixture.repositoryPath);
    runGit(["commit", "-m", "literal"], fixture.repositoryPath);
    fs.appendFileSync(path.join(fixture.repositoryPath, literalPath), "after\n");

    const diff = readBoundedGitDiff(defaultGit, fixture.repositoryPath, {
      paths: [literalPath],
      includePatch: true,
      maxBytes: 4_096,
      maxHunks: 4,
    });

    assert.deepEqual(diff.paths, [literalPath]);
    assert.equal(diff.stats.length, 1);
    assert.deepEqual(diff.stats[0], {
      path: literalPath,
      additions: 1,
      deletions: 0,
      binary: false,
      available: true,
    });
    assert.match(diff.patch ?? "", /after/u);
    assert.equal(diff.hunkCount, 1);
    assert.throws(
      () =>
        readBoundedGitDiff(defaultGit, fixture.repositoryPath, {
          paths: [literalPath],
          includePatch: true,
          maxBytes: 1,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_OUTPUT_LIMIT",
    );
  } finally {
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-"));
  const linkedWorktreePath = path.join(path.dirname(repositoryPath), `${path.basename(repositoryPath)}-linked`);
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  runGit(["worktree", "add", "-b", "feature/linked", linkedWorktreePath], repositoryPath);

  return {
    repositoryPath,
    linkedWorktreePath,
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", linkedWorktreePath], repositoryPath);
      } catch {
        // The directory cleanup remains safe when Git metadata was already removed.
      }
      fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
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

function listDirectoryEntries(directory: string): readonly string[] {
  return fs.readdirSync(directory).sort();
}
