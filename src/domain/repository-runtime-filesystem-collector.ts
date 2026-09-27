import { defaultGit, listGitWorktrees, resolveRepositoryContext } from "../git.js";
import {
  REPOSITORY_FILESYSTEM_OBSERVATION_V2,
  type RepositoryRuntimeFilesystemObservation,
  type RepositoryRuntimeUnmanagedWorktree,
} from "../repository-runtime-observations.js";
import type { RepositoryEvidenceSnapshot } from "../repository-evidence.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import type { RepositoryRegistryView, SessionRecord, SessionRegistry } from "../session-registry.js";
import { compareCodePointStrings } from "../resource-claims.js";
import type { JsonValue } from "./errors.js";
import {
  decideEffectivePathAccess,
  validateEffectiveFilesystemPolicy,
  type EffectiveFilesystemPolicy,
} from "./filesystem-policy.js";

const MAX_SESSIONS = 1_024;
const MAX_WORKTREES = 1_024;
const MAX_PATHS = 4_096;
const MAX_REASON_CODE_POINTS = 512;

const REASONS = Object.freeze({
  contextUnavailable: "repository context is unavailable or changed",
  evidenceUnavailable: "repository Git evidence is unavailable",
  evidenceIncomplete: "repository Git evidence is incomplete",
  filesystemSourceChanged: "filesystem observation sources changed during collection",
  policyUnavailable: "matching effective filesystem policy is unavailable",
  policyInvalid: "effective filesystem policy is invalid or stale",
  policyDecisionUnknown: "effective filesystem policy cannot decide the observed Git paths",
  operationUnknown: "Git evidence does not identify the exact tracked-path mutation operation",
  ownerUnknown: "Git-observable evidence does not prove physical owner identity",
  runtimeUnknown: "Git-observable evidence does not prove physical runtime enforcement",
  registryUnavailable: "repository session registry is unavailable",
  sessionBoundsExceeded: "filesystem observation exceeds its session bound",
  worktreeBoundsExceeded: "filesystem observation exceeds its worktree bound",
  pathBoundsExceeded: "filesystem observation exceeds its path bound",
  timeUnavailable: "filesystem observation time is unavailable",
} as const);

/**
 * Identity wrapper around the exact compiled policy supplied by the accepted
 * application producer. The wrapper is checked against fresh registry and
 * Git evidence; it is a read-only comparison input, never an authority to
 * mutate or authorize a path.
 */
export type RepositoryRuntimeEffectiveFilesystemPolicySource = Readonly<{
  readonly repository_id: string;
  readonly session_id: string;
  readonly worktree_id: string;
  readonly worktree_path: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly head_id: string;
  readonly policy: unknown;
}>;

export type RepositoryRuntimeFilesystemPolicyReadContext = Readonly<{
  readonly registry: RepositoryRegistryView;
  readonly session: SessionRecord;
  readonly evidence: RepositoryEvidenceSnapshot;
}>;

export type RepositoryRuntimeFilesystemCollectorOptions = Readonly<{
  /** A clock seam supplies observation time, never authority. */
  readonly now?: () => Date;
  /**
   * Read the current effective policy from its accepted producer. Returning
   * no matching result leaves policy status unknown; callers must not create a
   * substitute policy to make the observation appear complete.
   */
  readonly readEffectiveFilesystemPolicy?: (
    context: RepositoryRuntimeFilesystemPolicyReadContext,
  ) => RepositoryRuntimeEffectiveFilesystemPolicySource | null | undefined;
}>;

type PolicySample = Readonly<{
  readonly binding: RepositoryRuntimeEffectiveFilesystemPolicySource;
  readonly policy: EffectiveFilesystemPolicy;
}>;

type SessionSample = Readonly<{
  readonly session: SessionRecord;
  readonly evidence: RepositoryEvidenceSnapshot | null;
  readonly policy: PolicySample | null;
  readonly status: RepositoryRuntimeFilesystemObservation;
}>;

/** Collect bounded Git-observable filesystem facts without changing repository or registry state. */
export function collectRepositoryRuntimeFilesystemObservation(
  registry: Pick<SessionRegistry, "repository" | "readRepositoryView" | "repositoryEvidence">,
  options: RepositoryRuntimeFilesystemCollectorOptions = {},
): RepositoryRuntimeObservation<JsonValue> {
  let before: RepositoryRegistryView;
  try {
    before = registry.readRepositoryView();
  } catch {
    return unknownObservation(options.now, REASONS.registryUnavailable);
  }
  if (!validRepositoryView(before, registry.repository.repositoryId)) {
    return unknownObservation(options.now, REASONS.registryUnavailable);
  }
  if (before.sessions.length > MAX_SESSIONS) {
    return unknownObservation(options.now, REASONS.sessionBoundsExceeded);
  }
  if (!repositoryContextMatches(registry)) {
    return unknownObservation(options.now, REASONS.contextUnavailable);
  }

  let worktreesBefore: ReturnType<typeof listGitWorktrees>;
  try {
    worktreesBefore = listGitWorktrees(defaultGit, registry.repository.worktreePath);
  } catch {
    return unknownObservation(options.now, REASONS.evidenceUnavailable);
  }
  if (worktreesBefore.length > MAX_WORKTREES) {
    return unknownObservation(options.now, REASONS.worktreeBoundsExceeded);
  }

  const sessions = [...before.sessions].sort((left, right) => compareCodePointStrings(left.sessionId, right.sessionId));
  const samples: SessionSample[] = [];
  for (const session of sessions) {
    if (session.state !== "active") {
      samples.push({
        session,
        evidence: null,
        policy: null,
        status: unknownSession(session.sessionId, REASONS.evidenceUnavailable),
      });
      continue;
    }

    let evidence: RepositoryEvidenceSnapshot;
    try {
      evidence = registry.repositoryEvidence({ sessionId: session.sessionId });
    } catch {
      samples.push({
        session,
        evidence: null,
        policy: null,
        status: unknownSession(session.sessionId, REASONS.evidenceUnavailable),
      });
      continue;
    }
    if (!evidenceMatchesSession(evidence, before, session, worktreesBefore)) {
      return unknownObservation(options.now, REASONS.filesystemSourceChanged);
    }

    const policy = readPolicySample(options.readEffectiveFilesystemPolicy, before, session, evidence);
    if (policy === null) {
      samples.push({
        session,
        evidence,
        policy: null,
        status: unknownSession(session.sessionId, REASONS.policyUnavailable),
      });
      continue;
    }
    const policyProblem = policyIdentityProblem(policy, before, session, evidence);
    if (policyProblem !== null) {
      samples.push({
        session,
        evidence,
        policy,
        status: unknownSession(session.sessionId, policyProblem),
      });
      continue;
    }

    samples.push({
      session,
      evidence,
      policy,
      status: projectSessionEvidence(session.sessionId, evidence, policy.policy),
    });
  }

  // Re-read every source after the sample. RepositoryEvidenceSnapshot is
  // itself internally fenced; this second pass detects changes across sessions.
  for (const sample of samples) {
    if (sample.session.state !== "active" || sample.evidence === null || sample.policy === null) continue;
    let evidenceAfter: RepositoryEvidenceSnapshot;
    try {
      evidenceAfter = registry.repositoryEvidence({ sessionId: sample.session.sessionId });
    } catch {
      return unknownObservation(options.now, REASONS.filesystemSourceChanged);
    }
    if (
      !evidenceMatchesSession(evidenceAfter, before, sample.session, worktreesBefore) ||
      evidenceFingerprint(evidenceAfter) !== evidenceFingerprint(sample.evidence)
    ) {
      return unknownObservation(options.now, REASONS.filesystemSourceChanged);
    }
    const policyAfter = readPolicySample(options.readEffectiveFilesystemPolicy, before, sample.session, evidenceAfter);
    if (
      policyAfter === null ||
      policyIdentityProblem(policyAfter, before, sample.session, evidenceAfter) !== null ||
      policyFingerprint(policyAfter) !== policyFingerprint(sample.policy)
    ) {
      return unknownObservation(options.now, REASONS.filesystemSourceChanged);
    }
  }

  let worktreesAfter: ReturnType<typeof listGitWorktrees>;
  let after: RepositoryRegistryView;
  try {
    worktreesAfter = listGitWorktrees(defaultGit, registry.repository.worktreePath);
    after = registry.readRepositoryView();
  } catch {
    return unknownObservation(options.now, REASONS.filesystemSourceChanged);
  }
  if (
    !validRepositoryView(after, registry.repository.repositoryId) ||
    registrySourceFingerprint(before) !== registrySourceFingerprint(after) ||
    worktreeFingerprint(worktreesBefore) !== worktreeFingerprint(worktreesAfter) ||
    !repositoryContextMatches(registry)
  ) {
    return unknownObservation(options.now, REASONS.filesystemSourceChanged);
  }

  const unmanaged = projectUnmanagedWorktrees(worktreesAfter, after, registry.repository.worktreePath);
  if (unmanaged === null) return unknownObservation(options.now, REASONS.pathBoundsExceeded);
  const observedAt = observationTime(options.now);
  if (observedAt === null) return { status: "unknown", observed_at: null, reason: REASONS.timeUnavailable };

  const value = {
    contract_id: REPOSITORY_FILESYSTEM_OBSERVATION_V2,
    schema_version: 2,
    sessions: samples.map((sample) => sample.status),
    unmanaged_worktrees: unmanaged,
  } as unknown as JsonValue;
  return Object.freeze({ status: "available", observed_at: observedAt, value });
}

function projectSessionEvidence(
  sessionId: string,
  evidence: RepositoryEvidenceSnapshot,
  policy: EffectiveFilesystemPolicy,
): RepositoryRuntimeFilesystemObservation {
  const pathBound = Math.min(MAX_PATHS, evidence.bounds.maxPaths);
  const pathSets = [evidence.paths.changed, evidence.paths.staged, evidence.paths.unstaged, evidence.paths.untracked];
  if (
    !Number.isSafeInteger(pathBound) ||
    pathBound < 0 ||
    pathSets.some((paths) => paths.length > pathBound || new Set(paths).size !== paths.length)
  ) {
    return unknownSession(sessionId, REASONS.pathBoundsExceeded);
  }
  const changedPaths = new Set(evidence.paths.changed);
  if (pathSets.slice(1).some((paths) => paths.some((path) => !changedPaths.has(path)))) {
    return unknownSession(sessionId, REASONS.evidenceIncomplete);
  }
  const createPathsHaveIncompleteStats =
    !evidence.complete &&
    evidence.incompleteReasons.length > 0 &&
    evidence.incompleteReasons.every((reason) => reason === "STAT_UNAVAILABLE") &&
    evidence.paths.changed.length > 0 &&
    evidence.paths.changed.every((path) => evidence.paths.untracked.includes(path));
  if ((!evidence.complete || evidence.incompleteReasons.length > 0) && !createPathsHaveIncompleteStats) {
    const changedPaths = evidence.paths.changed.length;
    return unknownSession(sessionId, `${REASONS.evidenceIncomplete}; Git reports ${changedPaths} changed path(s)`);
  }
  const paths = evidence.paths.changed;
  if (policyHasUnknownBoundary(policy)) {
    return unknownSession(sessionId, REASONS.policyDecisionUnknown);
  }

  const changed = new Set(paths);
  const untracked = new Set(evidence.paths.untracked);
  if ([...untracked].some((path) => !changed.has(path))) {
    return unknownSession(sessionId, REASONS.evidenceIncomplete);
  }

  let violation = false;
  for (const path of paths) {
    if (!untracked.has(path)) {
      // Git's bounded checkpoint exposes a changed path but not whether its
      // exact operation was WRITE, DELETE, or one side of a RENAME.
      return unknownSession(sessionId, REASONS.operationUnknown);
    }
    const decision = decideEffectivePathAccess({ policy, operation: "CREATE", path, domain: "repository" });
    if (decision.status === "unresolved") return unknownSession(sessionId, REASONS.policyDecisionUnknown);
    if (decision.status === "deny") violation = true;
  }
  if (violation) {
    return Object.freeze({
      session_id: sessionId,
      policy_status: "violation",
      runtime_status: "unknown",
      owner: "unknown",
      reason: createPathsHaveIncompleteStats
        ? "a Git-observed untracked path is denied by effective policy; stat detail is incomplete"
        : "a Git-observed untracked path is denied by effective policy",
    });
  }
  if (createPathsHaveIncompleteStats) {
    return unknownSession(sessionId, "Git stat detail is incomplete for the observed CREATE paths");
  }
  // Git's changed-path view cannot establish that the complete filesystem is
  // clean, nor can it prove which process owns an unmodified path.
  return unknownSession(sessionId, REASONS.ownerUnknown);
}

function readPolicySample(
  source: RepositoryRuntimeFilesystemCollectorOptions["readEffectiveFilesystemPolicy"],
  registry: RepositoryRegistryView,
  session: SessionRecord,
  evidence: RepositoryEvidenceSnapshot,
): PolicySample | null {
  if (source === undefined) return null;
  try {
    const binding = source({ registry, session, evidence });
    if (binding === null || binding === undefined || typeof binding !== "object") return null;
    const parsed = validateEffectiveFilesystemPolicy(binding.policy);
    if (!parsed.ok) return null;
    return Object.freeze({ binding, policy: parsed.value });
  } catch {
    return null;
  }
}

function policyIdentityProblem(
  sample: PolicySample,
  view: RepositoryRegistryView,
  session: SessionRecord,
  evidence: RepositoryEvidenceSnapshot,
): string | null {
  const binding = sample.binding;
  const policy = sample.policy;
  const expectedWorkingSetRevision = session.workingSet?.revision ?? null;
  const currentClaims = view.claims.filter((claim) => claim.sessionId === session.sessionId);
  const claimsOn = session.claimEnforcement === true;
  const workingSetMatches =
    session.workingSet === undefined
      ? policy.working_set.status === "unapplied-legacy" &&
        policy.working_set.identity === null &&
        policy.working_set.revision === null
      : policy.working_set.identity === session.workingSet.id &&
        policy.working_set.revision === session.workingSet.revision;
  const claimsMatch = claimsOn
    ? policy.claims.status === "applied" &&
      policy.claims.generation === policyGeneration(view.claimSetGeneration) &&
      policy.provenance.claim_set_generation === policyGeneration(view.claimSetGeneration) &&
      stableJson(policy.claims.claims) === stableJson(currentClaims)
    : policy.claims.status === "unapplied-legacy" &&
      policy.claims.generation === null &&
      policy.provenance.claim_set_generation === null;
  if (
    binding.repository_id !== view.repositoryId ||
    binding.session_id !== session.sessionId ||
    binding.worktree_id !== session.worktreeId ||
    binding.worktree_path !== session.worktreePath ||
    binding.branch_id !== evidence.branchId ||
    binding.branch_name !== evidence.branchName ||
    binding.head_id !== evidence.headId ||
    evidence.repositoryId !== view.repositoryId ||
    evidence.sessionId !== session.sessionId ||
    evidence.worktreePath !== session.worktreePath ||
    evidence.branchId !== session.branchId ||
    evidence.branchName !== session.branchName ||
    policy.provenance.working_set_revision !== expectedWorkingSetRevision ||
    policy.working_set.revision !== expectedWorkingSetRevision ||
    !workingSetMatches ||
    policy.provenance.runtime_epoch !== policyEpoch(view.runtimeEpoch) ||
    !claimsMatch
  ) {
    return REASONS.policyInvalid;
  }
  return null;
}

function policyHasUnknownBoundary(policy: EffectiveFilesystemPolicy): boolean {
  return (
    policy.profile.status === "unknown" ||
    policy.working_set.status === "unknown" ||
    policy.claims.status === "unknown" ||
    policy.backend.status === "unknown" ||
    policy.auxiliary.status === "unknown"
  );
}

function evidenceMatchesSession(
  evidence: RepositoryEvidenceSnapshot,
  view: RepositoryRegistryView,
  session: SessionRecord,
  worktrees: ReturnType<typeof listGitWorktrees>,
): boolean {
  const physical = worktrees.find((worktree) => worktree.worktreePath === session.worktreePath);
  return (
    physical !== undefined &&
    !physical.prunable &&
    physical.branchName === session.branchName &&
    evidence.repositoryId === view.repositoryId &&
    evidence.sessionId === session.sessionId &&
    evidence.worktreePath === session.worktreePath &&
    evidence.branchId === session.branchId &&
    evidence.branchName === session.branchName &&
    evidence.sessionState === session.state
  );
}

function projectUnmanagedWorktrees(
  worktrees: ReturnType<typeof listGitWorktrees>,
  view: RepositoryRegistryView,
  repositoryWorktreePath: string,
): readonly RepositoryRuntimeUnmanagedWorktree[] | null {
  const sessionPaths = new Set(view.sessions.map((session) => session.worktreePath));
  const result: RepositoryRuntimeUnmanagedWorktree[] = [];
  for (const worktree of worktrees) {
    if (worktree.worktreePath === repositoryWorktreePath) continue;
    if (sessionPaths.has(worktree.worktreePath) && !worktree.prunable) continue;
    const reason = worktree.prunable
      ? "Git reports a prunable worktree without a current physical owner proof"
      : "Git worktree has no matching repository session record";
    if (!boundedText(worktree.worktreePath) || !boundedText(reason)) return null;
    result.push(Object.freeze({ worktree_path: worktree.worktreePath, reason }));
  }
  if (result.length > MAX_WORKTREES) return null;
  result.sort((left, right) => compareCodePointStrings(left.worktree_path, right.worktree_path));
  return Object.freeze(result);
}

function validRepositoryView(view: RepositoryRegistryView, expectedRepositoryId: string): boolean {
  const ids = new Set<string>();
  return (
    view.repositoryId === expectedRepositoryId &&
    Number.isSafeInteger(view.registryRevision) &&
    Number.isSafeInteger(view.runtimeEpoch) &&
    view.runtimeEpoch >= 0 &&
    Number.isSafeInteger(view.claimSetGeneration) &&
    view.claimSetGeneration >= 0 &&
    view.sessions.every((session) => {
      if (session.repositoryId !== view.repositoryId || ids.has(session.sessionId)) return false;
      ids.add(session.sessionId);
      return boundedText(session.sessionId) && boundedText(session.worktreePath);
    })
  );
}

function repositoryContextMatches(registry: Pick<SessionRegistry, "repository">): boolean {
  try {
    const current = resolveRepositoryContext({ cwd: registry.repository.worktreePath });
    return (
      current.repositoryId === registry.repository.repositoryId &&
      current.commonGitDirectory === registry.repository.commonGitDirectory &&
      current.worktreePath === registry.repository.worktreePath
    );
  } catch {
    return false;
  }
}

function registrySourceFingerprint(view: RepositoryRegistryView): string {
  return stableJson({
    repositoryId: view.repositoryId,
    registrySchemaVersion: view.registrySchemaVersion,
    registryRevision: view.registryRevision,
    runtimeEpoch: view.runtimeEpoch,
    claimSetGeneration: view.claimSetGeneration,
    sessions: [...view.sessions].sort((left, right) => compareCodePointStrings(left.sessionId, right.sessionId)),
    claims: [...view.claims].sort((left, right) => compareCodePointStrings(left.claimId, right.claimId)),
    runtimeRecords: view.runtimeRecords,
  });
}

function evidenceFingerprint(evidence: RepositoryEvidenceSnapshot): string {
  return stableJson({
    repositoryId: evidence.repositoryId,
    worktreePath: evidence.worktreePath,
    branchId: evidence.branchId,
    branchName: evidence.branchName,
    sessionId: evidence.sessionId,
    sessionState: evidence.sessionState,
    baseRevision: evidence.baseRevision,
    headId: evidence.headId,
    complete: evidence.complete,
    incompleteReasons: evidence.incompleteReasons,
    paths: evidence.paths,
    bounds: evidence.bounds,
  });
}

function policyFingerprint(sample: PolicySample): string {
  return stableJson({
    repository_id: sample.binding.repository_id,
    session_id: sample.binding.session_id,
    worktree_id: sample.binding.worktree_id,
    worktree_path: sample.binding.worktree_path,
    branch_id: sample.binding.branch_id,
    branch_name: sample.binding.branch_name,
    head_id: sample.binding.head_id,
    policy: sample.policy,
  });
}

function worktreeFingerprint(worktrees: ReturnType<typeof listGitWorktrees>): string {
  return stableJson(
    [...worktrees]
      .map((worktree) => ({
        worktreePath: worktree.worktreePath,
        branchName: worktree.branchName,
        prunable: worktree.prunable,
      }))
      .sort((left, right) => compareCodePointStrings(left.worktreePath, right.worktreePath)),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      compareCodePointStrings(left, right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "undefined" : encoded;
}

function policyGeneration(generation: number): number | null {
  // The effective-policy contract uses null for an authority with no
  // generation yet; the registry's initial zero is that same empty state.
  return generation === 0 ? null : generation;
}

function policyEpoch(epoch: number): number | null {
  // The effective-policy contract only accepts positive runtime epochs.
  return epoch === 0 ? null : epoch;
}

function unknownSession(sessionId: string, reason: string): RepositoryRuntimeFilesystemObservation {
  return Object.freeze({
    session_id: sessionId,
    policy_status: "unknown",
    runtime_status: "unknown",
    owner: "unknown",
    reason: [reason, REASONS.ownerUnknown, REASONS.runtimeUnknown].join("; ").slice(0, 512),
  });
}

function unknownObservation(
  now: RepositoryRuntimeFilesystemCollectorOptions["now"],
  reason: string,
): RepositoryRuntimeObservation<JsonValue> {
  return Object.freeze({ status: "unknown", observed_at: observationTime(now), reason });
}

function observationTime(now: RepositoryRuntimeFilesystemCollectorOptions["now"]): string | null {
  try {
    const value = (now ?? (() => new Date()))();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null;
    return value.toISOString();
  } catch {
    return null;
  }
}

function boundedText(value: string): boolean {
  return [...value].length > 0 && [...value].length <= MAX_REASON_CODE_POINTS && !/[\u0000-\u001f\u007f]/u.test(value);
}
