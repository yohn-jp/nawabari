import assert from "node:assert/strict";
import test from "node:test";
import { DomainError, failure, success } from "./errors.js";
import { executeBootstrapAction, runBootstrapActions } from "./session-bootstrap.js";
import type { SessionBackend, SessionRecord } from "./session.js";
import type { WorktreeBootstrapAction } from "./worktree-runtime-profile.js";

const actions: readonly WorktreeBootstrapAction[] = [
  { id: "first", tool: "node", argv: ["--version"] },
  { id: "second", tool: "node", argv: ["--help"] },
  { id: "third", tool: "node", argv: [] },
];

test("executes declared actions in order and completes only after every success", async () => {
  const seen: string[] = [];
  const result = await runBootstrapActions(actions, async (action) => {
    seen.push(action.id);
    return success(null);
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, ["first", "second", "third"]);
});

test("unavailable protected authority returns bounded session/action evidence without persisting or launching", async () => {
  const session = {
    session_id: "pending",
    repository: "local",
    worktree: "/worktree",
    branch: "feature/bootstrap",
    state: "new",
  } as SessionRecord;
  let persisted = 0;
  const result = await executeBootstrapAction({ cwd: session.worktree }, {} as SessionBackend, session, actions[0]!, {
    verify: () => session,
    persist: async () => {
      persisted += 1;
      throw new Error("not permitted");
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.details?.session_id, "pending");
    assert.equal(result.error.details?.action_id, "first");
    assert.equal(result.error.message.length <= 2048, true);
  }
  assert.equal(persisted, 0);
});

test("stops on the first rejected or uncertain action without replaying it", async () => {
  for (const code of ["OPERATION_REJECTED", "REGISTRY_DURABILITY_UNCERTAIN"] as const) {
    const seen: string[] = [];
    const result = await runBootstrapActions(actions, async (action) => {
      seen.push(action.id);
      return action.id === "second"
        ? failure(new DomainError(code, "action did not complete", { session_id: "owned", action_id: action.id }))
        : success(null);
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.deepEqual(result.error.details, { session_id: "owned", action_id: "second" });
    assert.deepEqual(seen, ["first", "second"]);
  }
});
