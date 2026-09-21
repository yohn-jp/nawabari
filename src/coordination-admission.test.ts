import assert from "node:assert/strict";
import { test } from "node:test";
import { permitsCoordinatedWrite, type CoordinationFacts } from "./coordination-admission.js";
import { createResourceClaim } from "./resource-claims.js";

const owner = (sessionId: string, worktreePath: string) => ({ sessionId, repositoryId: "/repo/.git", worktreePath, state: "active" });

test("admits only two verified distinct worktrees in one write group", () => {
  const left = createResourceClaim({ resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } }, owner("a", "/repo/a"), "2026-01-01T00:00:00.000Z");
  const right = createResourceClaim({ resource: "src/file.ts", mode: "write", sharing: { kind: "isolated-worktree", groupId: "g" } }, owner("b", "/repo/b"), "2026-01-01T00:00:00.000Z");
  const facts: CoordinationFacts = { left, right, claimSetGeneration: 4, observedClaimSetGeneration: 4, leftIdentity: { status: "verified", repositoryId: "/repo/.git", sessionId: "a", worktreeId: "wa", worktreePath: "/repo/a" }, rightIdentity: { status: "verified", repositoryId: "/repo/.git", sessionId: "b", worktreeId: "wb", worktreePath: "/repo/b" } };
  assert.equal(permitsCoordinatedWrite(facts), "allowed");
  assert.equal(permitsCoordinatedWrite({ ...facts, rightIdentity: { ...facts.rightIdentity, status: "ambiguous" } }), "denied");
  assert.equal(permitsCoordinatedWrite({ ...facts, observedClaimSetGeneration: 3 }), "denied");
  assert.equal(permitsCoordinatedWrite({ ...facts, leftIdentity: { ...facts.leftIdentity, worktreePath: "/repo/other" } }), "denied");
});
