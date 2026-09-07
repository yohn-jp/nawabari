import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  availableNawabariCommands,
  classifyNawabariState,
  getNawabariSessionStateSnapshot,
  NAWABARI_LIFECYCLE_STATES,
  NAWABARI_STATE_API_SCHEMA_VERSION,
  NAWABARI_TRANSITION_TABLE,
  nawabariTransitionDecision,
} from "./public-state.js";
import { SESSION_LIFECYCLE_STATES, SESSION_LIFECYCLE_TRANSITION_TABLE } from "./session-lifecycle-classification.js";
import { SessionRegistry } from "./session-registry.js";

const FORBIDDEN_XSTATE_SURFACE = /\b(?:ActorRef|Snapshot|StateValue|createActor|createMachine)\b/u;
const FORBIDDEN_INTERNAL_IMPORT =
  /from\s*["']\.\/state\/session\/(?:machine|actors|types)\.js["']|from\s*["']xstate["']/u;

test("public-state module never exports raw XState runtime objects or imports internal state modules", () => {
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./public-state.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, FORBIDDEN_XSTATE_SURFACE);
  assert.doesNotMatch(source, FORBIDDEN_INTERNAL_IMPORT);
});

test("public lifecycle vocabulary re-exports the canonical #256 projection identically", () => {
  assert.deepEqual([...NAWABARI_LIFECYCLE_STATES], [...SESSION_LIFECYCLE_STATES]);
  assert.equal(NAWABARI_TRANSITION_TABLE, SESSION_LIFECYCLE_TRANSITION_TABLE);
  assert.equal(NAWABARI_STATE_API_SCHEMA_VERSION, 1);
});

test("classifyNawabariState/nawabariTransitionDecision/availableNawabariCommands classify a pure observation", () => {
  const snapshot = classifyNawabariState({ sessionState: "active", physicalState: "healthy" });
  assert.equal(snapshot.state, "active");
  assert.deepEqual([...availableNawabariCommands(snapshot)].sort(), [
    "close",
    "discard",
    "doctor",
    "inspect",
    "reconcile",
  ]);

  const closeDecision = nawabariTransitionDecision(snapshot, "close");
  assert.equal(closeDecision.allowed, true);
  assert.equal(closeDecision.target, "close-ready");

  const gcDecision = nawabariTransitionDecision(snapshot, "gc");
  assert.equal(gcDecision.allowed, false);
  assert.equal(gcDecision.reason, "age-is-not-destructive-authority");
});

test("getNawabariSessionStateSnapshot observes a real session without CLI parsing or mutation", () => {
  const fixture = createFixture("public-state-snapshot");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({ worktreePath: fixture.worktree, branchName: "feature/public-state-snapshot" });

    const currentSnapshot = getNawabariSessionStateSnapshot({ cwd: fixture.repository, sessionId: session.sessionId });
    assert.equal(currentSnapshot.state, "active");
    assert.equal(currentSnapshot.sessionState, "active");
    assert.equal(availableNawabariCommands(currentSnapshot).includes("close"), true);

    const terminationSnapshot = getNawabariSessionStateSnapshot({
      cwd: fixture.repository,
      sessionId: session.sessionId,
      phase: "termination",
    });
    assert.equal(terminationSnapshot.state, "close-ready");
    assert.equal(terminationSnapshot.closeReadiness, "ready");

    // Purely observational: the same underlying session is still active.
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
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
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `nawabari-public-state-${name}-`));
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
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: repository, stdio: "ignore" });
      } catch {
        // Best-effort; the recursive removal below still cleans up.
      }
      fs.rmSync(worktree, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
