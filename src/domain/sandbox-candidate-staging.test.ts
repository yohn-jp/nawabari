import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SandboxExecutionRequest } from "./sandbox.js";
import { candidateStagingSelectorMayOverlap, resolveOwnerCandidateStagingRoot } from "./sandbox-candidate-staging.js";

test("candidate scratch is fixed, owner-private, and cannot override immutable or denied paths", () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-candidate-scratch-"));
  const relative = `.nawabari-verification-candidates/${"a".repeat(64)}/${"b".repeat(24)}`;
  const scratch = path.join(worktree, relative);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const request = {
    worktree,
    owner_candidate_staging: { candidate_digest: `sha256:${"a".repeat(64)}`, source_key: "b".repeat(24) },
    runtime_projection: { policy: { mode: "strict" }, working_set: { scope: { deny: [] } } },
    git_profile: { filesystem: { deny: [".git/**"], immutable: [".git/**"] } },
    compiled_session_environment: {},
  } as unknown as SandboxExecutionRequest;
  try {
    assert.deepEqual(resolveOwnerCandidateStagingRoot(request), { ok: true, value: scratch });
    for (const selector of ["**", ".nawabari*", ".nawabari-verification-candidates/**", `${relative}/repo/**`]) {
      const denied = {
        ...request,
        git_profile: {
          ...request.git_profile!,
          filesystem: { ...request.git_profile!.filesystem, immutable: [selector] },
        },
      };
      assert.equal(resolveOwnerCandidateStagingRoot(denied).ok, false, selector);
    }
    const noWorkingSet = { ...request, runtime_projection: { ...request.runtime_projection!, working_set: undefined } };
    assert.equal(resolveOwnerCandidateStagingRoot(noWorkingSet).ok, false);
    assert.equal(resolveOwnerCandidateStagingRoot({ ...request, owner_candidate_staging: undefined }).ok, true);
    fs.mkdirSync(path.join(scratch, "repo/.git"), { recursive: true, mode: 0o700 });
    const verification = {
      candidate_digest: `sha256:${"a".repeat(64)}`,
      source_key: "b".repeat(24),
      head_id: "c".repeat(40),
      tree_id: "d".repeat(40),
      base_commit: "e".repeat(40),
    };
    const readonlyRequest = {
      ...request,
      owner_candidate_staging: undefined,
      owner_candidate_verification: verification,
    };
    assert.deepEqual(resolveOwnerCandidateStagingRoot(readonlyRequest), { ok: true, value: scratch });
    assert.equal(
      resolveOwnerCandidateStagingRoot({ ...request, owner_candidate_verification: verification }).ok,
      false,
    );
    assert.equal(
      resolveOwnerCandidateStagingRoot({
        ...readonlyRequest,
        owner_candidate_verification: { ...verification, base_commit: "unknown" },
      }).ok,
      false,
    );
    fs.rmSync(path.join(scratch, "repo"), { recursive: true, force: true });
    fs.chmodSync(scratch, 0o755);
    assert.equal(resolveOwnerCandidateStagingRoot(request).ok, false);
    fs.chmodSync(scratch, 0o700);
    fs.rmdirSync(scratch);
    fs.symlinkSync(worktree, scratch, "dir");
    assert.equal(resolveOwnerCandidateStagingRoot(request).ok, false);
  } finally {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("scratch deny intersection refuses wildcard uncertainty and permits unrelated exact selectors", () => {
  const scratch = `.nawabari-verification-candidates/${"a".repeat(64)}/${"b".repeat(24)}`;
  for (const selector of ["**/secret", ".nawabari*", ".nawabari-verification-candidates/**", `${scratch}/repo/.git/**`])
    assert.equal(candidateStagingSelectorMayOverlap(selector, scratch), true);
  for (const selector of ["README.md", ".git/**", "src/**"])
    assert.equal(candidateStagingSelectorMayOverlap(selector, scratch), false);
});
