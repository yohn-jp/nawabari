import assert from "node:assert/strict";
import test from "node:test";

import { createFilesystemPolicyToken } from "./domain/filesystem-policy-revision.js";
import { DomainError, failure, success } from "./domain/errors.js";
import type { SessionBackend, SessionContext, SessionVerificationSnapshot } from "./domain/session.js";
import {
  isSessionBoundPhysicalExecutionProven,
  executeSessionBoundVerification,
  getSessionVerificationSnapshot,
} from "./session-bound-verification.js";
import {
  SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
  SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID,
  describeSessionCandidateBundlePaths,
  sessionCandidateBundleRepositoryPath,
  sessionCandidateBundleStagingRootPath,
  sessionCandidateBundleTransferPath,
  stageSessionCandidateBundle,
} from "./session-candidate-bundle.js";
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

test("snapshot operation rejects an owner response for a different session", async () => {
  const wrongSession = snapshot({ session_id: "0190f1e0-0000-7000-8000-000000000002" });
  const backend = {
    getSessionVerificationSnapshot: async () => success(wrongSession),
  } as unknown as SessionBackend;

  const result = await getSessionVerificationSnapshot(context, backend, sessionId);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROJECTION_INVALID");
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

test("owner identity drift is refused before entering managed launch", async () => {
  const expected = snapshot();
  const staleSnapshots = [
    snapshot({ repository: "github.com/example/other" }),
    snapshot({
      filesystem_policy_token: {
        ...expected.filesystem_policy_token,
        claim_set_generation: 4,
      },
      managed: { ...expected.managed, claim_set_generation: 4 },
    }),
    snapshot({
      filesystem_policy_token: {
        ...expected.filesystem_policy_token,
        session_runtime_epoch: 6,
      },
      managed: { ...expected.managed, runtime_epoch: 6 },
    }),
  ];

  for (const live of staleSnapshots) {
    let managedRuntimeRead = false;
    const backend = {
      getSessionVerificationSnapshot: async () => success(live),
      getSessionManagedRuntime: async () => {
        managedRuntimeRead = true;
        throw new Error("stale owner identity must not reach managed launch");
      },
    } as unknown as SessionBackend;

    const result = await executeSessionBoundVerification(context, backend, request(expected));

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "STALE_REGISTRY");
    assert.equal(managedRuntimeRead, false);
  }
});

test("an absent owner session returns its backend failure without launch fallback", async () => {
  let managedRuntimeRead = false;
  const backend = {
    getSessionVerificationSnapshot: async () =>
      failure(new DomainError("SESSION_NOT_FOUND", "The requested session is not registered.")),
    getSessionManagedRuntime: async () => {
      managedRuntimeRead = true;
      throw new Error("an absent session must not reach managed launch");
    },
  } as unknown as SessionBackend;

  const result = await executeSessionBoundVerification(context, backend, request(snapshot()));

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SESSION_NOT_FOUND");
  assert.equal(managedRuntimeRead, false);
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

test("candidate-backed execution rejects an arbitrary nested Git cwd before staging", async () => {
  const expected = snapshot();
  let managedRuntimeRead = false;
  const backend = {
    getSessionVerificationSnapshot: async () => success(expected),
    getSessionManagedRuntime: async () => {
      managedRuntimeRead = true;
      throw new Error("candidate staging must not run for a caller-selected path");
    },
  } as unknown as SessionBackend;
  const candidateRequest = {
    ...request(expected, "/repo/worktree/caller-selected-git"),
    candidate_source: {
      candidate_id: "candidate-1",
      candidate_digest: `sha256:${"a".repeat(64)}`,
      source: {
        project_id: "project-1",
        source_id: "source-1",
        bundle_sha256: `sha256:${"b".repeat(64)}`,
        base_commit: "1".repeat(40),
        candidate_commit: "2".repeat(40),
        candidate_tree: "3".repeat(40),
      },
    },
  };

  const result = await executeSessionBoundVerification(context, backend, candidateRequest);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(managedRuntimeRead, false);
});

test("candidate bundle paths are owner-derived for one exact source and candidate", async () => {
  const expected = snapshot();
  let observedSessionId = "";
  const backend = {
    getSessionVerificationSnapshot: async (_context: SessionContext, id: string) => {
      observedSessionId = id;
      return success(expected);
    },
  } as unknown as SessionBackend;
  const candidateDigest = `sha256:${"c".repeat(64)}`;
  const bundleDigest = `sha256:${"d".repeat(64)}`;
  const request = {
    contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    schema_version: 1,
    session_id: sessionId,
    snapshot: expected,
    candidate_id: "candidate-exact-source",
    candidate_digest: candidateDigest,
    bundles: [
      {
        project_id: "project-exact",
        source_id: "source-exact",
        bundle_sha256: bundleDigest,
        base_commit: "a".repeat(40),
        candidate_commit: "b".repeat(40),
        candidate_tree: "c".repeat(40),
      },
    ],
  };

  const result = await describeSessionCandidateBundlePaths(context, backend, request);

  assert.equal(result.ok, true);
  assert.equal(observedSessionId, sessionId);
  if (!result.ok) return;
  assert.equal(result.value.contract_id, SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID);
  assert.equal(result.value.session_id, sessionId);
  assert.equal(result.value.candidate_id, request.candidate_id);
  assert.equal(result.value.candidate_digest, candidateDigest);
  assert.equal(result.value.transfers.length, 1);
  assert.deepEqual(result.value.transfers[0], {
    project_id: "project-exact",
    source_id: "source-exact",
    bundle_sha256: bundleDigest,
    staging_root: sessionCandidateBundleStagingRootPath(
      expected.worktree,
      candidateDigest,
      "project-exact",
      "source-exact",
    ),
    transfer_path: sessionCandidateBundleTransferPath(
      expected.worktree,
      candidateDigest,
      "project-exact",
      "source-exact",
      bundleDigest,
    ),
    repository_path: sessionCandidateBundleRepositoryPath(
      expected.worktree,
      candidateDigest,
      "project-exact",
      "source-exact",
    ),
  });
  assert.ok(
    result.value.transfers[0]!.staging_root.startsWith(`${expected.worktree}/.nawabari-verification-candidates/`),
  );
  assert.ok(result.value.transfers[0]!.transfer_path.startsWith(result.value.transfers[0]!.staging_root));
  assert.match(result.value.receipt_sha256, /^[0-9a-f]{64}$/u);
});

test("candidate paths and imports reject a changed owner claim generation before resolving any path", async () => {
  const expected = snapshot();
  const stale = snapshot({
    filesystem_policy_token: {
      ...expected.filesystem_policy_token,
      claim_set_generation: expected.filesystem_policy_token.claim_set_generation + 1,
    },
    managed: { ...expected.managed, claim_set_generation: expected.managed.claim_set_generation + 1 },
  });
  let pathResolutionCalls = 0;
  let launchAuthorityCalls = 0;
  const backend = {
    getSessionVerificationSnapshot: async () => {
      pathResolutionCalls += 1;
      return success(stale);
    },
    getSessionManagedRuntime: async () => {
      launchAuthorityCalls += 1;
      throw new Error("stale candidate must not enter protected launch");
    },
  } as unknown as SessionBackend;
  const candidateDigest = `sha256:${"c".repeat(64)}`;
  const candidate = {
    project_id: "project-exact",
    source_id: "source-exact",
    bundle_sha256: `sha256:${"d".repeat(64)}`,
    base_commit: "a".repeat(40),
    candidate_commit: "b".repeat(40),
    candidate_tree: "c".repeat(40),
  };
  const request = {
    contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    schema_version: 1,
    session_id: sessionId,
    snapshot: expected,
    candidate_id: "candidate-exact-source",
    candidate_digest: candidateDigest,
    bundles: [candidate],
  };

  const paths = await describeSessionCandidateBundlePaths(context, backend, request);
  const staged = await stageSessionCandidateBundle(context, backend, request);

  assert.equal(paths.ok, false);
  if (!paths.ok) assert.equal(paths.error.code, "STALE_REGISTRY");
  assert.equal(staged.ok, false);
  if (!staged.ok) assert.equal(staged.error.code, "STALE_REGISTRY");
  assert.equal(pathResolutionCalls, 2);
  assert.equal(launchAuthorityCalls, 0);
});

test("candidate path operation refuses to stage unrelated bundles into one repository session", async () => {
  const expected = snapshot();
  let snapshotReads = 0;
  const backend = {
    getSessionVerificationSnapshot: async () => {
      snapshotReads += 1;
      return success(expected);
    },
  } as unknown as SessionBackend;
  const bundle = {
    project_id: "project-exact",
    source_id: "source-exact",
    bundle_sha256: `sha256:${"d".repeat(64)}`,
    base_commit: "a".repeat(40),
    candidate_commit: "b".repeat(40),
    candidate_tree: "c".repeat(40),
  };

  const result = await describeSessionCandidateBundlePaths(context, backend, {
    contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    schema_version: 1,
    session_id: sessionId,
    snapshot: expected,
    candidate_id: "candidate-exact-source",
    candidate_digest: `sha256:${"c".repeat(64)}`,
    bundles: [bundle, { ...bundle, source_id: "source-unrelated" }],
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
  assert.equal(snapshotReads, 0, "invalid multi-source requests must be rejected before owner path resolution");
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
