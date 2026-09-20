import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import { defaultGit } from "../git.js";

/** Versioned identity for repository-local auxiliary state. */
export const AUXILIARY_STATE_PROJECTION_CONTRACT_ID = "nawabari.repository-auxiliary-state-projection.v1" as const;
export const AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION = 1 as const;

/** These vocabularies are deliberately small: host paths and mount semantics are not contract values. */
export const AUXILIARY_STATE_SOURCE_KINDS = Object.freeze(["repository-local"] as const);
export const AUXILIARY_STATE_TARGET_KINDS = Object.freeze(["managed-worktree"] as const);
export const AUXILIARY_STATE_MODES = Object.freeze(["copy"] as const);
export const AUXILIARY_STATE_DURABILITY_CLASSES = Object.freeze(["durable"] as const);

export type AuxiliaryStateSourceKind = (typeof AUXILIARY_STATE_SOURCE_KINDS)[number];
export type AuxiliaryStateTargetKind = (typeof AUXILIARY_STATE_TARGET_KINDS)[number];
export type AuxiliaryStateMode = (typeof AUXILIARY_STATE_MODES)[number];
export type AuxiliaryStateDurabilityClass = (typeof AUXILIARY_STATE_DURABILITY_CLASSES)[number];

export type AuxiliaryStateDeclaration = Readonly<{
  readonly contract_id: typeof AUXILIARY_STATE_PROJECTION_CONTRACT_ID;
  readonly schema_version: typeof AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION;
  readonly source: Readonly<{
    readonly kind: AuxiliaryStateSourceKind;
    /** Repository-relative path in the authoritative checkout. */
    readonly path: string;
  }>;
  readonly target: Readonly<{
    readonly kind: AuxiliaryStateTargetKind;
    /** Repository-relative path in the owned managed worktree. */
    readonly path: string;
  }>;
  readonly mode: AuxiliaryStateMode;
  /** Process-local sockets, PID files, and logs are not durable auxiliary state. */
  readonly durability: AuxiliaryStateDurabilityClass;
}>;

export type AuxiliaryStateMaterializationContext = Readonly<{
  /** Canonical authoritative checkout containing the declared source. */
  readonly repository_root: string;
  /** Canonical owned managed worktree receiving the declared target. */
  readonly worktree_root: string;
  /** Evidence issued by the authoritative Git resolver for repository_root. */
  readonly tracked_path_evidence: AuxiliaryStateTrackedPathEvidence;
}>;

export type AuxiliaryStateMaterialization = Readonly<{
  readonly declaration: AuxiliaryStateDeclaration;
  readonly source_path: string;
  readonly target_path: string;
  readonly mode: AuxiliaryStateMode;
}>;

export type AuxiliaryStateProjectionErrorCode = Extract<
  ErrorCode,
  "AUXILIARY_STATE_INVALID" | "AUXILIARY_STATE_AMBIGUOUS" | "AUXILIARY_STATE_MATERIALIZATION_FAILED"
>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("AUXILIARY_STATE_INVALID", `Auxiliary state field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("AUXILIARY_STATE_AMBIGUOUS", `Auxiliary state field '${field}' is ambiguous: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function materializationFailure(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError(
      "AUXILIARY_STATE_MATERIALIZATION_FAILED",
      `Auxiliary state materialization '${field}' failed: ${reason}.`,
      { field, ...(value === undefined ? {} : { value }) },
    ),
  );
}

function relativePath(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return invalid(field, "expected a non-empty repository-relative path");
  }
  if (path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === ".") {
    return invalid(field, "path must be normalized, relative, and contain no traversal aliases", value);
  }
  if (value.split("/").some((part) => part === ".." || part.length === 0)) {
    return invalid(field, "path must not contain traversal or empty segments", value);
  }
  return success(value);
}

/**
 * Git-authoritative tracked-path evidence. The module-private constructor token
 * and private brand prevent ordinary callers from manufacturing the evidence
 * consumed by materialization; use the Git resolver instead.
 */
const trackedPathEvidenceToken = Symbol("auxiliary-state-tracked-path-evidence");

export class AuxiliaryStateTrackedPathEvidence {
  readonly #authority = true;

  public constructor(
    token: typeof trackedPathEvidenceToken,
    private readonly repository_root: string,
    private readonly tracked_paths: readonly string[],
  ) {
    if (token !== trackedPathEvidenceToken) throw new Error("tracked-path evidence must come from the Git resolver");
  }

  public repositoryRoot(): string {
    void this.#authority;
    return this.repository_root;
  }

  public paths(): readonly string[] {
    void this.#authority;
    return this.tracked_paths;
  }
}

function issueTrackedPathEvidence(
  repositoryRoot: string,
  trackedPaths: readonly string[],
): AuxiliaryStateTrackedPathEvidence {
  return new AuxiliaryStateTrackedPathEvidence(
    trackedPathEvidenceToken,
    repositoryRoot,
    Object.freeze([...trackedPaths]),
  );
}

/** Validate and canonicalize a declaration without touching the filesystem. */
export function validateAuxiliaryStateDeclaration(input: unknown): DomainResult<AuxiliaryStateDeclaration> {
  if (!isRecord(input)) return invalid("declaration", "expected an object");
  if ("contract_id" in input && input.contract_id !== AUXILIARY_STATE_PROJECTION_CONTRACT_ID) {
    return invalid("contract_id", "does not match the canonical auxiliary-state contract");
  }
  if ("schema_version" in input && input.schema_version !== AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION) {
    return invalid("schema_version", "does not match the canonical auxiliary-state schema");
  }
  if (!isRecord(input.source)) return invalid("source", "expected a repository-local source descriptor");
  if (input.source.kind !== "repository-local") return invalid("source.kind", "expected 'repository-local'");
  const sourcePath = relativePath(input.source.path, "source.path");
  if (!sourcePath.ok) return sourcePath;

  if (!isRecord(input.target)) return invalid("target", "expected a managed-worktree target descriptor");
  if (input.target.kind !== "managed-worktree") return invalid("target.kind", "expected 'managed-worktree'");
  const targetPath = relativePath(input.target.path, "target.path");
  if (!targetPath.ok) return targetPath;
  if (input.mode !== "copy") return invalid("mode", "expected the bounded 'copy' materialization mode");
  if (input.durability !== "durable") {
    return invalid("durability", "process-local state is not supported by this contract");
  }
  if (sourcePath.value === ".git" || sourcePath.value.startsWith(".git/")) {
    return invalid("source.path", "Git administrative state is not repository-local auxiliary state", sourcePath.value);
  }
  if (targetPath.value === ".git" || targetPath.value.startsWith(".git/")) {
    return invalid("target.path", "Git administrative state cannot be projected", targetPath.value);
  }

  return success(
    Object.freeze({
      contract_id: AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
      schema_version: AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
      source: Object.freeze({ kind: "repository-local", path: sourcePath.value }),
      target: Object.freeze({ kind: "managed-worktree", path: targetPath.value }),
      mode: "copy",
      durability: "durable",
    }),
  );
}

export const projectAuxiliaryStateDeclaration = validateAuxiliaryStateDeclaration;
export const validateRepositoryAuxiliaryState = validateAuxiliaryStateDeclaration;

function canonicalRoot(value: string, field: string): string {
  if (!path.isAbsolute(value) || value.includes("\u0000") || path.normalize(value) !== value) {
    throw new Error(`${field} must be an absolute normalized path`);
  }
  const resolved = fs.realpathSync.native(value);
  if (resolved !== value) throw new Error(`${field} resolves through a symlink`);
  return resolved;
}

/**
 * Resolve tracked paths from Git's index. Ignored and untracked content is
 * intentionally absent from this evidence; callers cannot substitute an
 * arbitrary array for the resolver-issued authority token.
 */
export function resolveAuxiliaryStateTrackedPathEvidence(
  repositoryRoot: string,
): DomainResult<AuxiliaryStateTrackedPathEvidence> {
  try {
    const canonicalRepositoryRoot = canonicalRoot(repositoryRoot, "repository_root");
    const output = defaultGit.runRaw
      ? defaultGit.runRaw(["ls-files", "--cached", "--full-name", "-z", "--"], canonicalRepositoryRoot)
      : defaultGit.run(["ls-files", "--cached", "--full-name", "-z", "--"], canonicalRepositoryRoot);
    const trackedPaths: string[] = [];
    for (const [index, value] of output.split("\u0000").entries()) {
      if (value.length === 0) continue;
      const tracked = relativePath(value, `tracked_paths[${index}]`);
      if (!tracked.ok) return failure(tracked.error);
      trackedPaths.push(tracked.value);
    }
    return success(issueTrackedPathEvidence(canonicalRepositoryRoot, trackedPaths));
  } catch (error: unknown) {
    return failure(
      new DomainError(
        "AUXILIARY_STATE_MATERIALIZATION_FAILED",
        `Auxiliary state materialization 'tracked_paths' failed: ${
          error instanceof Error ? error.message : "Git authority was unavailable"
        }.`,
        { field: "tracked_paths" },
      ),
    );
  }
}

function within(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function assertNoSymlinkComponents(candidate: string, root: string): void {
  let current = root;
  const relative = path.relative(root, candidate);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("path resolves through a symlink");
  }
}

function assertNoSymlinksRecursively(candidate: string): void {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error("source contains a symlink");
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(candidate)) assertNoSymlinksRecursively(path.join(candidate, entry));
}

function trackedOverlap(target: string, trackedPaths: readonly string[]): string | undefined {
  for (const tracked of trackedPaths) {
    if (tracked === target || tracked.startsWith(`${target}/`) || target.startsWith(`${tracked}/`)) return tracked;
  }
  return undefined;
}

/**
 * Materialize one declared auxiliary state tree. This authority consumes only
 * the declaration and explicit tracked-path evidence; it never scans ignored
 * state, discovers host paths, or changes SessionRuntimeProjection.
 */
export function materializeAuxiliaryStateProjection(
  input: unknown,
  context: AuxiliaryStateMaterializationContext,
): DomainResult<AuxiliaryStateMaterialization> {
  const declaration = validateAuxiliaryStateDeclaration(input);
  if (!declaration.ok) return declaration;
  if (!isRecord(context)) return materializationFailure("context", "expected an explicit materialization context");
  if (!(context.tracked_path_evidence instanceof AuxiliaryStateTrackedPathEvidence)) {
    return materializationFailure("tracked_paths", "expected resolver-issued Git tracked-path evidence");
  }
  try {
    const repositoryRoot = canonicalRoot(context.repository_root, "repository_root");
    const worktreeRoot = canonicalRoot(context.worktree_root, "worktree_root");
    if (repositoryRoot === worktreeRoot)
      return materializationFailure("worktree_root", "must differ from repository_root");
    const evidenceRepositoryRoot = context.tracked_path_evidence.repositoryRoot();
    if (evidenceRepositoryRoot !== repositoryRoot) {
      return materializationFailure("tracked_paths", "evidence belongs to a different repository");
    }
    const trackedPaths = context.tracked_path_evidence.paths();

    const sourcePath = path.resolve(repositoryRoot, declaration.value.source.path);
    const targetPath = path.resolve(worktreeRoot, declaration.value.target.path);
    if (!within(repositoryRoot, sourcePath)) return materializationFailure("source.path", "escapes repository root");
    if (!within(worktreeRoot, targetPath)) return materializationFailure("target.path", "escapes managed worktree");
    assertNoSymlinkComponents(sourcePath, repositoryRoot);
    if (!fs.existsSync(sourcePath))
      return materializationFailure("source.path", "declared source is absent", sourcePath);
    assertNoSymlinksRecursively(sourcePath);
    const targetRelative = path.relative(worktreeRoot, targetPath).split(path.sep).join("/");
    const overlap = trackedOverlap(targetRelative, trackedPaths);
    if (overlap !== undefined)
      return ambiguous("target.path", "target overlaps a Git-tracked path or directory anchor", overlap);

    const parent = path.dirname(targetPath);
    let existingParent = parent;
    while (!fs.existsSync(existingParent)) {
      const next = path.dirname(existingParent);
      if (next === existingParent) return materializationFailure("target.path", "target parent cannot be resolved");
      existingParent = next;
    }
    const parentCanonical = fs.realpathSync.native(existingParent);
    if (!within(worktreeRoot, parentCanonical))
      return materializationFailure("target.path", "target parent escapes managed worktree");
    assertNoSymlinkComponents(existingParent, worktreeRoot);
    if (fs.existsSync(targetPath) || fs.lstatSync(targetPath, { throwIfNoEntry: false }) !== undefined) {
      return ambiguous("target.path", "materialization would replace existing state", targetPath);
    }
    fs.mkdirSync(parent, { recursive: true });
    fs.cpSync(sourcePath, targetPath, { recursive: true, force: false, errorOnExist: true, dereference: false });
    assertNoSymlinkComponents(targetPath, worktreeRoot);
    return success(
      Object.freeze({ declaration: declaration.value, source_path: sourcePath, target_path: targetPath, mode: "copy" }),
    );
  } catch (error: unknown) {
    return materializationFailure(
      "materialization",
      error instanceof Error ? error.message : "filesystem operation failed",
    );
  }
}

export const materializeAuxiliaryState = materializeAuxiliaryStateProjection;

export function serializeAuxiliaryStateDeclaration(input: unknown): DomainResult<string> {
  const declaration = validateAuxiliaryStateDeclaration(input);
  return declaration.ok ? success(JSON.stringify(declaration.value)) : failure(declaration.error);
}

export function isAuxiliaryStateProjectionError(
  error: DomainError,
): error is DomainError & { readonly code: AuxiliaryStateProjectionErrorCode } {
  return (
    error.code === "AUXILIARY_STATE_INVALID" ||
    error.code === "AUXILIARY_STATE_AMBIGUOUS" ||
    error.code === "AUXILIARY_STATE_MATERIALIZATION_FAILED"
  );
}

/** JSON-safe descriptor for machine-contract and architecture consumers. */
export const AUXILIARY_STATE_PROJECTION_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: AUXILIARY_STATE_PROJECTION_CONTRACT_ID,
  schema_version: AUXILIARY_STATE_PROJECTION_SCHEMA_VERSION,
  source_kinds: [...AUXILIARY_STATE_SOURCE_KINDS],
  target_kinds: [...AUXILIARY_STATE_TARGET_KINDS],
  modes: [...AUXILIARY_STATE_MODES],
  durability_classes: [...AUXILIARY_STATE_DURABILITY_CLASSES],
  source_authority: "repository-local declaration only; no implicit ignored-state discovery",
  target_authority: "owned managed worktree, repository-relative and fail-closed",
  tracked_path_policy: "Git-authoritative paths and directory anchors cannot be shadowed",
  process_local_state: "not durable auxiliary state and not projected by this contract",
});
