/**
 * Nawabari's transport-neutral Effective Working Set consumer contract.
 *
 * This module intentionally contains only bounded artifact validation and
 * composition.  Inari and Wabachi remain independent authorities: the former
 * supplies the maximum operation scope and the latter supplies semantic need.
 * Neither package is imported here.
 */

import { createHash } from "node:crypto";

export const EFFECTIVE_WORKING_SET_KIND = "effective-working-set" as const;
export const EFFECTIVE_WORKING_SET_VERSION = 1 as const;
export const EFFECTIVE_WORKING_SET_SCHEMA_VERSION = "1.0.0" as const;
export const EFFECTIVE_WORKING_SET_SCHEMA_ID =
  `urn:nawabari:effective-working-set:${EFFECTIVE_WORKING_SET_SCHEMA_VERSION}` as const;

export const IMPLEMENTATION_EXECUTION_SCOPE_KIND = "implementation-execution-scope" as const;
export const IMPLEMENTATION_EXECUTION_SCOPE_VERSION = 1 as const;
export const CANDIDATE_WORKING_SET_KIND = "candidate-working-set" as const;
export const CANDIDATE_WORKING_SET_VERSION = 1 as const;

export const EFFECTIVE_WORKING_SET_OPERATIONS = ["READONLY", "WRITE", "CREATE", "DELETE", "DENY"] as const;
export type EffectiveWorkingSetOperation = (typeof EFFECTIVE_WORKING_SET_OPERATIONS)[number];

export type RepositoryIdentity = {
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository?: string;
};

export type BaseIdentity = {
  readonly branch: string;
  readonly revision: string;
  readonly freshness?: string;
};

export type EffectiveWorkingSetScope = {
  readonly readOnly: readonly string[];
  readonly write: readonly string[];
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
};

export type WorkingSetSourceIdentity = {
  readonly kind: string;
  readonly version: number;
  readonly digest: string;
  readonly identity: string;
};

export type EffectiveWorkingSetProvenance = {
  readonly executionScope: WorkingSetSourceIdentity;
  readonly candidateWorkingSet: WorkingSetSourceIdentity;
  readonly repository: RepositoryIdentity;
  readonly base: BaseIdentity;
};

export type EffectiveWorkingSet = {
  readonly version: typeof EFFECTIVE_WORKING_SET_VERSION;
  readonly kind: typeof EFFECTIVE_WORKING_SET_KIND;
  /** Deterministic state revision. Initial composition always produces 1. */
  readonly revision: number;
  readonly id: string;
  readonly repository: RepositoryIdentity;
  readonly base: BaseIdentity;
  readonly scope: EffectiveWorkingSetScope;
  readonly provenance: EffectiveWorkingSetProvenance;
  /** Bounded evidence of explicit expansions; never an authorization source. */
  readonly history?: readonly WorkingSetExpansionHistoryEntry[];
};

export type WorkingSetExpansionOperation = Exclude<EffectiveWorkingSetOperation, "DENY">;

export type WorkingSetExpansionRequestEntry = {
  readonly path: string;
  readonly operation: WorkingSetExpansionOperation;
  readonly reason: string;
  readonly evidence?: string;
  /** Unresolved semantic identity is never granted, even when authorized. */
  readonly resolution?: "resolved" | "unresolved";
};

export type WorkingSetExpansionHistoryEntry = {
  readonly revision: number;
  readonly paths: readonly string[];
  readonly operations: readonly WorkingSetExpansionOperation[];
  readonly reason: string;
  readonly evidence?: string;
  readonly requestDigest: string;
};

export type WorkingSetExpansionOutcome = {
  readonly path: string;
  readonly operation: WorkingSetExpansionOperation;
  readonly status: "granted" | "denied" | "unresolved";
  readonly reason: string;
};

export type WorkingSetExpansionEvaluation = {
  readonly outcomes: readonly WorkingSetExpansionOutcome[];
  readonly nextWorkingSet?: EffectiveWorkingSet;
  readonly nextRevision: number;
  readonly idempotent: boolean;
  readonly executionScope: ImplementationExecutionScopeArtifact;
};

export type WorkingSetExpansionInput = {
  readonly currentRevision: number;
  readonly entries: readonly WorkingSetExpansionRequestEntry[];
  readonly executionScope: unknown;
};

export type WorkingSetUnsatisfiableCode =
  | "UNSUPPORTED_ARTIFACT_VERSION"
  | "INVALID_ARTIFACT"
  | "REPOSITORY_MISMATCH"
  | "BASE_MISMATCH"
  | "REQUIRED_CONTEXT_UNAUTHORIZED"
  | "UNRESOLVED_REQUIRED_CONTEXT";

export type WorkingSetDiagnostic = {
  readonly code: WorkingSetUnsatisfiableCode;
  readonly path: string;
  readonly message: string;
};

export type EffectiveWorkingSetCompositionResult =
  | { readonly status: "satisfied"; readonly workingSet: EffectiveWorkingSet }
  | {
      readonly status: "unsatisfiable";
      readonly code: WorkingSetUnsatisfiableCode;
      readonly diagnostics: readonly WorkingSetDiagnostic[];
    };

export type WorkingSetCompositionInput = {
  readonly executionScope: unknown;
  readonly candidateWorkingSet: unknown;
  readonly repository: RepositoryIdentity;
  readonly base: BaseIdentity;
};

type RecordValue = Record<string, unknown>;

const SCOPE_KEYS = ["readOnly", "write", "create", "delete", "deny"] as const;
const HEX_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const PATH = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_.*?/@+:-]+$/u;
const MAX_PATHS = 2_048;
const MAX_ENTRIES = 1_024;
const MAX_TEXT = 1_024;

function isRecord(value: unknown): value is RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareStrings)) result[key] = stableClone(value[key]);
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function artifactDigest(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate))
      return candidate
        .map(canonicalize)
        .sort((left, right) => compareStrings(JSON.stringify(left), JSON.stringify(right)));
    if (isRecord(candidate)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort(compareStrings)) result[key] = canonicalize(candidate[key]);
      return result;
    }
    return candidate;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function text(value: unknown, path: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !SAFE_TEXT.test(value)) {
    throw new Error(`${path} must be a bounded non-empty string`);
  }
  return value.normalize("NFC");
}

function revision(value: unknown, path: string): string {
  const result = text(value, path, 64).toLowerCase();
  if (!HEX_REVISION.test(result)) throw new Error(`${path} must be an immutable hexadecimal revision`);
  return result;
}

function allowedKeys(value: RecordValue, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`);
  }
}

function repository(value: unknown, path: string, requireLocator: boolean): RepositoryIdentity {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  allowedKeys(value, ["repositoryHost", "repositoryId", "repository"], path);
  const result: RepositoryIdentity = {
    repositoryHost: text(value.repositoryHost, `${path}.repositoryHost`),
    repositoryId: text(value.repositoryId, `${path}.repositoryId`),
    ...(value.repository === undefined ? {} : { repository: text(value.repository, `${path}.repository`) }),
  };
  if (requireLocator && result.repository === undefined) throw new Error(`${path}.repository is required`);
  return Object.freeze(result);
}

function base(value: unknown, path: string): BaseIdentity {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  allowedKeys(value, ["branch", "revision", "freshness"], path);
  return Object.freeze({
    branch: text(value.branch, `${path}.branch`),
    revision: revision(value.revision, `${path}.revision`),
    ...(value.freshness === undefined ? {} : { freshness: text(value.freshness, `${path}.freshness`) }),
  });
}

function selector(value: unknown, path: string): string {
  const result = text(value, path);
  if (!PATH.test(result)) throw new Error(`${path} is not a canonical repository-relative selector`);
  return result;
}

function scope(value: unknown, path: string): EffectiveWorkingSetScope {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  allowedKeys(value, SCOPE_KEYS, path);
  const result = {} as Record<(typeof SCOPE_KEYS)[number], readonly string[]>;
  for (const key of SCOPE_KEYS) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length > MAX_PATHS)
      throw new Error(`${path}.${key} must be a bounded array`);
    const normalized = entries.map((entry, index) => selector(entry, `${path}.${key}[${index}]`));
    if (new Set(normalized).size !== normalized.length) throw new Error(`${path}.${key} contains duplicates`);
    result[key] = Object.freeze([...normalized].sort(compareStrings));
  }
  return Object.freeze(result);
}

export type ImplementationExecutionScopeArtifact = {
  readonly version: 1;
  readonly kind: typeof IMPLEMENTATION_EXECUTION_SCOPE_KIND;
  readonly authorization: RecordValue;
  readonly repository: RepositoryIdentity;
  readonly base: BaseIdentity;
  readonly scope: EffectiveWorkingSetScope;
};

function validateExecutionScope(input: unknown): ImplementationExecutionScopeArtifact {
  if (!isRecord(input)) throw new Error("execution scope must be an object");
  allowedKeys(input, ["version", "kind", "authorization", "repository", "base", "branch", "scope"], "execution scope");
  if (input.version !== IMPLEMENTATION_EXECUTION_SCOPE_VERSION)
    throw new Error("execution scope version is unsupported");
  if (!isRecord(input.authorization)) throw new Error("execution scope authorization must be an object");
  allowedKeys(
    input.authorization,
    ["version", "kind", "contractVersion", "implementation", "governedBodyDigest"],
    "execution scope.authorization",
  );
  if (input.authorization.version !== 1 || input.authorization.kind !== "implementation-authorization")
    throw new Error("execution scope authorization version or kind is unsupported");
  if (input.authorization.contractVersion !== 1) throw new Error("execution scope contract version is unsupported");
  const implementation = input.authorization.implementation;
  if (!isRecord(implementation)) throw new Error("execution scope implementation is invalid");
  allowedKeys(
    implementation,
    ["repositoryHost", "repositoryId", "repository", "number"],
    "execution scope.authorization.implementation",
  );
  text(implementation.repositoryHost, "execution scope.authorization.implementation.repositoryHost");
  text(implementation.repositoryId, "execution scope.authorization.implementation.repositoryId");
  if (!Number.isSafeInteger(implementation.number) || (implementation.number as number) < 1)
    throw new Error("execution scope implementation number is invalid");
  if (!/^[a-f0-9]{64}$/u.test(String(input.authorization.governedBodyDigest)))
    throw new Error("execution scope governed body digest is invalid");
  const artifactRepository = repository(input.repository, "execution scope.repository", false);
  const implementationRepository = {
    repositoryHost: text(implementation.repositoryHost, "execution scope.authorization.implementation.repositoryHost"),
    repositoryId: text(implementation.repositoryId, "execution scope.authorization.implementation.repositoryId"),
  };
  if (
    artifactRepository.repositoryHost !== implementationRepository.repositoryHost ||
    artifactRepository.repositoryId !== implementationRepository.repositoryId
  )
    throw new Error("execution scope authorization repository does not match artifact repository");
  if (input.branch !== undefined) text(input.branch, "execution scope.branch");
  return Object.freeze({
    version: 1,
    kind: IMPLEMENTATION_EXECUTION_SCOPE_KIND,
    authorization: input.authorization,
    repository: artifactRepository,
    base: base(input.base, "execution scope.base"),
    scope: scope(input.scope, "execution scope.scope"),
  });
}

type CandidateEntry = {
  readonly state: "required" | "supporting" | "verification" | "unresolved";
  readonly target: { readonly kind: "file" | "symbol" | "test" | "unresolved"; readonly locator: string };
};

export type CandidateWorkingSetArtifact = {
  readonly kind: typeof CANDIDATE_WORKING_SET_KIND;
  readonly schemaVersion: 1;
  readonly workingSetId: string;
  readonly repository: RepositoryIdentity;
  readonly revision: string;
  readonly entries: readonly CandidateEntry[];
};

function validateCandidateWorkingSet(input: unknown): CandidateWorkingSetArtifact {
  if (!isRecord(input)) throw new Error("candidate working set must be an object");
  allowedKeys(
    input,
    ["kind", "schemaVersion", "workingSetId", "repository", "revision", "entries"],
    "candidate working set",
  );
  if (input.kind !== CANDIDATE_WORKING_SET_KIND) throw new Error("candidate working set kind is unsupported");
  if (input.schemaVersion !== CANDIDATE_WORKING_SET_VERSION)
    throw new Error("candidate working set version is unsupported");
  const candidateRepository = repository(input.repository, "candidate working set.repository", true);
  const entries = input.entries;
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES)
    throw new Error("candidate working set entries are invalid");
  const normalized = entries.map((entry, index): CandidateEntry => {
    if (!isRecord(entry)) throw new Error(`candidate working set.entries[${index}] is invalid`);
    allowedKeys(entry, ["state", "target", "reason", "evidence"], `candidate working set.entries[${index}]`);
    if (!(["required", "supporting", "verification", "unresolved"] as const).includes(entry.state as never))
      throw new Error(`candidate working set.entries[${index}].state is unsupported`);
    if (!isRecord(entry.target)) throw new Error(`candidate working set.entries[${index}].target is invalid`);
    allowedKeys(entry.target, ["kind", "locator"], `candidate working set.entries[${index}].target`);
    if (!("file symbol test unresolved".split(" ") as readonly string[]).includes(String(entry.target.kind)))
      throw new Error(`candidate working set.entries[${index}].target.kind is unsupported`);
    const target = {
      kind: entry.target.kind as CandidateEntry["target"]["kind"],
      locator: text(entry.target.locator, `candidate working set.entries[${index}].target.locator`),
    };
    if (entry.state === "unresolved" && target.kind !== "unresolved")
      throw new Error("unresolved state has concrete target");
    if (entry.state !== "unresolved" && target.kind === "unresolved")
      throw new Error("concrete state has unresolved target");
    if (!isRecord(entry.reason)) throw new Error(`candidate working set.entries[${index}].reason is invalid`);
    allowedKeys(entry.reason, ["id", "summary"], `candidate working set.entries[${index}].reason`);
    text(entry.reason.id, `candidate working set.entries[${index}].reason.id`);
    text(entry.reason.summary, `candidate working set.entries[${index}].reason.summary`);
    if (!Array.isArray(entry.evidence) || entry.evidence.length > 16)
      throw new Error("candidate working set evidence is invalid");
    for (const evidence of entry.evidence) {
      if (!isRecord(evidence)) throw new Error("candidate working set evidence entry is invalid");
      allowedKeys(evidence, ["artifact", "reference"], "candidate working set evidence");
      text(evidence.artifact, "candidate working set evidence.artifact");
      text(evidence.reference, "candidate working set evidence.reference");
    }
    return Object.freeze({ state: entry.state as CandidateEntry["state"], target });
  });
  return Object.freeze({
    kind: CANDIDATE_WORKING_SET_KIND,
    schemaVersion: 1,
    workingSetId: text(input.workingSetId, "candidate working set.workingSetId"),
    repository: candidateRepository,
    revision: revision(input.revision, "candidate working set.revision"),
    entries: Object.freeze(normalized),
  });
}

function matches(selectorValue: string, candidate: string): boolean {
  let expression = "^";
  for (let index = 0; index < selectorValue.length; index += 1) {
    const character = selectorValue[index];
    if (character === "*" && selectorValue[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character?.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") ?? "";
  }
  return new RegExp(`${expression}$`, "u").test(candidate);
}

function authorized(
  operation: Exclude<EffectiveWorkingSetOperation, "DENY">,
  path: string,
  artifact: ImplementationExecutionScopeArtifact,
): boolean {
  if (artifact.scope.deny.some((entry) => matches(entry, path))) return false;
  const list =
    artifact.scope[operation === "READONLY" ? "readOnly" : (operation.toLowerCase() as "write" | "create" | "delete")];
  return list.some((entry) => matches(entry, path));
}

function identityMatches(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function baseMatches(left: BaseIdentity, right: BaseIdentity): boolean {
  return (
    left.branch === right.branch &&
    left.revision === right.revision &&
    (left.freshness === undefined || right.freshness === undefined || left.freshness === right.freshness)
  );
}

function unsatisfiable(
  code: WorkingSetUnsatisfiableCode,
  path: string,
  message: string,
): EffectiveWorkingSetCompositionResult {
  return { status: "unsatisfiable", code, diagnostics: Object.freeze([{ code, path, message }]) };
}

/** Validate an Inari artifact at Nawabari's bounded consumer boundary. */
export function parseImplementationExecutionScope(input: unknown): ImplementationExecutionScopeArtifact {
  return validateExecutionScope(input);
}

/** Validate a Wabachi artifact at Nawabari's bounded consumer boundary. */
export function parseCandidateWorkingSet(input: unknown): CandidateWorkingSetArtifact {
  return validateCandidateWorkingSet(input);
}

/** Compose the first deterministic Effective Working Set revision. */
export function composeEffectiveWorkingSet(input: WorkingSetCompositionInput): EffectiveWorkingSetCompositionResult {
  let executionScope: ImplementationExecutionScopeArtifact;
  let candidate: CandidateWorkingSetArtifact;
  try {
    executionScope = validateExecutionScope(input.executionScope);
    candidate = validateCandidateWorkingSet(input.candidateWorkingSet);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code: WorkingSetUnsatisfiableCode = /unsupported/u.test(message)
      ? "UNSUPPORTED_ARTIFACT_VERSION"
      : "INVALID_ARTIFACT";
    return unsatisfiable(code, "$", message);
  }
  let actualRepository: RepositoryIdentity;
  let actualBase: BaseIdentity;
  try {
    actualRepository = repository(input.repository, "repository", false);
    actualBase = base(input.base, "base");
  } catch (error) {
    return unsatisfiable("INVALID_ARTIFACT", "$", error instanceof Error ? error.message : String(error));
  }
  if (
    !identityMatches(executionScope.repository, candidate.repository) ||
    !identityMatches(executionScope.repository, actualRepository)
  )
    return unsatisfiable(
      "REPOSITORY_MISMATCH",
      "repository",
      "repository identity does not match every artifact and session base",
    );
  if (!baseMatches(executionScope.base, actualBase) || executionScope.base.revision !== candidate.revision)
    return unsatisfiable(
      "BASE_MISMATCH",
      "base",
      "base branch or immutable revision does not match every artifact and session base",
    );

  const paths = new Set<string>();
  const required = new Set<string>();
  for (const [index, entry] of candidate.entries.entries()) {
    if (entry.state === "unresolved") {
      return unsatisfiable(
        "UNRESOLVED_REQUIRED_CONTEXT",
        `candidateWorkingSet.entries[${index}]`,
        "unresolved candidate context prevents a complete governed set",
      );
    }
    if (entry.target.kind !== "file" && entry.target.kind !== "test" && entry.target.kind !== "symbol") continue;
    const path = entry.target.locator.split("#", 1)[0];
    if (!PATH.test(path)) {
      if (entry.state === "required")
        return unsatisfiable(
          "UNRESOLVED_REQUIRED_CONTEXT",
          `candidateWorkingSet.entries[${index}]`,
          "required candidate locator is not a repository path",
        );
      continue;
    }
    paths.add(path);
    if (entry.state === "required") required.add(path);
  }
  for (const path of required) {
    if (!authorized("READONLY", path, executionScope))
      return unsatisfiable(
        "REQUIRED_CONTEXT_UNAUTHORIZED",
        path,
        "required candidate context is outside authorized READONLY scope or is denied",
      );
  }

  const readOnly = [...paths].filter((path) => authorized("READONLY", path, executionScope)).sort(compareStrings);
  const write = [...paths].filter((path) => authorized("WRITE", path, executionScope)).sort(compareStrings);
  const create = [...paths].filter((path) => authorized("CREATE", path, executionScope)).sort(compareStrings);
  const del = [...paths].filter((path) => authorized("DELETE", path, executionScope)).sort(compareStrings);
  const deny = [...paths]
    .filter((path) => executionScope.scope.deny.some((entry) => matches(entry, path)))
    .sort(compareStrings);
  const scopeValue: EffectiveWorkingSetScope = Object.freeze({
    readOnly: Object.freeze(readOnly),
    write: Object.freeze(write),
    create: Object.freeze(create),
    delete: Object.freeze(del),
    deny: Object.freeze(deny),
  });
  const executionDigest = artifactDigest(input.executionScope);
  const candidateDigest = artifactDigest(input.candidateWorkingSet);
  const provenance: EffectiveWorkingSetProvenance = Object.freeze({
    executionScope: Object.freeze({
      kind: executionScope.kind,
      version: executionScope.version,
      digest: executionDigest,
      identity: executionScope.authorization.governedBodyDigest as string,
    }),
    candidateWorkingSet: Object.freeze({
      kind: candidate.kind,
      version: candidate.schemaVersion,
      digest: candidateDigest,
      identity: candidate.workingSetId,
    }),
    repository: actualRepository,
    base: actualBase,
  });
  const seed = stableJson({ repository: actualRepository, base: actualBase, scope: scopeValue, provenance });
  const id = `ews-${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
  return {
    status: "satisfied",
    workingSet: Object.freeze({
      version: 1,
      kind: EFFECTIVE_WORKING_SET_KIND,
      revision: 1,
      id,
      repository: actualRepository,
      base: actualBase,
      scope: scopeValue,
      provenance,
    }),
  };
}

/** Digest an externally supplied bounded artifact for provenance matching. */
export function digestWorkingSetArtifact(input: unknown): string {
  return artifactDigest(input);
}

function normalizeExpansionEntries(
  entries: readonly WorkingSetExpansionRequestEntry[],
): WorkingSetExpansionRequestEntry[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 256) {
    throw new Error("working-set expansion requires between 1 and 256 entries");
  }
  const normalized = entries.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`working-set expansion.entries[${index}] is invalid`);
    allowedKeys(
      entry,
      ["path", "operation", "reason", "evidence", "resolution"],
      `working-set expansion.entries[${index}]`,
    );
    const path = selector(entry.path, `working-set expansion.entries[${index}].path`);
    if (/[?*]/u.test(path)) {
      throw new Error(`working-set expansion.entries[${index}].path must be an exact repository path`);
    }
    const operation = entry.operation;
    if (!["READONLY", "WRITE", "CREATE", "DELETE"].includes(String(operation))) {
      throw new Error(`working-set expansion.entries[${index}].operation is unsupported`);
    }
    const resolution = entry.resolution === undefined ? "resolved" : entry.resolution;
    if (resolution !== "resolved" && resolution !== "unresolved") {
      throw new Error(`working-set expansion.entries[${index}].resolution is unsupported`);
    }
    return Object.freeze({
      path,
      operation: operation as WorkingSetExpansionOperation,
      reason: text(entry.reason, `working-set expansion.entries[${index}].reason`),
      ...(entry.evidence === undefined
        ? {}
        : { evidence: text(entry.evidence, `working-set expansion.entries[${index}].evidence`) }),
      resolution,
    });
  });
  return normalized.sort((left, right) => {
    const leftKey = `${left.path}\u0000${left.operation}`;
    const rightKey = `${right.path}\u0000${right.operation}`;
    return compareStrings(leftKey, rightKey);
  });
}

function scopeEntries(
  scopeValue: EffectiveWorkingSetScope,
  operation: WorkingSetExpansionOperation,
): readonly string[] {
  return scopeValue[operation === "READONLY" ? "readOnly" : (operation.toLowerCase() as "write" | "create" | "delete")];
}

function scopeHas(
  scopeValue: EffectiveWorkingSetScope,
  operation: WorkingSetExpansionOperation,
  path: string,
): boolean {
  return scopeEntries(scopeValue, operation).includes(path);
}

function expansionOutcome(
  entry: WorkingSetExpansionRequestEntry,
  status: WorkingSetExpansionOutcome["status"],
  reason: string,
): WorkingSetExpansionOutcome {
  return Object.freeze({ path: entry.path, operation: entry.operation, status, reason });
}

/**
 * Evaluate and, only when every entry is grantable, apply an explicit scope
 * expansion. Claims are deliberately evaluated by SessionRegistry; this
 * reducer owns only bounded Inari maximum/DENY and working-set state.
 */
export function evaluateWorkingSetExpansion(
  current: EffectiveWorkingSet,
  input: WorkingSetExpansionInput,
): WorkingSetExpansionEvaluation {
  if (!Number.isSafeInteger(current.revision) || current.revision < 1) {
    throw new Error("working-set revision is invalid");
  }
  if (!Number.isSafeInteger(input.currentRevision) || input.currentRevision < 1) {
    throw new Error("working-set expansion current revision is invalid");
  }
  const executionScope = validateExecutionScope(input.executionScope);
  const entries = normalizeExpansionEntries(input.entries);
  const scopeValue = current.scope;
  const outcomes: WorkingSetExpansionOutcome[] = [];
  const additions = new Map<WorkingSetExpansionOperation, Set<string>>([
    ["READONLY", new Set(scopeValue.readOnly)],
    ["WRITE", new Set(scopeValue.write)],
    ["CREATE", new Set(scopeValue.create)],
    ["DELETE", new Set(scopeValue.delete)],
  ]);

  for (const entry of entries) {
    if (entry.resolution === "unresolved") {
      outcomes.push(expansionOutcome(entry, "unresolved", "semantic path identity is unresolved"));
      continue;
    }
    if (current.revision !== input.currentRevision) {
      outcomes.push(expansionOutcome(entry, "denied", "current working-set revision does not match the CAS revision"));
      continue;
    }
    if (artifactDigest(input.executionScope) !== current.provenance.executionScope.digest) {
      outcomes.push(
        expansionOutcome(entry, "denied", "execution-scope provenance does not match the session working set"),
      );
      continue;
    }
    if (!authorized(entry.operation, entry.path, executionScope)) {
      outcomes.push(expansionOutcome(entry, "denied", "path is outside the Inari maximum scope or is denied"));
      continue;
    }
    outcomes.push(expansionOutcome(entry, "granted", "path is within the bounded execution scope"));
    additions.get(entry.operation)?.add(entry.path);
  }

  const hasBlocked = outcomes.some((outcome) => outcome.status !== "granted");
  const changed = outcomes.some(
    (outcome) => outcome.status === "granted" && !scopeHas(scopeValue, outcome.operation, outcome.path),
  );
  if (hasBlocked || !changed) {
    return Object.freeze({
      outcomes: Object.freeze(outcomes),
      nextRevision: current.revision,
      idempotent: !hasBlocked,
      executionScope,
    });
  }

  const nextRevision = current.revision + 1;
  if (!Number.isSafeInteger(nextRevision)) throw new Error("working-set revision exhausted");
  const reason = entries
    .map((entry) => entry.reason)
    .join("; ")
    .slice(0, MAX_TEXT);
  const evidence = entries
    .map((entry) => entry.evidence)
    .filter((value): value is string => value !== undefined)
    .join("; ")
    .slice(0, MAX_TEXT);
  const historyEntry: WorkingSetExpansionHistoryEntry = Object.freeze({
    revision: nextRevision,
    paths: Object.freeze([...new Set(entries.map((entry) => entry.path))].sort(compareStrings)),
    operations: Object.freeze(
      [...new Set(entries.map((entry) => entry.operation))].sort(compareStrings) as WorkingSetExpansionOperation[],
    ),
    reason,
    ...(evidence.length === 0 ? {} : { evidence }),
    requestDigest: artifactDigest(entries),
  });
  const history = [...(current.history ?? []), historyEntry].slice(-32);
  const nextWorkingSet: EffectiveWorkingSet = Object.freeze({
    ...current,
    revision: nextRevision,
    scope: Object.freeze({
      readOnly: Object.freeze([...additions.get("READONLY")!].sort(compareStrings)),
      write: Object.freeze([...additions.get("WRITE")!].sort(compareStrings)),
      create: Object.freeze([...additions.get("CREATE")!].sort(compareStrings)),
      delete: Object.freeze([...additions.get("DELETE")!].sort(compareStrings)),
      deny: current.scope.deny,
    }),
    history: Object.freeze(history),
  });
  return Object.freeze({
    outcomes: Object.freeze(outcomes),
    nextWorkingSet,
    nextRevision,
    idempotent: false,
    executionScope,
  });
}

/** Throwing convenience for callers that require a usable governed set. */
export function establishEffectiveWorkingSet(input: WorkingSetCompositionInput): EffectiveWorkingSet {
  const result = composeEffectiveWorkingSet(input);
  if (result.status === "unsatisfiable")
    throw new Error(`${result.code}: ${result.diagnostics[0]?.message ?? "working set is unsatisfiable"}`);
  return result.workingSet;
}

export const deriveEffectiveWorkingSet = establishEffectiveWorkingSet;
export const tryComposeEffectiveWorkingSet = composeEffectiveWorkingSet;

/** Deterministic JSON for persistence/transport of the local contract. */
export function serializeEffectiveWorkingSet(workingSet: EffectiveWorkingSet): string {
  return stableJson(workingSet) as string;
}
