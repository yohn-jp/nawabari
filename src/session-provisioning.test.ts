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
import { errnoError, withDirectoryFsyncFailure } from "./testing/fs-fault-injection.js";

test("bounded provision establishes and persists the effective working set before ownership commit", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-working-set");
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: repository.repositoryId };
    const base = { branch: "main", revision };
    const executionScope = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 374 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base,
      scope: { readOnly: ["README.md"], write: [], create: [], delete: [], deny: [] },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-374",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:bootstrap", summary: "bounded fixture" },
          evidence: [{ artifact: "test", reference: "README.md" }],
        },
      ],
    };
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/provisioned-working-set",
      executionScope,
      candidateWorkingSet,
    });

    assert.equal(session.workingSet?.revision, 1);
    assert.equal(session.workingSet?.repository.repositoryId, repository.repositoryId);
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      sessions: Array<{ working_set?: { id?: string; revision?: number } }>;
    };
    assert.equal(typeof persisted.sessions[0]?.working_set?.id, "string");
    assert.equal(persisted.sessions[0]?.working_set?.revision, 1);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("unsatisfiable bounded working-set bootstrap creates no ownership", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-invalid-working-set");
  const branchName = "feature/provisioned-invalid-working-set";
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: repository.repositoryId };
    assertRegistryError(
      () =>
        new SessionRegistry({ cwd: fixture.repositoryPath }).provision({
          worktreePath,
          branchName,
          executionScope: {
            version: 1,
            kind: "implementation-execution-scope",
            authorization: {
              version: 1,
              kind: "implementation-authorization",
              contractVersion: 1,
              implementation: { ...identity, number: 374 },
              governedBodyDigest: "b".repeat(64),
            },
            repository: identity,
            base: { branch: "main", revision },
            scope: { readOnly: ["README.md"], write: [], create: [], delete: [], deny: [] },
          },
          candidateWorkingSet: {
            kind: "candidate-working-set",
            schemaVersion: 1,
            workingSetId: "candidate-374-invalid",
            repository: { ...identity, repository: "local/nawabari" },
            revision,
            entries: [
              {
                state: "required",
                target: { kind: "file", locator: "src/secret.ts" },
                reason: { id: "test:bootstrap", summary: "outside scope" },
                evidence: [],
              },
            ],
          },
        }),
      "OPERATION_REJECTED",
    );
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      false,
    );
    assert.deepEqual(new SessionRegistry({ cwd: fixture.repositoryPath }).list(), []);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

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

test("provision commits the complete initial claim set with the session", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-initial-claims");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/provisioned-initial-claims",
      initialClaims: [
        { resource: "README.md", mode: "write" },
        { resource: "src/**", mode: "read" },
      ],
    });

    assert.deepEqual(
      registry.listClaims(session.sessionId).map((claim) => [claim.resource, claim.mode]),
      [
        ["README.md", "write"],
        ["src/**", "read"],
      ],
    );
    assert.equal(registry.getClaimSetGeneration(), 1);
    assert.equal(registry.list().length, 1);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("provision materializes only declared repository-local auxiliary state and cleanup preserves its source", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-auxiliary-state");
  const source = path.join(fixture.repositoryPath, ".codegraph");
  try {
    fs.mkdirSync(path.join(source, "ignored"), { recursive: true });
    fs.writeFileSync(path.join(source, ".gitignore"), "ignored/\n");
    fs.writeFileSync(path.join(source, "ignored", "index.json"), "declared\n");
    fs.writeFileSync(path.join(source, "ignored", "daemon.pid"), "123\n");
    runGit(["add", ".codegraph/.gitignore"], fixture.repositoryPath);
    runGit(["commit", "-m", "add codegraph anchor"], fixture.repositoryPath);

    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/provisioned-auxiliary-state",
      initialClaims: [{ resource: "README.md", mode: "write" }],
      auxiliaryState: [
        {
          source: { kind: "repository-local", path: ".codegraph/ignored" },
          target: { kind: "managed-worktree", path: ".codegraph/ignored" },
          mode: "copy",
          durability: "durable",
        },
      ],
    });

    assert.equal(fs.readFileSync(path.join(worktreePath, ".codegraph", "ignored", "index.json"), "utf8"), "declared\n");
    assert.equal(fs.existsSync(path.join(worktreePath, ".codegraph", ".gitignore")), true);
    assert.equal(fs.existsSync(path.join(worktreePath, ".codegraph", "ignored", "daemon.pid")), true);
    assert.equal(runGit(["status", "--porcelain"], worktreePath), "");
    assert.deepEqual(
      registry.listClaims(session.sessionId).map((claim) => [claim.resource, claim.mode]),
      [["README.md", "write"]],
    );

    registry.close(session.sessionId);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(fs.readFileSync(path.join(source, ".gitignore"), "utf8"), "ignored/\n");
    assert.equal(fs.readFileSync(path.join(source, "ignored", "index.json"), "utf8"), "declared\n");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("auxiliary-state setup failure rolls back the newly provisioned worktree and branch", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-invalid-auxiliary-state");
  const branchName = "feature/provisioned-invalid-auxiliary-state";
  try {
    fs.mkdirSync(path.join(fixture.repositoryPath, ".codegraph"), { recursive: true });
    fs.writeFileSync(path.join(fixture.repositoryPath, ".codegraph", ".gitignore"), "ignored/\n");
    runGit(["add", ".codegraph/.gitignore"], fixture.repositoryPath);
    runGit(["commit", "-m", "add codegraph anchor"], fixture.repositoryPath);
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assertRegistryError(
      () =>
        registry.provision({
          worktreePath,
          branchName,
          auxiliaryState: [
            {
              source: { kind: "repository-local", path: ".codegraph" },
              target: { kind: "managed-worktree", path: ".codegraph" },
              mode: "copy",
              durability: "durable",
            },
          ],
        }),
      "AUXILIARY_STATE_AMBIGUOUS",
    );
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      false,
    );
    assert.deepEqual(registry.list(), []);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("invalid initial claims roll back newly provisioned Git resources", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-invalid-claim");
  const branchName = "feature/provisioned-invalid-claim";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assertRegistryError(
      () =>
        registry.provision({
          worktreePath,
          branchName,
          initialClaims: [{ resource: "../outside", mode: "write" }],
        }),
      "CLAIM_PATH_TRAVERSAL",
    );
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      false,
    );
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.listClaims(), []);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("conflicting initial claims reject without leaving a second session", () => {
  const fixture = createRepositoryFixture();
  const firstPath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-claim-owner");
  const secondPath = path.join(path.dirname(fixture.repositoryPath), "nawabari-provisioned-claim-conflict");
  const secondBranch = "feature/provisioned-claim-conflict";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.provision({
      worktreePath: firstPath,
      branchName: "feature/provisioned-claim-owner",
      initialClaims: [{ resource: "README.md", mode: "write" }],
    });

    assertRegistryError(
      () =>
        registry.provision({
          worktreePath: secondPath,
          branchName: secondBranch,
          initialClaims: [{ resource: "README.md", mode: "write" }],
        }),
      "RESOURCE_CLAIM_CONFLICT",
    );
    assert.equal(fs.existsSync(secondPath), false);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${secondBranch}`], fixture.repositoryPath),
      false,
    );
    assert.deepEqual(
      registry.list().map((record) => record.sessionId),
      [first.sessionId],
    );
    assert.equal(registry.listClaims().length, 1);
  } finally {
    removeWorktree(fixture.repositoryPath, firstPath);
    removeWorktree(fixture.repositoryPath, secondPath);
    runGitQuiet(["branch", "-D", "--", secondBranch], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("provision creates the safe default managed root only when it is needed", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-default-root-"));
  const repositoryPath = path.join(parent, "repository");
  fs.mkdirSync(repositoryPath);
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  const managedRoot = path.join(parent, ".nawabari", "worktrees");
  let worktreePath: string | undefined;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    assert.equal(registry.managedWorktreeRoot, managedRoot);
    assert.equal(fs.existsSync(managedRoot), false);

    const session = registry.provision({ branchName: "feature/default-root" });
    worktreePath = session.worktreePath;
    assert.equal(path.dirname(session.worktreePath), managedRoot);
    assert.equal(fs.existsSync(managedRoot), true);
    assert.equal(fs.statSync(managedRoot).isDirectory(), true);

    // A historical absolute sibling override remains readable/provisionable;
    // the safe subdirectory is only the new default.
    const legacyWorktree = path.join(parent, "legacy-worktree");
    const legacySession = registry.provision({
      worktreePath: legacyWorktree,
      branchName: "feature/legacy-worktree",
    });
    assert.equal(legacySession.worktreePath, fs.realpathSync.native(legacyWorktree));
    removeWorktree(repositoryPath, legacyWorktree);
  } finally {
    if (worktreePath !== undefined) removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(parent, { recursive: true, force: true });
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

test("provision places the worktree under a caller-selected root while Nawabari derives the basename", () => {
  const fixture = createRepositoryFixture();
  const customRoot = path.join(path.dirname(fixture.repositoryPath), "nawabari-custom-root");
  try {
    fs.mkdirSync(customRoot);
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.provision({ worktreeRoot: customRoot, branchName: "feature/custom-root-one" });
    const second = registry.provision({ worktreeRoot: customRoot, branchName: "feature/custom-root-two" });

    assert.equal(path.dirname(first.worktreePath), fs.realpathSync.native(customRoot));
    assert.equal(path.dirname(second.worktreePath), fs.realpathSync.native(customRoot));
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.equal(path.basename(first.worktreePath), `${path.basename(fixture.repositoryPath)}-${first.sessionId}`);
  } finally {
    runGitQuiet(["worktree", "prune"], fixture.repositoryPath);
    fs.rmSync(customRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("provision rejects a caller-selected root that is missing, not a directory, or a symlink", () => {
  const fixture = createRepositoryFixture();
  const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
  const missingRoot = path.join(path.dirname(fixture.repositoryPath), "nawabari-missing-root");
  const fileRoot = path.join(path.dirname(fixture.repositoryPath), "nawabari-file-root");
  const linkedRoot = path.join(path.dirname(fixture.repositoryPath), "nawabari-linked-root");
  try {
    fs.writeFileSync(fileRoot, "not a directory");
    fs.symlinkSync(path.dirname(fixture.repositoryPath), linkedRoot, "dir");

    assertRegistryError(
      () => registry.provision({ worktreeRoot: missingRoot, branchName: "feature/missing-root" }),
      "INVALID_WORKTREE_PATH",
    );
    assertRegistryError(
      () => registry.provision({ worktreeRoot: fileRoot, branchName: "feature/file-root" }),
      "INVALID_WORKTREE_PATH",
    );
    assertRegistryError(
      () => registry.provision({ worktreeRoot: linkedRoot, branchName: "feature/linked-root" }),
      "INVALID_WORKTREE_PATH",
    );
  } finally {
    fs.unlinkSync(fileRoot);
    fs.unlinkSync(linkedRoot);
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

test("a durability-uncertain registry write after provisioning does not roll back the already-committed worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-durability-uncertain");
  const branchName = "feature/durability-uncertain";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    let session: ReturnType<typeof registry.provision> | undefined;
    assert.throws(
      () => {
        session = withDirectoryFsyncFailure(registry.paths.directory, "EIO", () =>
          registry.provision({ worktreePath, branchName, initialClaims: [{ resource: "README.md", mode: "write" }] }),
        );
      },
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );
    assert.equal(session, undefined);

    // The rename that commits the registry document already succeeded; only
    // the post-rename directory fsync could not be proven. Rolling back the
    // matching physical worktree/branch here would strand a registry entry
    // pointing at resources that no longer exist, so both must remain.
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      true,
    );
    const reread = new SessionRegistry({ cwd: fixture.repositoryPath });
    const records = reread.list();
    assert.equal(records.length, 1);
    assert.equal(records[0].worktreePath, fs.realpathSync.native(worktreePath));
    assert.equal(records[0].branchName, branchName);
    assert.deepEqual(
      reread.listClaims(records[0].sessionId).map((claim) => [claim.resource, claim.mode]),
      [["README.md", "write"]],
    );
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("an uncertain bootstrap retry distinguishes the proven declaration from an owner conflict", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-bootstrap-retry");
  const branchName = "feature/bootstrap-retry";
  const declaration = {
    worktreePath,
    branchName,
    label: "bootstrap-retry",
    initialClaims: [{ resource: "README.md", mode: "write" as const }],
  };
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assert.throws(
      () => withDirectoryFsyncFailure(registry.paths.directory, "EIO", () => registry.provision(declaration)),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REGISTRY_DURABILITY_UNCERTAIN",
    );
    const established = new SessionRegistry({ cwd: fixture.repositoryPath });
    const owner = established.list()[0];
    assert.ok(owner);
    assert.deepEqual(
      established.listClaims(owner.sessionId).map((claim) => [claim.resource, claim.mode]),
      [["README.md", "write"]],
    );

    assert.throws(
      () => established.provision(declaration),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "DUPLICATE_WORKTREE_OWNERSHIP");
        assert.deepEqual(error.details.bootstrap_retry, {
          classification: "already-established",
          exact_identity_proven: true,
          session_id: owner.sessionId,
          next_action: "inspect-established-session",
        });
        assert.equal(error.details.owner_session_id, owner.sessionId);
        return true;
      },
    );

    assert.throws(
      () =>
        established.provision({
          ...declaration,
          initialClaims: [{ resource: "README.md", mode: "read" }],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "DUPLICATE_WORKTREE_OWNERSHIP");
        assert.deepEqual(error.details.bootstrap_retry, {
          classification: "owner-conflict",
          exact_identity_proven: false,
          next_action: "inspect-blocking-session",
        });
        assert.equal(error.details.owner_session_id, owner.sessionId);
        return true;
      },
    );
    assert.equal(established.list().length, 1);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("a durability-uncertain failure with a definitively absent registry record rolls back the worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-durability-absent");
  const branchName = "feature/durability-absent";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assert.throws(
      () => {
        withRenameRedirectedElsewhere(registry.paths.registry, () => {
          withDirectoryFsyncFailure(registry.paths.directory, "EIO", () =>
            registry.provision({ worktreePath, branchName }),
          );
        });
      },
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );

    // The rename never actually reached the real registry path (redirected
    // to a shadow file), so a reconciliation read positively proves the
    // session record absent: rollback is safe here, unlike the "record
    // present" case above.
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(
      runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], fixture.repositoryPath),
      false,
    );
    assert.deepEqual(new SessionRegistry({ cwd: fixture.repositoryPath }).list(), []);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("a reconciliation read I/O failure after a durability-uncertain write preserves the original uncertain outcome and does not roll back", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-reconciliation-io-failure");
  const branchName = "feature/reconciliation-io-failure";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assert.throws(
      () => {
        withDirectoryFsyncFailure(registry.paths.directory, "EIO", () =>
          // Call 1 (of reads targeting the registry file) is provision()'s
          // own initial registry read; call 2 is the reconciliation read
          // inside the durability-uncertain catch path.
          withReadFileSyncOverrideOnCall(
            registry.paths.registry,
            2,
            () => {
              throw errnoError("EIO");
            },
            () => registry.provision({ worktreePath, branchName }),
          ),
        );
      },
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        // Absence could not be proven (the reconciliation read itself
        // failed), so the original durability-uncertain outcome must
        // survive unchanged rather than being replaced by a registry
        // read-failure code.
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );

    assert.equal(fs.existsSync(worktreePath), true);
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

test("a reconciliation read hitting corrupt registry state after a durability-uncertain write preserves the original uncertain outcome and does not roll back", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-reconciliation-corrupt");
  const branchName = "feature/reconciliation-corrupt";
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });

    assert.throws(
      () => {
        withDirectoryFsyncFailure(registry.paths.directory, "EIO", () =>
          withReadFileSyncOverrideOnCall(
            registry.paths.registry,
            2,
            () => "{not-json",
            () => registry.provision({ worktreePath, branchName }),
          ),
        );
      },
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        // Reconciliation observed REGISTRY_CORRUPT, not a proof of absence:
        // the original durability-uncertain outcome must still be what the
        // caller sees, not the incidental corruption code.
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );

    assert.equal(fs.existsSync(worktreePath), true);
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

test(
  "simultaneous bootstrap provisions serialize conflicting initial claims to one winner",
  { timeout: 30_000 },
  async () => {
    const fixture = createRepositoryFixture();
    const attempts = [
      {
        worktreePath: path.join(path.dirname(fixture.repositoryPath), "nawabari-bootstrap-conflict-one"),
        branchName: "feature/bootstrap-conflict-one",
      },
      {
        worktreePath: path.join(path.dirname(fixture.repositoryPath), "nawabari-bootstrap-conflict-two"),
        branchName: "feature/bootstrap-conflict-two",
      },
    ];
    try {
      const workerModule = new URL("./session-registry.ts", import.meta.url).href;
      const results = await Promise.all(
        attempts.map(({ worktreePath, branchName }) =>
          runClaimedProvisionWorker(workerModule, fixture.repositoryPath, worktreePath, branchName),
        ),
      );
      const successes = results.filter((result): result is { ok: true; sessionId: string } => result.ok);
      const conflicts = results.filter(
        (result): result is { ok: false; code: SessionRegistryError["code"] } => !result.ok,
      );

      assert.equal(successes.length, 1);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0]?.code, "RESOURCE_CLAIM_CONFLICT");

      const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
      const records = registry.list();
      assert.equal(records.length, 1);
      assert.equal(records[0]?.sessionId, successes[0]?.sessionId);
      assert.deepEqual(
        registry
          .listClaims()
          .map((claim) => ({ sessionId: claim.sessionId, resource: claim.resource, mode: claim.mode })),
        [{ sessionId: successes[0]?.sessionId, resource: "README.md", mode: "write" }],
      );

      const loser = attempts.find((attempt) => !results[attempts.indexOf(attempt)]?.ok);
      assert.ok(loser !== undefined);
      assert.equal(fs.existsSync(loser.worktreePath), false);
      assert.equal(
        runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${loser.branchName}`], fixture.repositoryPath),
        false,
      );
    } finally {
      for (const { worktreePath, branchName } of attempts) {
        removeWorktree(fixture.repositoryPath, worktreePath);
        runGitQuiet(["branch", "-D", "--", branchName], fixture.repositoryPath);
      }
      fixture.cleanup();
    }
  },
);

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

/**
 * Redirects the rename that would commit `targetPath` to a sibling
 * "shadow" path instead, so the rename call itself still reports success
 * (`renamed = true` inside the atomic writer) while the path readers
 * actually observe is left untouched. Used to construct a registry read
 * that positively proves session absence after a durability-uncertain
 * outcome, without relying on an exotic real filesystem failure mode.
 */
function withRenameRedirectedElsewhere<T>(targetPath: string, run: () => T): T {
  const original = fs.renameSync;
  fs.renameSync = ((oldPath: fs.PathLike, newPath: fs.PathLike) => {
    if (newPath === targetPath) {
      return original(oldPath, `${String(newPath)}.shadow`);
    }
    return original(oldPath, newPath);
  }) as typeof fs.renameSync;
  try {
    return run();
  } finally {
    fs.renameSync = original;
  }
}

/**
 * Overrides the `callIndex`-th `fs.readFileSync` call whose target is
 * exactly `targetPath`; calls against any other path (such as the
 * repository lock's own `/proc/<pid>/stat` liveness read) always pass
 * through unchanged, so this is immune to unrelated reads elsewhere in the
 * acquire/provision sequence.
 */
function withReadFileSyncOverrideOnCall<T>(
  targetPath: string,
  callIndex: number,
  override: () => string,
  run: () => T,
): T {
  const original = fs.readFileSync;
  let calls = 0;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === targetPath) {
      calls += 1;
      if (calls === callIndex) {
        return override();
      }
    }
    return original(...args);
  }) as typeof fs.readFileSync;
  try {
    return run();
  } finally {
    fs.readFileSync = original;
  }
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

type ClaimedProvisionWorkerResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly code: SessionRegistryError["code"] };

function runClaimedProvisionWorker(
  workerModule: string,
  repositoryPath: string,
  worktreePath: string,
  branchName: string,
): Promise<ClaimedProvisionWorkerResult> {
  const script = `
    import { SessionRegistry } from ${JSON.stringify(workerModule)};
    try {
      const session = new SessionRegistry({ cwd: process.env.NAWABARI_REPOSITORY }).provision({
        worktreePath: process.env.NAWABARI_WORKTREE,
        branchName: process.env.NAWABARI_BRANCH,
        initialClaims: [{ resource: "README.md", mode: "write" }],
      });
      process.stdout.write(JSON.stringify({ ok: true, sessionId: session.sessionId }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "UNKNOWN" }));
    }
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
      if (exitCode !== 0) {
        reject(new Error(`claimed provision worker exited with ${exitCode}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ClaimedProvisionWorkerResult);
      } catch (error: unknown) {
        reject(new Error(`claimed provision worker returned invalid JSON: ${stdout}`, { cause: error }));
      }
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
