import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { defaultGit } from "./git.js";
import { SessionRegistry } from "./session-registry.js";

test("close removes a clean provisioned worktree and merged branch, and repeats idempotently", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-clean-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/clean-close" });

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.equal(result.idempotent, false);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);

    const repeated = registry.close(session.sessionId);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.session.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close permits ignored generated artifacts but still protects recoverable files", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-ignored-build-close`;
  try {
    fs.writeFileSync(path.join(fixture.repositoryPath, ".gitignore"), "dist/\n.cache/\n");
    runGit(["add", ".gitignore"], fixture.repositoryPath);
    runGit(["commit", "-m", "ignore generated artifacts"], fixture.repositoryPath);

    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/ignored-build-close" });
    fs.mkdirSync(path.join(worktreePath, "dist"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, "dist", "generated.js"), "generated\n");
    fs.mkdirSync(path.join(worktreePath, ".cache"), { recursive: true });
    fs.writeFileSync(path.join(worktreePath, ".cache", "metadata"), "generated\n");

    fs.writeFileSync(path.join(worktreePath, "notes.txt"), "recoverable\n");
    assert.throws(
      () => registry.close(session.sessionId),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "DIRTY_WORKTREE",
    );
    fs.rmSync(path.join(worktreePath, "notes.txt"));

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.equal(fs.existsSync(worktreePath), false);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close refuses dirty worktrees without changing ownership", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-dirty-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/dirty-close" });
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "recoverable\n");

    assertRegistryError(() => registry.close(session.sessionId), "DIRTY_WORKTREE");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close refuses a clean branch containing commits not retained by the integration branch", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-recoverable-commit`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/recoverable-commit" });
    fs.writeFileSync(path.join(worktreePath, "committed.txt"), "recoverable\n");
    runGit(["add", "committed.txt"], worktreePath);
    runGit(["commit", "-m", "recoverable session work"], worktreePath);

    assertRegistryError(() => registry.close(session.sessionId), "RECOVERABLE_COMMITS");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close fails closed when Git moved the owned branch to another worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-mismatched-close`;
  const movedPath = `${fixture.repositoryPath}-moved-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/mismatched-close" });
    runGit(["worktree", "move", worktreePath, movedPath], fixture.repositoryPath);

    assertRegistryError(() => registry.close(session.sessionId), "OWNERSHIP_MISMATCH");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(movedPath), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    removeWorktree(fixture.repositoryPath, movedPath);
    fixture.cleanup();
  }
});

test("close safely releases registry state when Git already removed the worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-missing-resource`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/missing-resource" });
    runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, false);
    assert.equal(result.branchRemoved, true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("an interrupted close remains retryable from the explicit closing state", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-interrupted-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/interrupted-close" });
    let failWorktreeRemoval = true;
    const interruptedGit = {
      run(args: readonly string[], cwd: string): string {
        if (failWorktreeRemoval && args[0] === "worktree" && args[1] === "remove") {
          failWorktreeRemoval = false;
          throw new Error("simulated interrupted worktree removal");
        }
        return defaultGit.run(args, cwd);
      },
    };

    const interruptedRegistry = new SessionRegistry({
      repository: registry.repository,
      git: interruptedGit,
    });
    assert.throws(() => interruptedRegistry.close(session.sessionId), /simulated interrupted worktree removal/u);
    assert.equal(registry.get(session.sessionId)?.state, "closing");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);

    const retried = registry.close(session.sessionId);
    assert.equal(retried.session.state, "closed");
    assert.equal(retried.worktreeRemoved, true);
    assert.equal(retried.branchRemoved, true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc detects stale metadata without mutation and applies only safe cleanup", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-stale-cleanup`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => now,
      staleAfterMs: 1_000,
    });
    const session = registry.provision({ worktreePath, branchName: "feature/stale-cleanup" });
    now = new Date("2026-01-01T00:00:02.000Z");

    const detected = registry.garbageCollect({ apply: false });
    assert.equal(detected.candidates.length, 1);
    assert.equal(detected.candidates[0].sessionId, session.sessionId);
    assert.equal(detected.cleaned.length, 0);
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);

    const applied = registry.garbageCollect({ apply: true });
    assert.equal(applied.candidates.length, 1);
    assert.equal(applied.cleaned.length, 1);
    assert.equal(applied.blocked.length, 0);
    assert.equal(applied.cleaned[0].state, "closed");
    assert.equal(fs.existsSync(worktreePath), false);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc marks stale dirty sessions but does not remove recoverable work", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-stale-dirty`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => now,
      staleAfterMs: 1_000,
    });
    const session = registry.provision({ worktreePath, branchName: "feature/stale-dirty" });
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "keep me\n");
    now = new Date("2026-01-01T00:00:02.000Z");

    const result = registry.garbageCollect({ apply: true });
    assert.equal(result.cleaned.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].sessionId, session.sessionId);
    assert.equal(result.blocked[0].code, "DIRTY_WORKTREE");
    assert.equal(registry.get(session.sessionId)?.state, "stale");
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc recovers an externally removed prunable worktree and permits branch reuse", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-prunable-worktree`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => now,
      staleAfterMs: 24 * 60 * 60 * 1_000,
    });
    const session = registry.provision({ worktreePath, branchName: "feature/prunable-worktree" });

    fs.rmSync(worktreePath, { recursive: true, force: true });
    const worktreeList = runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath).split(/\r?\n/u);
    assert.equal(worktreeList.includes(`worktree ${worktreePath}`), true);
    assert.equal(
      worktreeList.some((line) => line.startsWith("prunable ")),
      true,
    );

    const detected = registry.garbageCollect({ apply: false });
    assert.deepEqual(
      detected.candidates.map((candidate) => candidate.sessionId),
      [session.sessionId],
    );
    assert.equal(detected.cleaned.length, 0);
    assert.equal(registry.get(session.sessionId)?.state, "active");

    const applied = registry.garbageCollect({ apply: true });
    assert.deepEqual(
      applied.candidates.map((candidate) => candidate.sessionId),
      [session.sessionId],
    );
    assert.deepEqual(
      applied.cleaned.map((cleaned) => cleaned.sessionId),
      [session.sessionId],
    );
    assert.equal(applied.blocked.length, 0);
    assert.equal(applied.cleaned[0]?.state, "closed");
    assert.equal(registry.get(session.sessionId)?.state, "closed");
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);

    const repeated = registry.garbageCollect({ apply: true });
    assert.deepEqual(repeated.candidates, []);
    assert.deepEqual(repeated.cleaned, []);
    assert.deepEqual(repeated.blocked, []);

    const reused = registry.provision({ worktreePath, branchName: session.branchName });
    assert.notEqual(reused.sessionId, session.sessionId);
    assert.equal(reused.state, "active");
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close succeeds when multiple prunable worktree entries exist alongside the session worktree", () => {
  const fixture = createRepositoryFixture();
  const sessionWorktreePath = `${fixture.repositoryPath}-session-prunable`;
  const externalWorktreePath1 = `${fixture.repositoryPath}-external-prunable-1`;
  const externalWorktreePath2 = `${fixture.repositoryPath}-external-prunable-2`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath: sessionWorktreePath, branchName: "feature/session-prunable" });

    runGit(["worktree", "add", "-b", "feature/external-1", externalWorktreePath1], fixture.repositoryPath);
    runGit(["worktree", "add", "-b", "feature/external-2", externalWorktreePath2], fixture.repositoryPath);

    fs.rmSync(externalWorktreePath1, { recursive: true, force: true });
    fs.rmSync(externalWorktreePath2, { recursive: true, force: true });

    const worktreeList = runGit(["worktree", "list", "--porcelain"], fixture.repositoryPath).split(/\r?\n/u);
    const prunableLines = worktreeList.filter((line) => line.startsWith("prunable "));
    assert.equal(prunableLines.length >= 2, true, "Expected at least two prunable worktree entries");

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.equal(fs.existsSync(sessionWorktreePath), false);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);
  } finally {
    removeWorktree(fixture.repositoryPath, sessionWorktreePath);
    removeWorktree(fixture.repositoryPath, externalWorktreePath1);
    removeWorktree(fixture.repositoryPath, externalWorktreePath2);
    fixture.cleanup();
  }
});

test("close proves a squash-merged session branch integrated via exact tree equivalence and safely closes", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-squash-merge`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/squash-merge" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "add feature"], worktreePath);

    // Ordinary ancestry-based close remains blocked: the original session
    // commit is not, and never will be, an ancestor of main after a squash.
    assertRegistryError(() => registry.close(session.sessionId), "RECOVERABLE_COMMITS");
    assert.equal(registry.get(session.sessionId)?.state, "active");

    // Simulate the squash-merge landing on main: same net content, unrelated commit SHA.
    fs.writeFileSync(path.join(fixture.repositoryPath, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], fixture.repositoryPath);
    runGit(["commit", "-m", "squash-merge feat/squash-merge (#1)"], fixture.repositoryPath);
    const integratedRevision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);

    const result = registry.close({ sessionId: session.sessionId, integratedRevision });
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.equal(result.idempotent, false);
    assert.equal(result.integrationProof?.method, "tree-equivalence");
    assert.equal(result.integrationProof?.integratedRevision, integratedRevision);
    assert.deepEqual(result.integrationProof?.lineage, {
      method: "integration-branch-ancestor",
      integrationBranch: "main",
      integratedRevision,
    });
    assert.deepEqual(result.integrationProof?.content, { method: "tree-equivalence" });
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);

    const repeated = registry.close({ sessionId: session.sessionId, integratedRevision });
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.session.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close rejects self-referential integration evidence and inspect reports the same blocker", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-self-reference`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/self-reference" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "self-reference must remain recoverable\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "self-reference candidate"], worktreePath);

    const diagnostic = registry.diagnose({
      sessionId: session.sessionId,
      integratedRevision: session.branchName,
    });
    const diagnosticBlocker = diagnostic.blockers[0];
    assert.equal(diagnostic.closeReadiness, "blocked");
    assert.equal(diagnostic.resultState, "complete");
    assert.equal(diagnosticBlocker?.code, "RECOVERABLE_COMMITS");
    assert.equal(diagnosticBlocker?.details.proofMethod, "integration-lineage");
    assert.equal(diagnosticBlocker?.details.proofStage, "lineage");
    assert.equal(diagnosticBlocker?.details.proofFailure, "integration-revision-not-authoritative");

    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision: session.branchName }),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "RECOVERABLE_COMMITS");
        assert.equal(error.details.proofMethod, "integration-lineage");
        assert.equal(error.details.proofFailure, "integration-revision-not-authoritative");
        assert.equal(error.details.closeReadiness, diagnostic.closeReadiness);
        assert.equal(error.details.resultState, diagnostic.resultState);
        assert.deepEqual(
          [...(error.details.safeActions as string[])].sort(),
          [...diagnosticBlocker!.safeActions].sort(),
        );
        return true;
      },
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close rejects a same-tree sibling branch as non-authoritative evidence", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-sibling-session`;
  const siblingWorktreePath = `${fixture.repositoryPath}-sibling-evidence`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/sibling-session" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "same tree, different branch\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "session equivalent content"], worktreePath);

    runGit(["worktree", "add", "-b", "feat/sibling-evidence", siblingWorktreePath, "main"], fixture.repositoryPath);
    fs.writeFileSync(path.join(siblingWorktreePath, "feature.txt"), "same tree, different branch\n");
    runGit(["add", "feature.txt"], siblingWorktreePath);
    runGit(["commit", "-m", "sibling equivalent content"], siblingWorktreePath);
    const siblingRevision = runGit(["rev-parse", "feat/sibling-evidence"], fixture.repositoryPath);

    const sessionRevision = runGit(["rev-parse", session.branchName], fixture.repositoryPath);
    assert.equal(
      runGit(["rev-parse", `${sessionRevision}^{tree}`], fixture.repositoryPath),
      runGit(["rev-parse", `${siblingRevision}^{tree}`], fixture.repositoryPath),
    );
    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision: "feat/sibling-evidence" }),
      (error: unknown) => {
        if (!(error instanceof SessionRegistryError)) return false;
        assert.equal(error.code, "RECOVERABLE_COMMITS");
        assert.equal(error.details.proofFailure, "integration-revision-not-authoritative");
        assert.equal(error.details.integrationBranch, "main");
        return true;
      },
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    removeWorktree(fixture.repositoryPath, siblingWorktreePath);
    runGitQuiet(["branch", "-D", "feat/sibling-evidence"], fixture.repositoryPath);
    fixture.cleanup();
  }
});

test("close rejects an unreferenced equivalent commit even when its tree matches the session branch", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-detached-evidence`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/detached-evidence" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "detached equivalent content\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "session content"], worktreePath);
    const sessionRevision = runGit(["rev-parse", session.branchName], fixture.repositoryPath);
    const sessionTree = runGit(["rev-parse", `${sessionRevision}^{tree}`], fixture.repositoryPath);
    const detachedRevision = runGit(
      ["commit-tree", sessionTree, "-p", session.baseRevision!, "-m", "unreferenced equivalent content"],
      fixture.repositoryPath,
    );

    assert.equal(runGit(["rev-parse", `${detachedRevision}^{tree}`], fixture.repositoryPath), sessionTree);
    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision: detachedRevision }),
      (error: unknown) => {
        if (!(error instanceof SessionRegistryError)) return false;
        assert.equal(error.code, "RECOVERABLE_COMMITS");
        assert.equal(error.details.proofFailure, "integration-revision-not-authoritative");
        assert.equal(error.details.proofStage, "lineage");
        return true;
      },
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close accepts a cherry-pick-equivalent revision anchored in integration history", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-cherry-pick`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/cherry-pick" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "cherry-pick content\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "original session change"], worktreePath);
    const sessionRevision = runGit(["rev-parse", session.branchName], fixture.repositoryPath);

    fs.writeFileSync(path.join(fixture.repositoryPath, "unrelated.txt"), "integration branch change\n");
    runGit(["add", "unrelated.txt"], fixture.repositoryPath);
    runGit(["commit", "-m", "unrelated integration change"], fixture.repositoryPath);
    runGit(["cherry-pick", sessionRevision], fixture.repositoryPath);
    const integratedRevision = runGit(["rev-parse", "main"], fixture.repositoryPath);

    const result = registry.close({ sessionId: session.sessionId, integratedRevision });
    assert.equal(result.session.state, "closed");
    assert.equal(result.integrationProof?.method, "tree-equivalence");
    assert.equal(result.integrationProof?.lineage?.method, "integration-branch-ancestor");
    assert.equal(result.integrationProof?.lineage?.integrationBranch, "main");
    assert.equal(result.integrationProof?.content?.method, "tree-equivalence");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close does not trust caller-asserted integration evidence that fails to prove equivalence", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-unproven-evidence`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/unproven-evidence" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "recoverable session work\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "add feature"], worktreePath);

    // A revision on main that shares no content with the session branch's diff.
    fs.writeFileSync(path.join(fixture.repositoryPath, "unrelated.txt"), "unrelated change\n");
    runGit(["add", "unrelated.txt"], fixture.repositoryPath);
    runGit(["commit", "-m", "unrelated change"], fixture.repositoryPath);
    const integratedRevision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);

    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision }),
      (error: unknown) => {
        if (!(error instanceof SessionRegistryError) || error.code !== "RECOVERABLE_COMMITS") return false;
        assert.equal(error.details.proofMethod, "tree-equivalence");
        assert.equal(error.details.proofResult, "unproven");
        return true;
      },
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close does not treat a whitespace-only-differing integration revision as proven equivalent", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-whitespace-evidence`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/whitespace-evidence" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "recoverable session work\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "add feature"], worktreePath);

    // Same content, but with a trailing-whitespace-only difference. A
    // patch/diff-based proof (e.g. git patch-id) can consider this
    // equivalent to the branch's own change; exact Git tree-object identity
    // (a distinct blob SHA) must not.
    fs.writeFileSync(path.join(fixture.repositoryPath, "feature.txt"), "recoverable session work \n");
    runGit(["add", "feature.txt"], fixture.repositoryPath);
    runGit(["commit", "-m", "squash-merge feat/whitespace-evidence (#1)"], fixture.repositoryPath);
    const integratedRevision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);

    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision }),
      (error: unknown) => {
        if (!(error instanceof SessionRegistryError) || error.code !== "RECOVERABLE_COMMITS") return false;
        assert.equal(error.details.proofMethod, "tree-equivalence");
        assert.equal(error.details.proofResult, "unproven");
        return true;
      },
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close rejects an unresolvable integrated-revision evidence reference before touching cleanup state", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-unresolved-evidence`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feat/unresolved-evidence" });
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "recoverable session work\n");
    runGit(["add", "feature.txt"], worktreePath);
    runGit(["commit", "-m", "add feature"], worktreePath);

    assertRegistryError(
      () => registry.close({ sessionId: session.sessionId, integratedRevision: "0".repeat(40) }),
      "INVALID_BASE_REF",
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-lifecycle-"));
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

function hasLocalBranch(repositoryPath: string, branchName: string): boolean {
  return runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath);
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
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
