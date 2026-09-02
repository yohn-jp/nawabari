import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { defaultGit } from "./git.js";
import { SessionRegistryError } from "./errors.js";
import { SessionRegistry } from "./session-registry.js";

test("diagnose reports ready close readiness and not-due cleanup readiness for a clean session, without mutation", () => {
  const fixture = createFixture("clean-ready");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/clean-ready" });

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "ready");
    assert.equal(diagnostic.cleanupReadiness, "not_due");
    assert.equal(diagnostic.resultState, "complete");
    assert.equal(diagnostic.physicalState, "healthy");
    assert.equal(diagnostic.idempotent, false);
    assert.deepEqual(diagnostic.blockers, []);
    assert.deepEqual([...diagnostic.safeActions], ["close-session"]);
    assert.equal(diagnostic.session.sessionId, session.sessionId);
    assert.equal(diagnostic.integrationEvidence.supplied, false);

    // Purely observational: repeated inspection of unchanged state returns
    // the exact same payload (no observation-time field to drift on).
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
    const repeated = registry.diagnose(session.sessionId);
    assert.deepEqual(repeated, diagnostic);

    // Parity: the actual close authority reaches the same conclusion.
    const closed = registry.close(session.sessionId);
    assert.equal(closed.session.state, "closed");
  } finally {
    fixture.cleanup();
  }
});

test("diagnose reports age suspicion without destructive GC eligibility for a healthy session", () => {
  const fixture = createFixture("stale-candidate");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository, staleAfterMs: 0 });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/stale-candidate" });

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "ready");
    assert.equal(diagnostic.cleanupReadiness, "not_due");
    assert.equal(diagnostic.garbageCollection.suspicion, "age");
    assert.equal(diagnostic.garbageCollection.destructiveEligibility, "ineligible");
    assert.deepEqual([...diagnostic.safeActions].sort(), ["close-session"]);
  } finally {
    fixture.cleanup();
  }
});

test("diagnose blocks on a dirty worktree with a stable code and safe actions, without mutation", () => {
  const fixture = createFixture("dirty-blocked");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/dirty-blocked" });
    fs.writeFileSync(path.join(fixture.worktree, "recoverable.txt"), "preserve\n");

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "blocked");
    assert.equal(diagnostic.cleanupReadiness, "blocked");
    assert.equal(diagnostic.resultState, "complete");
    assert.equal(diagnostic.blockers[0]?.code, "DIRTY_WORKTREE");
    assert.ok(diagnostic.blockers[0]?.safeActions.includes("commit-or-discard-changes"));
    assert.ok(diagnostic.blockers[0]?.recoveryHints.length > 0);
    assert.deepEqual([...diagnostic.safeActions], [...diagnostic.blockers[0]!.safeActions].sort());

    assert.equal(fs.existsSync(path.join(fixture.worktree, "recoverable.txt")), true);
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assertRegistryError(() => registry.close(session.sessionId), "DIRTY_WORKTREE");
  } finally {
    fixture.cleanup();
  }
});

test("diagnose represents unmerged commits as an explicit external-evidence-required state, not a generic block", () => {
  const fixture = createFixture("evidence-required");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/evidence-required" });
    fs.writeFileSync(path.join(fixture.worktree, "feature.txt"), "unmerged work\n");
    runGit(["add", "feature.txt"], fixture.worktree);
    runGit(["commit", "-m", "add feature"], fixture.worktree);

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "external_evidence_required");
    assert.equal(diagnostic.cleanupReadiness, "external_evidence_required");
    assert.equal(diagnostic.resultState, "external_evidence_required");
    assert.equal(diagnostic.blockers[0]?.code, "RECOVERABLE_COMMITS");
    assert.equal(diagnostic.blockers[0]?.details.proofMethod, "ancestry");
    assert.ok(diagnostic.blockers[0]?.safeActions.includes("provide-integration-evidence"));

    assertRegistryError(() => registry.close(session.sessionId), "RECOVERABLE_COMMITS");
    assert.equal(registry.get(session.sessionId)?.state, "active");
  } finally {
    fixture.cleanup();
  }
});

// Regression (#125 dogfood): a squash/rebase merge landed on the integration
// branch, and the caller ran a plain `close()` without --integrated-revision
// yet. The raw close rejection must carry the exact same #124 readiness
// classification `diagnose()` reports for the identical state, so a caller
// can tell "supply integration evidence" apart from "actually unintegrated"
// or "ambiguous" without a second diagnostic round trip and without the two
// authorities drifting apart.
test("close on a squash-merged session without evidence reports the same external-evidence-required classification as diagnose", () => {
  const fixture = createFixture("squash-merge-no-evidence-yet");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feat/squash-no-evidence" });
    fs.writeFileSync(path.join(fixture.worktree, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], fixture.worktree);
    runGit(["commit", "-m", "add feature"], fixture.worktree);

    // Simulate the squash-merge landing on main: same net content, unrelated SHA.
    fs.writeFileSync(path.join(fixture.repository, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], fixture.repository);
    runGit(["commit", "-m", "squash-merge feat/squash-no-evidence (#1)"], fixture.repository);

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "external_evidence_required");
    assert.equal(diagnostic.resultState, "external_evidence_required");
    const diagnosticBlocker = diagnostic.blockers[0];
    assert.equal(diagnosticBlocker?.code, "RECOVERABLE_COMMITS");
    assert.equal(diagnosticBlocker?.details.proofMethod, "ancestry");

    assert.throws(
      () => registry.close(session.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "RECOVERABLE_COMMITS");
        // Same #124 authority, not a second/independent judgment: identical
        // readiness, result state, and safe actions as diagnose() reported.
        assert.equal(error.details.closeReadiness, diagnostic.closeReadiness);
        assert.equal(error.details.resultState, diagnostic.resultState);
        assert.deepEqual(
          [...(error.details.safeActions as string[])].sort(),
          [...diagnosticBlocker!.safeActions].sort(),
        );
        assert.equal(error.details.proofMethod, "ancestry");
        assert.ok((error.details.safeActions as string[]).includes("provide-integration-evidence"));
        assert.notEqual(error.details.closeReadiness, "blocked");
        assert.notEqual(error.details.closeReadiness, "ambiguous");
        return true;
      },
    );
    // Fail-closed and non-mutating: the session is untouched by the rejected close.
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
    assert.equal(hasLocalBranch(fixture.repository, session.branchName), true);
  } finally {
    fixture.cleanup();
  }
});

test("diagnose reuses the #123 tree-equivalence proof and reports ready for a squash-merged session", () => {
  const fixture = createFixture("tree-equivalence-ready");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feat/squash-ready" });
    fs.writeFileSync(path.join(fixture.worktree, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], fixture.worktree);
    runGit(["commit", "-m", "add feature"], fixture.worktree);

    // Simulate the squash-merge landing on main: same net content, unrelated SHA.
    fs.writeFileSync(path.join(fixture.repository, "feature.txt"), "squash content\n");
    runGit(["add", "feature.txt"], fixture.repository);
    runGit(["commit", "-m", "squash-merge feat/squash-ready (#1)"], fixture.repository);
    const integratedRevision = runGit(["rev-parse", "HEAD"], fixture.repository);

    const diagnostic = registry.diagnose({ sessionId: session.sessionId, integratedRevision });
    assert.equal(diagnostic.closeReadiness, "ready");
    assert.equal(diagnostic.resultState, "complete");
    assert.deepEqual(diagnostic.blockers, []);
    assert.equal(diagnostic.integrationEvidence.supplied, true);
    assert.equal(diagnostic.integrationEvidence.integratedRevision, integratedRevision);
    assert.equal(diagnostic.integrationEvidence.proof?.method, "tree-equivalence");

    // No mutation happened while diagnosing; the branch/worktree are untouched.
    assert.equal(fs.existsSync(fixture.worktree), true);
    assert.equal(hasLocalBranch(fixture.repository, session.branchName), true);

    const closed = registry.close({ sessionId: session.sessionId, integratedRevision });
    assert.equal(closed.session.state, "closed");
    assert.equal(closed.integrationProof?.method, "tree-equivalence");
  } finally {
    fixture.cleanup();
  }
});

test("diagnose reports a deterministic block, not evidence-required, when supplied evidence fails to prove equivalence", () => {
  const fixture = createFixture("tree-equivalence-unproven");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feat/unproven" });
    fs.writeFileSync(path.join(fixture.worktree, "feature.txt"), "recoverable session work\n");
    runGit(["add", "feature.txt"], fixture.worktree);
    runGit(["commit", "-m", "add feature"], fixture.worktree);

    fs.writeFileSync(path.join(fixture.repository, "unrelated.txt"), "unrelated change\n");
    runGit(["add", "unrelated.txt"], fixture.repository);
    runGit(["commit", "-m", "unrelated change"], fixture.repository);
    const integratedRevision = runGit(["rev-parse", "HEAD"], fixture.repository);

    const diagnostic = registry.diagnose({ sessionId: session.sessionId, integratedRevision });
    assert.equal(diagnostic.closeReadiness, "blocked");
    assert.equal(diagnostic.resultState, "complete");
    assert.equal(diagnostic.blockers[0]?.code, "RECOVERABLE_COMMITS");
    assert.equal(diagnostic.blockers[0]?.details.proofMethod, "tree-equivalence");
    assert.equal(diagnostic.blockers[0]?.details.proofResult, "unproven");
    assert.equal(diagnostic.blockers[0]?.details.currentSessionHead, runGit(["rev-parse", "HEAD"], fixture.worktree));
    assert.equal(diagnostic.blockers[0]?.details.suppliedIntegratedRevision, integratedRevision);
    assert.equal(diagnostic.blockers[0]?.details.resolvedIntegrationSha, integratedRevision);
    assert.equal(diagnostic.blockers[0]?.details.lineageProof, "proven");
    assert.equal(diagnostic.blockers[0]?.details.authorityProof, "proven");
    assert.equal(diagnostic.blockers[0]?.details.contentProof, "unproven");
    assert.ok(diagnostic.blockers[0]?.safeActions.includes("supply-different-integrated-revision"));

    assert.throws(
      () => registry.close({ sessionId: session.sessionId, integratedRevision }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "RECOVERABLE_COMMITS",
    );
  } finally {
    fixture.cleanup();
  }
});

test("diagnose reports OWNERSHIP_MISMATCH deterministically when the worktree checks out a different branch", () => {
  const fixture = createFixture("ownership-mismatch");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/ownership" });
    runGit(["checkout", "-b", "feature/hijacked"], fixture.worktree);

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "blocked");
    assert.equal(diagnostic.blockers[0]?.code, "OWNERSHIP_MISMATCH");
    assert.ok(diagnostic.blockers[0]?.safeActions.includes("reconcile-ownership"));

    assert.equal(registry.get(session.sessionId)?.state, "active");
    assertRegistryError(() => registry.close(session.sessionId), "OWNERSHIP_MISMATCH");
  } finally {
    runGitQuiet(["worktree", "remove", "--force", fixture.worktree], fixture.repository);
    fixture.cleanup();
  }
});

test("diagnose surfaces stale/missing worktree physical state as an immediate cleanup candidate", () => {
  const fixture = createFixture("missing-worktree");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/missing-worktree" });
    fs.rmSync(fixture.worktree, { recursive: true, force: true });

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.physicalState, "prunable-missing");
    assert.equal(diagnostic.closeReadiness, "ready");
    assert.equal(diagnostic.cleanupReadiness, "ready");

    assert.equal(registry.get(session.sessionId)?.state, "active");
  } finally {
    fixture.cleanup();
  }
});

test("diagnose reports an ambiguous result state, fail-closed, when Git worktree observation fails", () => {
  const fixture = createFixture("ambiguous");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/ambiguous" });

    const failingGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "worktree" && args[1] === "list") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "Simulated Git worktree observation failure");
        }
        return defaultGit.run(args, cwd);
      },
    };
    const guarded = new SessionRegistry({ repository: registry.repository, git: failingGit });

    const diagnostic = guarded.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "ambiguous");
    assert.equal(diagnostic.cleanupReadiness, "ambiguous");
    assert.equal(diagnostic.resultState, "ambiguous");
    assert.equal(diagnostic.blockers[0]?.code, "GIT_COMMAND_FAILED");

    // The fault-injected observation never touched real state.
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fixture.cleanup();
  }
});

// Regression (#125 acceptance criteria): an unavailable/ambiguous Git
// observation must never be misreported as a deterministic RECOVERABLE_COMMITS
// external-evidence-required block. The raw close() rejection reuses the
// same #124 ambiguity classification diagnose() reports for the identical
// fault, fails closed, and performs no mutation.
test("close reports the same ambiguous classification as diagnose, fail-closed, when Git observation is unavailable", () => {
  const fixture = createFixture("close-ambiguous");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/close-ambiguous" });

    const failingGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "worktree" && args[1] === "list") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "Simulated Git worktree observation failure");
        }
        return defaultGit.run(args, cwd);
      },
    };
    const guarded = new SessionRegistry({ repository: registry.repository, git: failingGit });

    const diagnostic = guarded.diagnose(session.sessionId);
    assert.equal(diagnostic.closeReadiness, "ambiguous");

    assert.throws(
      () => guarded.close(session.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "GIT_COMMAND_FAILED");
        assert.equal(error.details.closeReadiness, "ambiguous");
        assert.equal(error.details.resultState, "ambiguous");
        assert.notEqual(error.details.closeReadiness, "external_evidence_required");
        assert.notEqual(error.details.closeReadiness, "blocked");
        return true;
      },
    );

    // Fail-closed and non-mutating: no session/worktree/branch state changed.
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
    assert.equal(hasLocalBranch(fixture.repository, session.branchName), true);
  } finally {
    fixture.cleanup();
  }
});

test("diagnose on an already-closed session is idempotent and reports ready without re-observing Git", () => {
  const fixture = createFixture("closed-idempotent");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/closed-idempotent" });
    registry.close(session.sessionId);

    const diagnostic = registry.diagnose(session.sessionId);
    assert.equal(diagnostic.session.state, "closed");
    assert.equal(diagnostic.closeReadiness, "ready");
    assert.equal(diagnostic.cleanupReadiness, "ready");
    assert.equal(diagnostic.idempotent, true);
    assert.deepEqual(diagnostic.blockers, []);

    const repeated = registry.diagnose(session.sessionId);
    assert.deepEqual(repeated, diagnostic);
  } finally {
    fixture.cleanup();
  }
});

interface Fixture {
  readonly repository: string;
  readonly worktree: string;
  cleanup(): void;
}

function createFixture(name: string): Fixture {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `nawabari-diagnostic-${name}-`));
  const worktree = `${repository}-worktree`;
  runGit(["init", "-b", "main", repository], repository);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repository);
  runGit(["config", "user.name", "Nawabari Tests"], repository);
  runGit(["config", "commit.gpgsign", "false"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "-m", "initial"], repository);
  return {
    repository,
    worktree,
    cleanup(): void {
      runGitQuiet(["worktree", "remove", "--force", worktree], repository);
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function hasLocalBranch(repositoryPath: string, branchName: string): boolean {
  return runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath);
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function runGitQuiet(args: readonly string[], cwd: string): boolean {
  try {
    runGit(args, cwd);
    return true;
  } catch {
    return false;
  }
}
