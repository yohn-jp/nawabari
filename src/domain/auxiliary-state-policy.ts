import { createHash } from "node:crypto";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import { validateAuxiliaryStateDeclaration, type AuxiliaryStateDeclaration } from "./auxiliary-state-projection.js";

/** Versioned consumer boundary for auxiliary-state visibility. */
export const AUXILIARY_STATE_POLICY_CONTRACT_ID = "nawabari.auxiliary-state-policy.v1" as const;
export const AUXILIARY_STATE_POLICY_SCHEMA_VERSION = 1 as const;

export const AUXILIARY_STATE_VISIBILITIES = Object.freeze(["bounded", "unsupported"] as const);
export type AuxiliaryStateVisibilityKind = (typeof AUXILIARY_STATE_VISIBILITIES)[number];

export const AUXILIARY_STATE_POLICY_OPERATIONS = Object.freeze([
  "READONLY",
  "WRITE",
  "CREATE",
  "DELETE",
  "DENY",
] as const);
export type AuxiliaryStatePolicyOperation = (typeof AUXILIARY_STATE_POLICY_OPERATIONS)[number];

type UnknownRecord = Record<string, unknown>;

/** The repository identity carried by profile and index evidence. */
export type AuxiliaryStateRepositoryIdentity = Readonly<{
  readonly repositoryHost: string;
  readonly repositoryId: string;
  readonly repository?: string;
}>;

/** The immutable base against which a derived index was produced. */
export type AuxiliaryStateBaseIdentity = Readonly<{
  readonly branch: string;
  readonly revision: string;
  readonly freshness?: string;
}>;

/** Effective path authority supplied by the worktree profile. */
export type AuxiliaryStatePolicyScope = Readonly<{
  readonly readOnly: readonly string[];
  readonly write: readonly string[];
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
}>;

/** Structural profile input consumed by this leaf; it never observes the host. */
export type AuxiliaryStatePolicyProfile = Readonly<{
  readonly repository: AuxiliaryStateRepositoryIdentity;
  readonly base: AuxiliaryStateBaseIdentity;
  readonly scope: AuxiliaryStatePolicyScope;
  /** Optional canonical worktree root used to prove CodeGraph root identity. */
  readonly worktree_root?: string;
}>;

/**
 * Evidence emitted by a bounded index producer.  `content_paths` is the
 * producer's complete, relative list of source paths represented by the
 * index; a partial list would turn the index into an unbounded read oracle.
 */
export type AuxiliaryStatePolicyEvidence = Readonly<{
  readonly repository: AuxiliaryStateRepositoryIdentity;
  readonly base: AuxiliaryStateBaseIdentity;
  readonly covered_scope: readonly string[];
  readonly content_paths: readonly string[];
  /** The actual worktree root used by the producer, when CodeGraph is used. */
  readonly root?: string;
  /** The immutable repository/base revision used by the producer. */
  readonly revision?: string;
  /** Optional Git-authoritative paths used to reject a target shadow. */
  readonly tracked_paths?: readonly string[];
}>;

export type AuxiliaryStatePolicyProvenance = Readonly<{
  readonly repository: AuxiliaryStateRepositoryIdentity;
  readonly base: AuxiliaryStateBaseIdentity;
  readonly covered_scope: readonly string[];
  readonly root: string | null;
  readonly revision: string | null;
  readonly evidence_digest: string | null;
}>;

/**
 * A closed auxiliary projection.  `bounded` is the only state that grants
 * visibility; `unsupported` intentionally carries an empty grant.
 */
export type AuxiliaryStateVisibility = Readonly<{
  readonly contract_id: typeof AUXILIARY_STATE_POLICY_CONTRACT_ID;
  readonly schema_version: typeof AUXILIARY_STATE_POLICY_SCHEMA_VERSION;
  readonly visibility: AuxiliaryStateVisibilityKind;
  readonly auxiliary: Readonly<{
    readonly declaration: AuxiliaryStateDeclaration;
    readonly source_path: string;
    readonly target_path: string;
    readonly mode: "copy";
    readonly durability: "durable";
    readonly access: "READONLY";
    readonly scope: readonly string[];
    readonly deny: readonly string[];
  }>;
  readonly provenance: AuxiliaryStatePolicyProvenance | null;
}>;

export type AuxiliaryStatePolicyErrorCode = Extract<
  import("./errors.js").ErrorCode,
  "AUXILIARY_STATE_INVALID" | "AUXILIARY_STATE_AMBIGUOUS" | "AUXILIARY_STATE_MATERIALIZATION_FAILED"
>;

const HEX_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const PROCESS_LOCAL_SEGMENTS = new Set(["log", "logs", "pid", "pids", "run", "socket", "sockets"]);

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isRecord(value)) {
    const result: UnknownRecord = {};
    for (const key of Object.keys(value).sort(compareText)) result[key] = stableClone(value[key]);
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableClone(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("AUXILIARY_STATE_INVALID", `Auxiliary state policy field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("AUXILIARY_STATE_AMBIGUOUS", `Auxiliary state policy field '${field}' is ambiguous: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function safeText(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || !SAFE_TEXT.test(value)) {
    return invalid(field, "expected bounded non-empty text");
  }
  return success(value.normalize("NFC"));
}

function revision(value: unknown, field: string): DomainResult<string> {
  const text = safeText(value, field);
  if (!text.ok) return text;
  const normalized = text.value.toLowerCase();
  if (!HEX_REVISION.test(normalized)) return invalid(field, "expected an immutable hexadecimal revision", normalized);
  return success(normalized);
}

function selector(value: unknown, field: string, allowGlob = true): DomainResult<string> {
  const text = safeText(value, field);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    (!allowGlob && /[*?]/u.test(normalized))
  ) {
    return invalid(field, "expected a normalized repository-relative selector", normalized);
  }
  return success(normalized);
}

function absolutePath(value: unknown, field: string): DomainResult<string> {
  const text = safeText(value, field);
  if (!text.ok) return text;
  if (!text.value.startsWith("/") || text.value.includes("//")) return invalid(field, "expected an absolute path");
  const parts = text.value.split("/").slice(1);
  if (parts.some((part) => part === "." || part === ".." || part.length === 0)) {
    return invalid(field, "path must be normalized and contain no traversal aliases");
  }
  return success(text.value);
}

function identity(value: unknown, field: string): DomainResult<AuxiliaryStateRepositoryIdentity> {
  if (!isRecord(value)) return invalid(field, "expected a repository identity object");
  const host = safeText(value.repositoryHost, `${field}.repositoryHost`);
  if (!host.ok) return host;
  const id = safeText(value.repositoryId, `${field}.repositoryId`);
  if (!id.ok) return id;
  if (value.repository === undefined)
    return success(Object.freeze({ repositoryHost: host.value, repositoryId: id.value }));
  const locator = safeText(value.repository, `${field}.repository`);
  if (!locator.ok) return locator;
  return success(Object.freeze({ repositoryHost: host.value, repositoryId: id.value, repository: locator.value }));
}

function base(value: unknown, field: string): DomainResult<AuxiliaryStateBaseIdentity> {
  if (!isRecord(value)) return invalid(field, "expected a base identity object");
  const branch = safeText(value.branch, `${field}.branch`);
  if (!branch.ok) return branch;
  const baseRevision = revision(value.revision, `${field}.revision`);
  if (!baseRevision.ok) return baseRevision;
  if (value.freshness === undefined) {
    return success(Object.freeze({ branch: branch.value, revision: baseRevision.value }));
  }
  const freshness = safeText(value.freshness, `${field}.freshness`);
  if (!freshness.ok) return freshness;
  return success(Object.freeze({ branch: branch.value, revision: baseRevision.value, freshness: freshness.value }));
}

function selectors(value: unknown, field: string, allowEmpty = true): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 2_048) {
    return invalid(field, "expected a bounded selector array");
  }
  const parsed: string[] = [];
  for (const [index, item] of value.entries()) {
    const result = selector(item, `${field}[${index}]`);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  if (new Set(parsed).size !== parsed.length) return invalid(field, "contains duplicate selectors");
  parsed.sort(compareText);
  return success(Object.freeze(parsed));
}

function concretePaths(value: unknown, field: string, allowEmpty = true): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 2_048) {
    return invalid(field, "expected a bounded array of concrete paths");
  }
  const parsed: string[] = [];
  for (const [index, item] of value.entries()) {
    const result = selector(item, `${field}[${index}]`, false);
    if (!result.ok) return result;
    parsed.push(result.value);
  }
  if (new Set(parsed).size !== parsed.length) return invalid(field, "contains duplicate paths");
  parsed.sort(compareText);
  return success(Object.freeze(parsed));
}

function scope(value: unknown, field: string): DomainResult<AuxiliaryStatePolicyScope> {
  if (!isRecord(value)) return invalid(field, "expected a path-scope object");
  const readOnly = selectors(value.readOnly, `${field}.readOnly`);
  if (!readOnly.ok) return readOnly;
  const write = selectors(value.write, `${field}.write`);
  if (!write.ok) return write;
  const create = selectors(value.create, `${field}.create`);
  if (!create.ok) return create;
  const remove = selectors(value.delete, `${field}.delete`);
  if (!remove.ok) return remove;
  const deny = selectors(value.deny, `${field}.deny`);
  if (!deny.ok) return deny;
  return success(
    Object.freeze({
      readOnly: readOnly.value,
      write: write.value,
      create: create.value,
      delete: remove.value,
      deny: deny.value,
    }),
  );
}

function equalJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function parseProfile(value: unknown): DomainResult<AuxiliaryStatePolicyProfile> {
  if (!isRecord(value)) return invalid("profile", "expected an explicit worktree profile");
  const repository = identity(value.repository, "profile.repository");
  if (!repository.ok) return repository;
  const baseValue = base(value.base, "profile.base");
  if (!baseValue.ok) return baseValue;
  const profileScope = scope(value.scope, "profile.scope");
  if (!profileScope.ok) return profileScope;
  if (value.worktree_root === undefined) {
    return success(Object.freeze({ repository: repository.value, base: baseValue.value, scope: profileScope.value }));
  }
  const root = absolutePath(value.worktree_root, "profile.worktree_root");
  if (!root.ok) return root;
  return success(
    Object.freeze({
      repository: repository.value,
      base: baseValue.value,
      scope: profileScope.value,
      worktree_root: root.value,
    }),
  );
}

function parseEvidence(value: unknown): DomainResult<AuxiliaryStatePolicyEvidence> {
  if (!isRecord(value)) return invalid("evidence", "expected bounded producer evidence");
  const repository = identity(value.repository, "evidence.repository");
  if (!repository.ok) return repository;
  const baseValue = base(value.base, "evidence.base");
  if (!baseValue.ok) return baseValue;
  const covered = selectors(value.covered_scope, "evidence.covered_scope", false);
  if (!covered.ok) return covered;
  const content = concretePaths(value.content_paths, "evidence.content_paths");
  if (!content.ok) return content;
  if (value.root === undefined && value.revision !== undefined) {
    return invalid("evidence.root", "a producer revision requires its actual root");
  }
  if (value.root !== undefined) {
    const root = absolutePath(value.root, "evidence.root");
    if (!root.ok) return root;
  }
  let evidenceRevision: string | undefined;
  if (value.revision !== undefined) {
    const parsedRevision = revision(value.revision, "evidence.revision");
    if (!parsedRevision.ok) return parsedRevision;
    evidenceRevision = parsedRevision.value;
  }
  if (value.tracked_paths !== undefined) {
    const tracked = concretePaths(value.tracked_paths, "evidence.tracked_paths", true);
    if (!tracked.ok) return tracked;
    return success(
      Object.freeze({
        repository: repository.value,
        base: baseValue.value,
        covered_scope: covered.value,
        content_paths: content.value,
        ...(value.root === undefined ? {} : { root: value.root as string }),
        ...(evidenceRevision === undefined ? {} : { revision: evidenceRevision }),
        tracked_paths: tracked.value,
      }),
    );
  }
  return success(
    Object.freeze({
      repository: repository.value,
      base: baseValue.value,
      covered_scope: covered.value,
      content_paths: content.value,
      ...(value.root === undefined ? {} : { root: value.root as string }),
      ...(evidenceRevision === undefined ? {} : { revision: evidenceRevision }),
    }),
  );
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function matches(pattern: string, value: string): boolean {
  return globRegex(pattern).test(value);
}

function processLocalPath(value: string): boolean {
  return value.split("/").some((part) => PROCESS_LOCAL_SEGMENTS.has(part.toLowerCase()));
}

function pathIsDenied(pathValue: string, deny: readonly string[]): boolean {
  return deny.some((pattern) => matches(pattern, pathValue));
}

function pathIsReadVisible(pathValue: string, profile: AuxiliaryStatePolicyProfile): boolean {
  return (
    profile.scope.readOnly.some((pattern) => matches(pattern, pathValue)) &&
    !pathIsDenied(pathValue, profile.scope.deny)
  );
}

function selectorCovered(pathValue: string, covered: readonly string[]): boolean {
  return covered.some((pattern) => matches(pattern, pathValue));
}

function conservativeScopeSubset(covered: string, allowed: readonly string[]): boolean {
  if (allowed.includes("**") || allowed.includes(covered)) return true;
  if (!covered.includes("*") && !covered.includes("?")) return allowed.some((pattern) => matches(pattern, covered));
  if (covered.endsWith("/**")) {
    const prefix = covered.slice(0, -3);
    return allowed.some(
      (pattern) =>
        pattern === covered || pattern === "**" || (pattern.endsWith("/**") && prefix.startsWith(pattern.slice(0, -3))),
    );
  }
  return false;
}

function targetOverlapsTracked(target: string, tracked: readonly string[]): string | undefined {
  return tracked.find(
    (pathValue) => pathValue === target || pathValue.startsWith(`${target}/`) || target.startsWith(`${pathValue}/`),
  );
}

function unsupportedVisibility(
  declaration: AuxiliaryStateDeclaration,
  profile: AuxiliaryStatePolicyProfile,
): DomainResult<AuxiliaryStateVisibility> {
  return success(
    Object.freeze({
      contract_id: AUXILIARY_STATE_POLICY_CONTRACT_ID,
      schema_version: AUXILIARY_STATE_POLICY_SCHEMA_VERSION,
      visibility: "unsupported" as const,
      auxiliary: Object.freeze({
        declaration,
        source_path: declaration.source.path,
        target_path: declaration.target.path,
        mode: "copy" as const,
        durability: "durable" as const,
        access: "READONLY" as const,
        scope: Object.freeze([]),
        deny: Object.freeze(["**"]),
      }),
      provenance: null,
    }),
  );
}

/**
 * Compile explicit auxiliary state, profile authority, and bounded index
 * evidence into a read-only visibility projection.  No filesystem is read
 * here; all authority is represented by the three supplied values.
 */
export function validateAuxiliaryStatePolicy(
  declarationInput: unknown,
  profileInput: unknown,
  evidenceInput: unknown,
): DomainResult<AuxiliaryStateVisibility> {
  const declaration = validateAuxiliaryStateDeclaration(declarationInput);
  if (!declaration.ok) return declaration;
  if (
    declaration.value.source.path.split("/").some((part) => PROCESS_LOCAL_SEGMENTS.has(part.toLowerCase())) ||
    declaration.value.target.path.split("/").some((part) => PROCESS_LOCAL_SEGMENTS.has(part.toLowerCase()))
  ) {
    return invalid("declaration", "process-local sockets, PID files, and logs are not durable auxiliary state");
  }

  const profile = parseProfile(profileInput);
  if (!profile.ok) return profile;
  const evidence = parseEvidence(evidenceInput);
  if (!evidence.ok) return evidence;

  if (!equalJson(profile.value.repository, evidence.value.repository)) {
    return ambiguous("evidence.repository", "does not match the selected profile");
  }
  if (!equalJson(profile.value.base, evidence.value.base)) {
    return ambiguous("evidence.base", "does not match the selected profile base");
  }

  if (evidence.value.tracked_paths !== undefined) {
    const overlap = targetOverlapsTracked(declaration.value.target.path, evidence.value.tracked_paths);
    if (overlap !== undefined) {
      return ambiguous("declaration.target.path", "would shadow Git-tracked content", overlap);
    }
  }

  for (const covered of evidence.value.covered_scope) {
    if (processLocalPath(covered)) return invalid("evidence.covered_scope", "contains process-local state", covered);
    if (pathIsDenied(covered, profile.value.scope.deny)) {
      return ambiguous("evidence.covered_scope", "overlaps an explicit DENY selector", covered);
    }
    if (!conservativeScopeSubset(covered, profile.value.scope.readOnly)) {
      return ambiguous("evidence.covered_scope", "is outside the profile read scope", covered);
    }
  }

  for (const contentPath of evidence.value.content_paths) {
    if (processLocalPath(contentPath))
      return invalid("evidence.content_paths", "contains process-local state", contentPath);
    if (!selectorCovered(contentPath, evidence.value.covered_scope)) {
      return ambiguous("evidence.content_paths", "contains content outside covered_scope", contentPath);
    }
    if (!pathIsReadVisible(contentPath, profile.value)) {
      return ambiguous("evidence.content_paths", "contains content outside the profile read scope", contentPath);
    }
  }

  const root = evidence.value.root;
  const evidenceRevision = evidence.value.revision;
  if (root === undefined || evidenceRevision === undefined)
    return unsupportedVisibility(declaration.value, profile.value);
  if (profile.value.worktree_root === undefined || root !== profile.value.worktree_root) {
    return unsupportedVisibility(declaration.value, profile.value);
  }
  if (evidenceRevision !== profile.value.base.revision) {
    return ambiguous("evidence.revision", "does not match the selected base revision", evidenceRevision);
  }

  const provenance = Object.freeze({
    repository: profile.value.repository,
    base: profile.value.base,
    covered_scope: evidence.value.covered_scope,
    root,
    revision: evidenceRevision,
    evidence_digest: digest(evidence.value),
  });
  const output = Object.freeze({
    contract_id: AUXILIARY_STATE_POLICY_CONTRACT_ID,
    schema_version: AUXILIARY_STATE_POLICY_SCHEMA_VERSION,
    visibility: "bounded" as const,
    auxiliary: Object.freeze({
      declaration: declaration.value,
      source_path: declaration.value.source.path,
      target_path: declaration.value.target.path,
      mode: "copy" as const,
      durability: "durable" as const,
      access: "READONLY" as const,
      scope: evidence.value.covered_scope,
      deny: profile.value.scope.deny,
    }),
    provenance,
  });
  return success(output);
}

export const compileAuxiliaryStatePolicy = validateAuxiliaryStatePolicy;
export const projectAuxiliaryStateVisibility = validateAuxiliaryStatePolicy;

function parseProvenance(value: unknown): DomainResult<AuxiliaryStatePolicyProvenance> {
  if (!isRecord(value)) return invalid("visibility.provenance", "expected a provenance object");
  const repository = identity(value.repository, "visibility.provenance.repository");
  if (!repository.ok) return repository;
  const baseValue = base(value.base, "visibility.provenance.base");
  if (!baseValue.ok) return baseValue;
  const covered = selectors(value.covered_scope, "visibility.provenance.covered_scope", false);
  if (!covered.ok) return covered;
  const root = absolutePath(value.root, "visibility.provenance.root");
  if (!root.ok) return root;
  const provenanceRevision = revision(value.revision, "visibility.provenance.revision");
  if (!provenanceRevision.ok) return provenanceRevision;
  if (typeof value.evidence_digest !== "string" || !/^[0-9a-f]{64}$/u.test(value.evidence_digest)) {
    return invalid("visibility.provenance.evidence_digest", "expected a SHA-256 hexadecimal digest");
  }
  return success(
    Object.freeze({
      repository: repository.value,
      base: baseValue.value,
      covered_scope: covered.value,
      root: root.value,
      revision: provenanceRevision.value,
      evidence_digest: value.evidence_digest,
    }),
  );
}

function validateVisibility(input: unknown): DomainResult<AuxiliaryStateVisibility> {
  if (!isRecord(input)) return invalid("visibility", "expected an object");
  if (input.contract_id !== AUXILIARY_STATE_POLICY_CONTRACT_ID)
    return invalid("visibility.contract_id", "unsupported contract");
  if (input.schema_version !== AUXILIARY_STATE_POLICY_SCHEMA_VERSION)
    return invalid("visibility.schema_version", "unsupported schema version");
  if (!AUXILIARY_STATE_VISIBILITIES.includes(input.visibility as AuxiliaryStateVisibilityKind)) {
    return invalid("visibility.visibility", "expected bounded or unsupported");
  }
  if (!isRecord(input.auxiliary)) return invalid("visibility.auxiliary", "expected an auxiliary projection");
  const declaration = validateAuxiliaryStateDeclaration(input.auxiliary.declaration);
  if (!declaration.ok) return declaration;
  if (input.auxiliary.source_path !== declaration.value.source.path)
    return invalid("visibility.auxiliary.source_path", "does not match declaration");
  if (input.auxiliary.target_path !== declaration.value.target.path)
    return invalid("visibility.auxiliary.target_path", "does not match declaration");
  if (input.auxiliary.mode !== "copy" || input.auxiliary.durability !== "durable")
    return invalid("visibility.auxiliary", "copy and durable are the only supported values");
  if (input.auxiliary.access !== "READONLY") return invalid("visibility.auxiliary.access", "must be READONLY");
  const visibleScope = selectors(input.auxiliary.scope, "visibility.auxiliary.scope");
  if (!visibleScope.ok) return visibleScope;
  const deny = selectors(input.auxiliary.deny, "visibility.auxiliary.deny");
  if (!deny.ok) return deny;
  if (input.visibility === "unsupported" && visibleScope.value.length !== 0) {
    return invalid("visibility.auxiliary.scope", "unsupported visibility cannot grant a scope");
  }
  if (input.visibility === "unsupported" && !equalJson(deny.value, ["**"])) {
    return invalid("visibility.auxiliary.deny", "unsupported visibility must deny all paths");
  }
  if (input.visibility === "bounded" && input.provenance === null) {
    return invalid("visibility.provenance", "bounded visibility requires complete provenance");
  }
  if (input.visibility === "unsupported" && input.provenance !== null) {
    return invalid("visibility.provenance", "unsupported visibility cannot carry provenance");
  }
  const provenance = input.provenance === null ? null : parseProvenance(input.provenance);
  if (provenance !== null && !provenance.ok) return provenance;
  if (provenance !== null && !equalJson(visibleScope.value, provenance.value.covered_scope)) {
    return invalid("visibility.provenance.covered_scope", "does not match the visible auxiliary scope");
  }
  return success(
    Object.freeze({
      contract_id: AUXILIARY_STATE_POLICY_CONTRACT_ID,
      schema_version: AUXILIARY_STATE_POLICY_SCHEMA_VERSION,
      visibility: input.visibility as AuxiliaryStateVisibilityKind,
      auxiliary: Object.freeze({
        declaration: declaration.value,
        source_path: declaration.value.source.path,
        target_path: declaration.value.target.path,
        mode: "copy" as const,
        durability: "durable" as const,
        access: "READONLY" as const,
        scope: visibleScope.value,
        deny: deny.value,
      }),
      provenance: provenance === null ? null : provenance.value,
    }),
  );
}

/** Serialize only a validated visibility projection. */
export function serializeAuxiliaryStatePolicy(input: unknown): DomainResult<string> {
  const visibility = validateVisibility(input);
  return visibility.ok ? success(JSON.stringify(visibility.value)) : failure(visibility.error);
}

export const validateAuxiliaryStateVisibility = validateVisibility;

/** JSON-safe descriptor for contract and architecture consumers. */
export const AUXILIARY_STATE_POLICY_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: AUXILIARY_STATE_POLICY_CONTRACT_ID,
  schema_version: AUXILIARY_STATE_POLICY_SCHEMA_VERSION,
  serialization_key: "auxiliary",
  visibility: ["bounded", "unsupported"],
  operations: [...AUXILIARY_STATE_POLICY_OPERATIONS],
  authority: {
    declaration: "explicit repository-local durable copy only",
    profile: "selected profile read scope and DENY selectors",
    evidence: "repository/base/root/revision/covered_scope/content_paths",
  },
  fail_closed: true,
  process_local_state: "socket, PID, and log paths are not durable auxiliary state",
});
