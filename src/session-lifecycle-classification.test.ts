import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifySessionLifecycle,
  lifecycleTransition,
  SESSION_LIFECYCLE_STATES,
  SESSION_LIFECYCLE_TRANSITION_TABLE,
} from "./session-lifecycle-classification.js";
import { SessionRegistry } from "./session-registry.js";

test("classifies an owned session as active until termination evidence is requested", () => {
  const current = classifySessionLifecycle({ sessionState: "active", physicalState: "healthy" });
  assert.equal(current.state, "active");
  assert.equal(current.recoverability, "none");
  assert.equal(current.destructiveCleanupEligible, false);

  const ready = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    phase: "termination",
  });
  assert.equal(ready.state, "close-ready");
  assert.equal(lifecycleTransition(ready, "close").allowed, true);
  assert.equal(lifecycleTransition(ready, "close").target, "closed");
});

test("keeps recoverable work distinct from ambiguous physical identity", () => {
  const recoverable = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "external_evidence_required",
    blockers: [{ code: "RECOVERABLE_COMMITS" }],
    phase: "termination",
  });
  assert.equal(recoverable.state, "blocked-recoverable");
  assert.equal(recoverable.recoverability, "recoverable");
  assert.equal(lifecycleTransition(recoverable, "close").allowed, false);
  assert.equal(lifecycleTransition(recoverable, "discard").requiresExplicitIntent, true);

  const ambiguous = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ambiguous",
    blockers: [{ code: "OWNERSHIP_MISMATCH" }],
    phase: "termination",
  });
  assert.equal(ambiguous.state, "stale-inconsistent");
  assert.equal(ambiguous.recoverability, "ambiguous");
  assert.equal(lifecycleTransition(ambiguous, "discard").allowed, false);
});

test("explicit discard and closed records are terminal and distinguishable", () => {
  const discarded = classifySessionLifecycle({
    sessionState: "closing",
    physicalState: "healthy",
    terminalOperation: "discard",
  });
  assert.equal(discarded.state, "discarded");
  assert.equal(lifecycleTransition(discarded, "discard").allowed, true);
  assert.equal(lifecycleTransition(discarded, "close").allowed, false);

  const closed = classifySessionLifecycle({
    sessionState: "closed",
    physicalState: "closed",
    closeReadiness: "ready",
    phase: "termination",
  });
  assert.equal(closed.state, "closed");
  assert.equal(lifecycleTransition(closed, "close").allowed, true);
  assert.equal(lifecycleTransition(closed, "close").reason, "closed-terminal");
});

test("age is diagnostic suspicion only for a healthy active session", () => {
  const classification = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    ageSuspicious: true,
    phase: "current",
  });
  assert.equal(classification.state, "active");
  assert.equal(classification.ageSuspicious, true);
  assert.equal(classification.gcAuthorized, false);
  assert.equal(classification.destructiveCleanupEligible, false);
  assert.equal(lifecycleTransition(classification, "gc").allowed, false);
});

test("accepts an independent GC authority without treating age as its source", () => {
  const classification = classifySessionLifecycle({
    sessionState: "stale",
    physicalState: "healthy",
    closeReadiness: "ready",
    gcAuthorized: true,
    phase: "termination",
  });
  assert.equal(classification.state, "close-ready");
  assert.equal(classification.gcAuthorized, true);
  assert.equal(classification.destructiveCleanupEligible, true);
  assert.equal(lifecycleTransition(classification, "gc").allowed, true);

  const ageOnly = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    ageSuspicious: true,
    gcAuthorized: true,
    phase: "termination",
  });
  assert.equal(ageOnly.state, "close-ready");
  assert.equal(ageOnly.destructiveCleanupEligible, false);
  assert.equal(lifecycleTransition(ageOnly, "gc").allowed, false);
});

test("unknown lifecycle evidence fails closed as stale/inconsistent", () => {
  assert.equal(classifySessionLifecycle({ sessionState: "active" }).state, "stale-inconsistent");
  assert.equal(
    classifySessionLifecycle({ sessionState: "active", physicalState: "healthy", closeReadiness: "ambiguous" }).state,
    "stale-inconsistent",
  );
  assert.equal(
    classifySessionLifecycle({ sessionState: "active", physicalState: "healthy", closeReadiness: "blocked" }).state,
    "stale-inconsistent",
  );
  assert.equal(
    classifySessionLifecycle({ sessionState: "future-state", physicalState: "future-physical" }).state,
    "stale-inconsistent",
  );
  assert.equal(
    classifySessionLifecycle({
      sessionState: "active",
      physicalState: "healthy",
      blockers: [{ code: "FUTURE_BLOCKER" }],
    }).state,
    "stale-inconsistent",
  );
  assert.equal(
    classifySessionLifecycle({
      sessionState: "active",
      physicalState: "healthy",
      blockers: [{ code: "RECONCILIATION_DRIFT", classification: "stale" }],
    }).state,
    "stale-inconsistent",
  );
});

test("publishes a complete typed transition table", () => {
  for (const state of SESSION_LIFECYCLE_STATES) {
    const transitions = SESSION_LIFECYCLE_TRANSITION_TABLE[state];
    assert.deepEqual(transitions.map((transition) => transition.operation).sort(), [
      "close",
      "discard",
      "doctor",
      "gc",
      "inspect",
      "reconcile",
    ]);
  }
});

test("registry classification reuses diagnostic authority without mutation", () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-lifecycle-classification-"));
  const worktree = `${repository}-worktree`;
  try {
    runGit(["init", "-b", "main", repository], repository);
    runGit(["config", "user.email", "nawabari-tests@example.invalid"], repository);
    runGit(["config", "user.name", "Nawabari Tests"], repository);
    fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
    runGit(["add", "README.md"], repository);
    runGit(["commit", "-m", "initial"], repository);

    const registry = new SessionRegistry({ cwd: repository });
    const session = registry.provision({ worktreePath: worktree, branchName: "feature/classification" });
    const before = fs.readFileSync(registry.paths.registry, "utf8");
    assert.equal(registry.classifyLifecycle(session.sessionId).state, "active");
    assert.equal(
      registry.classifyLifecycle({ sessionId: session.sessionId, phase: "termination" }).state,
      "close-ready",
    );
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), before);

    fs.writeFileSync(path.join(worktree, "recoverable.txt"), "preserve\n");
    const blocked = registry.classifyLifecycle({ sessionId: session.sessionId, phase: "termination" });
    assert.equal(blocked.state, "blocked-recoverable");
    assert.equal(blocked.recoverability, "recoverable");

    registry.discard(session.sessionId);
    assert.equal(registry.classifyLifecycle(session.sessionId).state, "discarded");
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktree], repository);
    } catch {
      // The worktree may already have been removed by explicit discard.
    }
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}
