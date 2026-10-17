import assert from "node:assert/strict";
import test from "node:test";

import { createFilesystemPolicyToken } from "./domain/filesystem-policy-revision.js";
import { success } from "./domain/errors.js";
import type { SessionBackend, SessionContext, SessionVerificationSnapshot } from "./domain/session.js";
import {
  isSessionBoundPhysicalExecutionProven,
  executeSessionBoundVerification,
  getSessionVerificationSnapshot,
} from "./session-bound-verification.js";
import { sandboxExecutionMockSuccess } from "./testing/sandbox-execution-evidence-mock.js";

const sessionId = "0190f1e0-0000-7000-8000-000000000001";
const context: SessionContext = { cwd: "/repo" };

function snapshot(overrides: Partial<SessionVerificationSnapshot> = {}): SessionVerificationSnapshot {
  const token = createFilesystemPolicyToken({
    registry_revision: 7,
    session_runtime_epoch: 5,
    claim_set_generation: 3,
    working_set_revision: 2,
    profile_digest: "a".repeat(64),
    session_id: sessionId,
  });
  if (!token.ok) throw token.error;
  return {
    contract_id: "nawabari.session-verification-snapshot.v1",
    schema_version: 1,
    session_id: sessionId,
    repository: "github.com/example/repository",
    worktree: "/repo/worktree",
    branch: "nawabari/session/test",
    state: "active",
    filesystem_policy_token: token.value,
    managed: {
      profile_digest: "a".repeat(64),
      admission: "open",
      runtime_epoch: 5,
      registry_revision: 7,
      claim_set_generation: 3,
    },
    ...overrides,
  };
}

function request(ownerSnapshot: SessionVerificationSnapshot, cwd = "/repo/worktree/candidate") {
  return {
    contract_id: "nawabari.session-bound-verification.v1",
    schema_version: 1,
    session_id: sessionId,
    snapshot: ownerSnapshot,
    profile: {
      contract_id: "nawabari.verification-profile.v1",
      schema_version: 1,
      profile_id: "candidate-check",
      profile_version: "1",
      executable: "/nix/store/test/bin/check",
      argv: ["--verify"],
      cwd,
      read_visibility: "declared" as const,
      declared_read: ["src/**"],
      write_policy: "deny" as const,
      timeout_ms: 10_000,
      max_output_bytes: 16_384,
    },
  };
}

test("session snapshot operation returns the exact active owner projection", async () => {
  const expected = snapshot();
  let observedSessionId = "";
  const backend = {
    getSessionVerificationSnapshot: async (_context: SessionContext, id: string) => {
      observedSessionId = id;
      return success(expected);
    },
  } as unknown as SessionBackend;

  const result = await getSessionVerificationSnapshot(context, backend, sessionId);

  assert.equal(result.ok, true);
  assert.equal(observedSessionId, sessionId);
  if (result.ok) assert.deepEqual(result.value, expected);
});

test("a stale owner snapshot is refused before entering managed launch", async () => {
  const expected = snapshot();
  const live = snapshot({
    filesystem_policy_token: { ...expected.filesystem_policy_token, registry_revision: 8 },
    managed: { ...expected.managed, registry_revision: 8 },
  });
  let launchAuthorityRead = false;
  const backend = {
    getSessionVerificationSnapshot: async () => success(live),
    getSessionManagedRuntime: async () => {
      launchAuthorityRead = true;
      throw new Error("stale request must not reach managed launch");
    },
  } as unknown as SessionBackend;

  const result = await executeSessionBoundVerification(context, backend, request(expected));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "STALE_REGISTRY");
  assert.equal(launchAuthorityRead, false);
});

test("a candidate cwd outside the owned session worktree is refused", async () => {
  let snapshotRead = false;
  const backend = {
    getSessionVerificationSnapshot: async () => {
      snapshotRead = true;
      return success(snapshot());
    },
  } as unknown as SessionBackend;

  const result = await executeSessionBoundVerification(context, backend, request(snapshot(), "/repo/worktree-escape"));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(snapshotRead, false);
});

test("closed managed admission is refused before launch", async () => {
  const ownerSnapshot = snapshot({ managed: { ...snapshot().managed, admission: "closed" } });
  let managedRuntimeRead = false;
  const backend = {
    getSessionVerificationSnapshot: async () => success(ownerSnapshot),
    getSessionManagedRuntime: async () => {
      managedRuntimeRead = true;
      throw new Error("closed admission must not launch");
    },
  } as unknown as SessionBackend;

  const result = await executeSessionBoundVerification(context, backend, request(ownerSnapshot));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_REJECTED");
  assert.equal(managedRuntimeRead, false);
});

test("unknown physical cleanup can never qualify session-bound verification", () => {
  const fake = sandboxExecutionMockSuccess({
    exit_code: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    duration_ms: 1,
  });
  assert.equal(fake.ok, true);
  if (!fake.ok) return;
  assert.equal(fake.value.physical_execution.cleanup.state, "unknown");
  assert.equal(
    isSessionBoundPhysicalExecutionProven({ schema_version: 1, ...fake.value }, fake.value.execution_id),
    false,
  );
});
