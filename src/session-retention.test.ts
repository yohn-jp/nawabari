import assert from "node:assert/strict";
import test from "node:test";

import {
  type ParkCommitInput,
  parkSession,
  type RetainedClaimIntent,
  type RetentionCommitResult,
  type RetentionDrainResult,
  type RetentionFenceResult,
  type RetentionReobservation,
  resumeSession,
  type ResumeCommitInput,
  type ResumeValidationInput,
  type ResumeValidationResult,
  type SessionPhysicalIdentity,
  type SessionRetentionAuthority,
  type SessionRetentionRecord,
  type SessionRetentionSession,
  type SessionRetentionSnapshot,
  SessionRetentionError,
} from "./session-retention.js";
import type { ResourceClaim } from "./resource-claims.js";

const physical: SessionPhysicalIdentity = Object.freeze({
  repositoryId: "repo-1",
  worktreeId: "worktree-1",
  worktreePath: "/tmp/nawabari/session-1",
  branchId: "refs/heads/nawabari/session-1",
  branchName: "nawabari/session-1",
});

function claim(claimId: string, sessionId: string, resource: string, mode: ResourceClaim["mode"]): ResourceClaim {
  return {
    schemaVersion: 2,
    claimId,
    sessionId,
    repositoryId: "repo-1",
    worktreePath: physical.worktreePath,
    resource,
    mode,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

function session(state: SessionRetentionSession["state"]): SessionRetentionSession {
  return { sessionId: "session-1", state, physicalIdentity: physical };
}

class FakeRetentionAuthority implements SessionRetentionAuthority {
  public current: SessionRetentionSnapshot;
  public events: string[] = [];
  public parkCommits: ParkCommitInput[] = [];
  public resumeCommits: ResumeCommitInput[] = [];
  public failFence = false;
  public failDrain = false;
  public conflict = false;
  public rejectAtomicResume = false;
  public uncertainPark = false;
  public uncertainResume = false;
  public reobservations: string[] = [];

  public constructor() {
    this.current = {
      session: session("active"),
      claims: [
        claim("claim-1", "session-1", "src/a.ts", "write"),
        claim("claim-other", "session-2", "src/b.ts", "exclusive-write"),
      ],
      claimSetGeneration: 4,
    };
  }

  public observe(sessionId: string): SessionRetentionSnapshot {
    assert.equal(sessionId, "session-1");
    this.events.push("observe");
    return this.current;
  }

  public fence(_input: { readonly sessionId: string; readonly operationId: string }): RetentionFenceResult {
    this.events.push("fence");
    return this.failFence
      ? { accepted: false, code: "FENCE_REJECTED", reason: "execution admission remained open" }
      : { accepted: true, token: "fence-token" };
  }

  public drain(_input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly fenceToken: string;
  }): RetentionDrainResult {
    this.events.push("drain");
    return this.failDrain
      ? { accepted: false, code: "DRAIN_INCOMPLETE", reason: "one execution is still running" }
      : { drained: true, executionCount: 2 };
  }

  public revalidate(_input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly fenceToken: string;
  }): SessionRetentionSnapshot {
    this.events.push("revalidate");
    return this.current;
  }

  public atomicPark(input: ParkCommitInput): RetentionCommitResult {
    this.events.push("atomic-park");
    this.parkCommits.push(input);
    assert.equal(input.expectedClaimSetGeneration, this.current.claimSetGeneration);
    assert.deepEqual(input.releaseClaimIds, ["claim-1"]);
    const record: SessionRetentionRecord = {
      schemaVersion: 1,
      operationId: input.operationId,
      sessionId: input.sessionId,
      repositoryId: physical.repositoryId,
      state: "parked",
      physicalIdentity: physical,
      desiredClaims: input.desiredClaims,
      pinnedProfileDigest: input.pinnedProfileDigest,
      parkedAt: input.parkedAt,
      updatedAt: input.parkedAt,
    };
    this.current = {
      session: session("parked"),
      claims: this.current.claims.filter((candidate) => candidate.sessionId !== input.sessionId),
      claimSetGeneration: this.current.claimSetGeneration + 1,
      retention: record,
    };
    return this.uncertainPark
      ? { status: "uncertain", operationId: input.operationId, reason: "post-rename durability was not proven" }
      : {
          status: "committed",
          operationId: input.operationId,
          snapshot: this.current,
          releasedClaims: [claim("claim-1", "session-1", "src/a.ts", "write")],
        };
  }

  public validateResume(input: ResumeValidationInput): ResumeValidationResult {
    this.events.push("validate-resume");
    assert.equal(input.latestExternalScope, "scope-v2");
    return this.conflict
      ? { accepted: false, code: "CLAIM_CONFLICT", reason: "src/a.ts is owned by session-2" }
      : { accepted: true, token: `validation-${input.snapshot.claimSetGeneration}` };
  }

  public atomicResume(input: ResumeCommitInput): RetentionCommitResult {
    this.events.push("atomic-resume");
    this.resumeCommits.push(input);
    assert.equal(input.expectedClaimSetGeneration, this.current.claimSetGeneration);
    if (this.rejectAtomicResume) {
      return {
        status: "rejected",
        operationId: input.operationId,
        code: "STALE_CLAIM_SET",
        reason: "claim generation advanced while resume was being committed",
      };
    }
    const resumed = claim("claim-reacquired", input.sessionId, "src/a.ts", "write");
    this.current = {
      session: session("active"),
      claims: [...this.current.claims, resumed],
      claimSetGeneration: this.current.claimSetGeneration + 1,
    };
    return this.uncertainResume
      ? { status: "uncertain", operationId: input.operationId, reason: "registry durability was not proven" }
      : { status: "committed", operationId: input.operationId, snapshot: this.current, reacquiredClaims: [resumed] };
  }

  public reobserve(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly operation: "park" | "resume";
  }): RetentionReobservation {
    this.events.push("reobserve");
    this.reobservations.push(input.operationId);
    return {
      status: "resolved",
      operationId: input.operationId,
      state: this.current.session.state,
      snapshot: this.current,
    };
  }
}

function park(authority: FakeRetentionAuthority, desiredClaims?: readonly ResourceClaim[]) {
  return parkSession(authority, {
    sessionId: "session-1",
    pinnedProfile: { profile: "strict", revision: 3 },
    desiredClaims,
    operationId: "park-op-1",
    now: "2026-09-21T01:00:00.000Z",
  });
}

function resume(authority: FakeRetentionAuthority) {
  return resumeSession(authority, {
    sessionId: "session-1",
    pinnedProfile: { revision: 3, profile: "strict" },
    latestExternalScope: "scope-v2",
    operationId: "resume-op-1",
  });
}

test("park fences, drains, revalidates, and releases all target claims in one atomic operation", () => {
  const authority = new FakeRetentionAuthority();
  const result = park(authority, [claim("claim-1", "session-1", "src/a.ts", "write")]);

  assert.equal(result.status, "parked");
  assert.deepEqual(authority.events, ["observe", "fence", "drain", "revalidate", "atomic-park"]);
  assert.equal(authority.parkCommits.length, 1);
  assert.equal(authority.current.session.state, "parked");
  assert.equal(
    authority.current.claims.some((candidate) => candidate.sessionId === "session-1"),
    false,
  );
  assert.equal(
    authority.current.claims.some((candidate) => candidate.sessionId === "session-2"),
    true,
  );
  assert.deepEqual(authority.current.retention?.desiredClaims, [{ resource: "src/a.ts", mode: "write" }]);
  assert.equal(authority.current.session.physicalIdentity.worktreePath, physical.worktreePath);
});

test("park stops before mutation when the execution fence or drain is not proven", () => {
  const fenceAuthority = new FakeRetentionAuthority();
  fenceAuthority.failFence = true;
  assert.throws(
    () => park(fenceAuthority),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "FENCE_REJECTED",
  );
  assert.deepEqual(fenceAuthority.events, ["observe", "fence"]);
  assert.equal(fenceAuthority.parkCommits.length, 0);

  const drainAuthority = new FakeRetentionAuthority();
  drainAuthority.failDrain = true;
  assert.throws(
    () => park(drainAuthority),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "DRAIN_INCOMPLETE",
  );
  assert.deepEqual(drainAuthority.events, ["observe", "fence", "drain"]);
  assert.equal(drainAuthority.parkCommits.length, 0);
});

test("park requires the canonical millisecond ISO timestamp shape", () => {
  const authority = new FakeRetentionAuthority();
  assert.throws(
    () =>
      parkSession(authority, {
        sessionId: "session-1",
        pinnedProfile: { profile: "strict", revision: 3 },
        operationId: "park-op-timestamp",
        now: "0",
      }),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "INVALID_INPUT",
  );
  assert.deepEqual(authority.events, []);
  assert.equal(authority.parkCommits.length, 0);
});

test("resume leaves parked state unchanged when the all-claims validation finds a conflict", () => {
  const authority = new FakeRetentionAuthority();
  park(authority);
  authority.conflict = true;
  assert.throws(
    () => resume(authority),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "CLAIM_CONFLICT",
  );
  assert.equal(authority.current.session.state, "parked");
  assert.equal(
    authority.current.claims.some((candidate) => candidate.sessionId === "session-1"),
    false,
  );
  assert.equal(authority.resumeCommits.length, 0);
});

test("resume CAS rejection leaves the parked record and claim set untouched", () => {
  const authority = new FakeRetentionAuthority();
  park(authority);
  authority.rejectAtomicResume = true;
  const before = authority.current;
  assert.throws(
    () => resume(authority),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "STALE_CLAIM_SET",
  );
  assert.deepEqual(authority.current, before);
  assert.equal(authority.current.session.state, "parked");
  assert.equal(
    authority.current.claims.some((candidate) => candidate.sessionId === "session-1"),
    false,
  );
});

test("resume validates the pinned profile and latest external scope before one CAS commit", () => {
  const authority = new FakeRetentionAuthority();
  park(authority);
  const result = resume(authority);

  assert.equal(result.status, "resumed");
  assert.deepEqual(authority.events.slice(-2), ["validate-resume", "atomic-resume"]);
  assert.equal(authority.resumeCommits.length, 1);
  assert.equal(authority.current.session.state, "active");
  assert.equal(authority.current.retention, undefined);
  assert.equal(authority.current.claims.filter((candidate) => candidate.sessionId === "session-1").length, 1);
  assert.equal(authority.current.claims.filter((candidate) => candidate.sessionId === "session-2").length, 1);
});

test("profile, physical identity, and missing scope evidence fail closed without claim mutation", () => {
  const profileAuthority = new FakeRetentionAuthority();
  park(profileAuthority);
  assert.throws(
    () =>
      resumeSession(profileAuthority, {
        sessionId: "session-1",
        pinnedProfile: { profile: "compatibility", revision: 3 },
        latestExternalScope: "scope-v2",
        operationId: "resume-op-profile",
      }),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "PINNED_PROFILE_MISMATCH",
  );
  assert.equal(profileAuthority.resumeCommits.length, 0);

  const physicalAuthority = new FakeRetentionAuthority();
  park(physicalAuthority);
  physicalAuthority.current = {
    ...physicalAuthority.current,
    session: { ...physicalAuthority.current.session, physicalIdentity: { ...physical, branchName: "replaced" } },
  };
  assert.throws(
    () => resume(physicalAuthority),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "PHYSICAL_IDENTITY_MISMATCH",
  );
  assert.equal(physicalAuthority.resumeCommits.length, 0);

  const scopeAuthority = new FakeRetentionAuthority();
  park(scopeAuthority);
  assert.throws(
    () =>
      resumeSession(scopeAuthority, {
        sessionId: "session-1",
        pinnedProfile: { profile: "strict", revision: 3 },
        latestExternalScope: undefined,
        operationId: "resume-op-scope",
      }),
    (error: unknown) => error instanceof SessionRetentionError && error.code === "EXTERNAL_SCOPE_REJECTED",
  );
  assert.equal(scopeAuthority.resumeCommits.length, 0);
});

test("uncertain atomic writes are resolved by operation ID and registry re-observation", () => {
  const authority = new FakeRetentionAuthority();
  authority.uncertainPark = true;
  const result = park(authority);

  assert.equal(result.status, "parked");
  assert.equal(result.reconciliation?.status, "resolved");
  assert.deepEqual(authority.reobservations, ["park-op-1"]);
  assert.equal(authority.current.session.state, "parked");
  assert.equal(
    authority.current.claims.some((candidate) => candidate.sessionId === "session-1"),
    false,
  );
});

test("uncertain park does not succeed from a matching state without matching operation and retention evidence", () => {
  const operationAuthority = new FakeRetentionAuthority();
  operationAuthority.uncertainPark = true;
  operationAuthority.reobserve = (input) => ({
    status: "resolved",
    operationId: "different-operation",
    state: "parked",
    snapshot: operationAuthority.current,
  });
  const operationResult = park(operationAuthority);
  assert.equal(operationResult.status, "uncertain");
  assert.equal(operationResult.reconciliation?.status, "unknown");
  assert.match(operationResult.reason ?? "", /operation identity mismatch/u);

  const retentionAuthority = new FakeRetentionAuthority();
  retentionAuthority.uncertainPark = true;
  retentionAuthority.reobserve = (input) => ({
    status: "resolved",
    operationId: input.operationId,
    state: "parked",
    snapshot: { ...retentionAuthority.current, retention: undefined },
  });
  const retentionResult = park(retentionAuthority);
  assert.equal(retentionResult.status, "uncertain");
  assert.equal(retentionResult.reconciliation?.status, "unknown");
  assert.match(retentionResult.reason ?? "", /retention record is absent/u);
});

test("uncertain resume requires its operation/session identity and removal of the retention record", () => {
  const sessionAuthority = new FakeRetentionAuthority();
  park(sessionAuthority);
  sessionAuthority.uncertainResume = true;
  sessionAuthority.reobserve = (input) => ({
    status: "resolved",
    operationId: input.operationId,
    state: "active",
    snapshot: { ...sessionAuthority.current, session: { ...sessionAuthority.current.session, sessionId: "session-2" } },
  });
  const sessionResult = resume(sessionAuthority);
  assert.equal(sessionResult.status, "uncertain");
  assert.equal(sessionResult.reconciliation?.status, "unknown");
  assert.match(sessionResult.reason ?? "", /session identity mismatch/u);

  const retentionAuthority = new FakeRetentionAuthority();
  park(retentionAuthority);
  retentionAuthority.uncertainResume = true;
  const retained = retentionAuthority.current.retention;
  assert.ok(retained);
  retentionAuthority.reobserve = (input) => ({
    status: "resolved",
    operationId: input.operationId,
    state: "active",
    snapshot: { ...retentionAuthority.current, retention: retained },
  });
  const retentionResult = resume(retentionAuthority);
  assert.equal(retentionResult.status, "uncertain");
  assert.equal(retentionResult.reconciliation?.status, "unknown");
  assert.match(retentionResult.reason ?? "", /retention record remains/u);
});

test("unknown durability remains typed uncertainty instead of inventing success", () => {
  const authority = new FakeRetentionAuthority();
  authority.uncertainPark = true;
  authority.reobserve = (input) => ({
    status: "unknown",
    operationId: input.operationId,
    reason: "registry unavailable",
  });
  const result = park(authority);

  assert.equal(result.status, "uncertain");
  assert.equal(result.claimSetGeneration, null);
  assert.equal(result.reconciliation?.status, "unknown");
  assert.equal(result.operationId, "park-op-1");
});

test("resume never performs a release-then-reclaim sequence", () => {
  const authority = new FakeRetentionAuthority();
  park(authority);
  resume(authority);

  assert.deepEqual(
    authority.events.filter((event) => event.includes("claim") || event.includes("resume")),
    ["validate-resume", "atomic-resume"],
  );
  assert.equal(authority.resumeCommits[0]?.desiredClaims.length, 1);
});
