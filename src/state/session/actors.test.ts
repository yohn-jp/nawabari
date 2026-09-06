import assert from "node:assert/strict";
import test from "node:test";

import { executeSessionLifecycleActor, type SessionActorReconciliation, type SessionActorResult } from "./actors.js";
import type { SessionMachineInput } from "./types.js";

function input(
  observation: Partial<SessionMachineInput["observation"]> = {},
  sessionState: "active" | "closing" | "closed" | "stale" = "active",
): SessionMachineInput {
  return {
    persisted: { sessionId: "actor-test-session", state: sessionState },
    observation: {
      sessionState,
      physicalState: sessionState === "closed" ? "closed" : "healthy",
      closeReadiness: "ready",
      phase: "termination",
      ...observation,
    },
  };
}

test("coordinates observe, machine evaluation, bounded effect, re-observation, and finalization", () => {
  const stages: string[] = [];
  const result = executeSessionLifecycleActor({
    operation: "close",
    adapter: {
      observe: (stage) => {
        stages.push(stage);
        return stage === "before" ? input() : input({ sessionState: "closed", physicalState: "closed" }, "closed");
      },
      effect: (decision) => {
        stages.push(`effect:${decision.eventType}`);
        return "closed";
      },
    },
  });

  assert.equal(result.phase, "completed");
  assert.equal(result.value, "closed");
  assert.deepEqual(stages, ["before", "effect:SESSION.CLOSE.REQUESTED", "after"]);
  assert.equal(result.decision.allowed, true);
  assert.equal(result.after?.observation.sessionState, "closed");
});

test("keeps explicit discard separate from normal close and does not execute a forbidden transition", () => {
  let effectCalls = 0;
  const result = executeSessionLifecycleActor({
    operation: "close",
    adapter: {
      observe: () => input({ terminalOperation: "discard" }),
      effect: () => {
        effectCalls += 1;
        return undefined;
      },
    },
  });

  assert.equal(result.phase, "rejected");
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.requiresExplicitIntent, false);
  assert.equal(effectCalls, 0);

  const discard = executeSessionLifecycleActor({
    operation: "discard",
    adapter: {
      observe: () => input({ blockers: [{ code: "RECOVERABLE_COMMITS" }] }),
      effect: (decision) => decision.requiresExplicitIntent,
    },
  });
  assert.equal(discard.phase, "completed");
  assert.equal(discard.decision.requiresExplicitIntent, true);
});

test("routes effect failures through explicit reconciliation outcomes", () => {
  const reconciliation: SessionActorReconciliation = { outcome: "retryable", retrySafe: true };
  let afterObserved = false;
  const result = executeSessionLifecycleActor({
    operation: "close",
    adapter: {
      observe: (stage) => {
        afterObserved ||= stage === "after";
        return input();
      },
      effect: () => {
        throw new Error("partial cleanup");
      },
      reconcile: (_error, after) => {
        assert.ok(after !== undefined);
        return reconciliation;
      },
    },
  });

  assert.equal(afterObserved, true);
  assert.equal(result.phase, "retryable");
  assert.equal(result.reconciliation?.retrySafe, true);
  assert.match(String((result.error as Error).message), /partial cleanup/u);
});

test("uses the cleanup retry event only after a re-observed closing record", () => {
  const calls: string[] = [];
  const result = executeSessionLifecycleActor({
    operation: "close",
    retry: true,
    adapter: {
      retryAuthorized: () => true,
      observe: (stage) => {
        calls.push(stage);
        return input({ sessionState: "closing", physicalState: "prunable-missing" }, "closing");
      },
      effect: () => {
        calls.push("effect");
        return true;
      },
    },
  });

  assert.equal(result.phase, "completed");
  assert.equal(result.decision.mode, "retry");
  assert.equal(result.decision.eventType, "SESSION.CLEANUP.RETRY");
  assert.deepEqual(calls, ["before", "effect", "after"]);
});

test("ambiguous observations cannot be retried", () => {
  let effectCalls = 0;
  const result: SessionActorResult<undefined> = executeSessionLifecycleActor({
    operation: "close",
    retry: true,
    adapter: {
      observe: () => input({ closeReadiness: "ambiguous", physicalState: "registered-missing" }, "closing"),
      effect: () => {
        effectCalls += 1;
        return undefined;
      },
    },
  });
  assert.equal(result.phase, "rejected");
  assert.equal(effectCalls, 0);
});
