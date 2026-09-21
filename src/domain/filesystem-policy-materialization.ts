import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import {
  validateWorkingSetRuntimeProjection,
  type WorkingSetRuntimeProjection,
  type WorkingSetRuntimeOperation,
} from "./working-set-runtime-projection.js";

/** Versioned boundary for the concrete working-set filesystem materializer. */
export const FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID = "nawabari.filesystem-policy-materialization.v1" as const;
export const FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION = 1 as const;

/** Stable serialization key used by the runtime working-set handoff. */
export const FILESYSTEM_POLICY_SERIALIZATION_KEY = "working-set-runtime" as const;

const DEFAULT_MAX_SELECTORS = 2_048;
const DEFAULT_MAX_PATHS = 4_096;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_DIAGNOSTICS = 256;
const UNSUPPORTED_SELECTOR = /[\[\]{}()]/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export type FilesystemPolicyResolutionLimits = Readonly<{
  readonly maxSelectors?: number;
  readonly maxPaths?: number;
  readonly maxDepth?: number;
  readonly maxDiagnostics?: number;
}>;

export type FilesystemPolicyPathIdentity = Readonly<{
  /** Values are decimal strings so the evidence is JSON-safe. */
  readonly device: string;
  readonly inode: string;
}>;

export type FilesystemPolicyParentEvidence = Readonly<{
  readonly path: string;
  readonly identity: FilesystemPolicyPathIdentity;
}>;

export type FilesystemPolicyResolvedPath = Readonly<{
  readonly selector: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly kind: "file" | "directory";
  readonly identity: FilesystemPolicyPathIdentity;
  readonly parent: FilesystemPolicyParentEvidence;
}>;

export type FilesystemPolicyResolutionCode =
  | "INVALID_SELECTOR"
  | "UNSUPPORTED_SELECTOR"
  | "SYMLINK"
  | "ALIAS"
  | "OUTSIDE_WORKTREE"
  | "UNREADABLE"
  | "DIRECTORY_SCAN_FAILED"
  | "NON_REGULAR_ENTRY";

export type FilesystemPolicyResolutionDiagnostic = Readonly<{
  readonly selector: string;
  readonly path?: string;
  readonly code: FilesystemPolicyResolutionCode;
  readonly message: string;
}>;

/**
 * Physical evidence for selector expansion.  `complete` is deliberately
 * false whenever any observation is not proven; consumers must not grant the
 * successfully observed subset in that case.
 */
export type WorkingSetPathResolutionEvidence = Readonly<{
  readonly worktree: string;
  readonly selectors: readonly string[];
  readonly resolved: readonly FilesystemPolicyResolvedPath[];
  readonly missingExact: readonly string[];
  readonly unsupported: readonly FilesystemPolicyResolutionDiagnostic[];
  readonly unreadable: readonly FilesystemPolicyResolutionDiagnostic[];
  readonly truncated: boolean;
  readonly complete: boolean;
}>;

export type FilesystemPolicyRule = Readonly<{
  readonly selector: string;
  readonly relativePath: string;
  readonly operation: "READONLY" | "WRITE";
  readonly kind: "native-path-rule" | "native-namespace";
}>;

export type FilesystemPolicyRegistryOperation = Readonly<{
  readonly selector: string;
  readonly relativePath: string;
  readonly operation: "CREATE" | "DELETE" | "RENAME" | "ATOMIC_REPLACEMENT";
  readonly parent?: FilesystemPolicyParentEvidence;
}>;

export type FilesystemPolicyUnsupportedCapability = Readonly<{
  readonly selector: string;
  readonly operation: WorkingSetRuntimeOperation | "RENAME" | "ATOMIC_REPLACEMENT";
  readonly reason: string;
}>;

export type FilesystemPolicyEnforcementSelection = Readonly<{
  readonly status: "representable" | "unsupported";
  readonly nativePathRules: readonly FilesystemPolicyRule[];
  readonly nativeNamespace: readonly FilesystemPolicyRule[];
  readonly registryOperations: readonly FilesystemPolicyRegistryOperation[];
  readonly unsupported: readonly FilesystemPolicyUnsupportedCapability[];
}>;

/** Pure plan consumed by the later sandbox/registry integration surfaces. */
export type FilesystemPolicyPlan = Readonly<{
  readonly worktree: string;
  readonly workingSet: WorkingSetRuntimeProjection;
  readonly resolution: WorkingSetPathResolutionEvidence;
  readonly rules: readonly FilesystemPolicyRule[];
  readonly registryOperations: readonly FilesystemPolicyRegistryOperation[];
  readonly unsupported: readonly FilesystemPolicyUnsupportedCapability[];
}>;

export type MaterializedFilesystemPolicy = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION;
  readonly serialization_key: typeof FILESYSTEM_POLICY_SERIALIZATION_KEY;
  readonly worktree: string;
  readonly working_set: WorkingSetRuntimeProjection;
  readonly resolution: WorkingSetPathResolutionEvidence;
  readonly rules: readonly FilesystemPolicyRule[];
  readonly registry_operations: readonly FilesystemPolicyRegistryOperation[];
  readonly unsupported: readonly FilesystemPolicyUnsupportedCapability[];
  readonly digest: string;
}>;

const MATERIALIZED_POLICY_FIELDS = Object.freeze([
  "contract_id",
  "schema_version",
  "serialization_key",
  "worktree",
  "working_set",
  "resolution",
  "rules",
  "registry_operations",
  "unsupported",
  "digest",
] as const);
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]*)$/u;
const DIGEST_TEXT = /^[0-9a-f]{64}$/u;

function runtimePolicyInvalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Filesystem policy field '${field}' is invalid: ${reason}.`, {}),
  );
}

function requiredRecord(value: unknown, field: string): DomainResult<Record<string, unknown>> {
  if (!isRecord(value)) return runtimePolicyInvalid(field, "expected an object");
  return success(value);
}

function requiredArray(value: unknown, field: string): DomainResult<readonly unknown[]> {
  if (!Array.isArray(value)) return runtimePolicyInvalid(field, "expected an array");
  return success(value);
}

function requiredText(value: unknown, field: string, allowEmpty = false): DomainResult<string> {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > 4_096 ||
    CONTROL_CHARACTER.test(value)
  ) {
    return runtimePolicyInvalid(field, "expected bounded text");
  }
  return success(value);
}

function canonicalAbsoluteText(value: unknown, field: string): DomainResult<string> {
  const text = requiredText(value, field);
  if (!text.ok) return text;
  if (!path.isAbsolute(text.value) || path.normalize(text.value) !== text.value) {
    return runtimePolicyInvalid(field, "expected a normalized absolute path");
  }
  return text;
}

function canonicalRelativeText(value: unknown, field: string): DomainResult<string> {
  const text = requiredText(value, field, true);
  if (!text.ok) return text;
  if (
    path.posix.isAbsolute(text.value) ||
    text.value === "." ||
    path.posix.normalize(text.value) !== text.value ||
    text.value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return runtimePolicyInvalid(field, "expected a normalized worktree-relative path");
  }
  return text;
}

function withinPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validatePathIdentity(value: unknown, field: string): DomainResult<FilesystemPolicyPathIdentity> {
  const record = requiredRecord(value, field);
  if (!record.ok) return record;
  const device = requiredText(record.value.device, `${field}.device`);
  if (!device.ok || !DECIMAL_TEXT.test(device.value))
    return runtimePolicyInvalid(`${field}.device`, "expected decimal text");
  const inode = requiredText(record.value.inode, `${field}.inode`);
  if (!inode.ok || !DECIMAL_TEXT.test(inode.value))
    return runtimePolicyInvalid(`${field}.inode`, "expected decimal text");
  return success(Object.freeze({ device: device.value, inode: inode.value }));
}

function validateParentEvidence(
  value: unknown,
  field: string,
  worktree: string,
): DomainResult<FilesystemPolicyParentEvidence> {
  const record = requiredRecord(value, field);
  if (!record.ok) return record;
  const parent = canonicalAbsoluteText(record.value.path, `${field}.path`);
  if (!parent.ok) return parent;
  if (!withinPath(worktree, parent.value)) return runtimePolicyInvalid(`${field}.path`, "escaped the policy worktree");
  const identityValue = validatePathIdentity(record.value.identity, `${field}.identity`);
  if (!identityValue.ok) return identityValue;
  return success(Object.freeze({ path: parent.value, identity: identityValue.value }));
}

function validateResolutionEvidence(value: unknown, worktree: string): DomainResult<WorkingSetPathResolutionEvidence> {
  const record = requiredRecord(value, "resolution");
  if (!record.ok) return record;
  const resolutionWorktree = canonicalAbsoluteText(record.value.worktree, "resolution.worktree");
  if (!resolutionWorktree.ok) return resolutionWorktree;
  if (resolutionWorktree.value !== worktree)
    return runtimePolicyInvalid("resolution.worktree", "does not match worktree");
  const selectors = requiredArray(record.value.selectors, "resolution.selectors");
  if (!selectors.ok) return selectors;
  const resolved = requiredArray(record.value.resolved, "resolution.resolved");
  if (!resolved.ok) return resolved;
  const missingExact = requiredArray(record.value.missingExact, "resolution.missingExact");
  if (!missingExact.ok) return missingExact;
  const unsupported = requiredArray(record.value.unsupported, "resolution.unsupported");
  if (!unsupported.ok) return unsupported;
  const unreadable = requiredArray(record.value.unreadable, "resolution.unreadable");
  if (!unreadable.ok) return unreadable;
  if (typeof record.value.truncated !== "boolean" || typeof record.value.complete !== "boolean") {
    return runtimePolicyInvalid("resolution", "truncated and complete must be booleans");
  }
  for (const [index, selector] of selectors.value.entries()) {
    const checked = canonicalRelativeText(selector, `resolution.selectors[${index}]`);
    if (!checked.ok) return checked;
  }
  for (const [index, selector] of missingExact.value.entries()) {
    const checked = canonicalRelativeText(selector, `resolution.missingExact[${index}]`);
    if (!checked.ok) return checked;
  }
  for (const [index, value] of resolved.value.entries()) {
    const entry = requiredRecord(value, `resolution.resolved[${index}]`);
    if (!entry.ok) return entry;
    const selector = canonicalRelativeText(entry.value.selector, `resolution.resolved[${index}].selector`);
    if (!selector.ok) return selector;
    const relativePath = canonicalRelativeText(entry.value.relativePath, `resolution.resolved[${index}].relativePath`);
    if (!relativePath.ok) return relativePath;
    const absolutePath = canonicalAbsoluteText(entry.value.absolutePath, `resolution.resolved[${index}].absolutePath`);
    if (!absolutePath.ok) return absolutePath;
    if (
      !withinPath(worktree, absolutePath.value) ||
      path.resolve(worktree, relativePath.value) !== absolutePath.value
    ) {
      return runtimePolicyInvalid(`resolution.resolved[${index}]`, "path escaped or disagreed with the worktree");
    }
    if (entry.value.kind !== "file" && entry.value.kind !== "directory") {
      return runtimePolicyInvalid(`resolution.resolved[${index}].kind`, "expected file or directory");
    }
    const identityValue = validatePathIdentity(entry.value.identity, `resolution.resolved[${index}].identity`);
    if (!identityValue.ok) return identityValue;
    const parent = validateParentEvidence(entry.value.parent, `resolution.resolved[${index}].parent`, worktree);
    if (!parent.ok) return parent;
  }
  for (const [kind, values] of [
    ["unsupported", unsupported.value],
    ["unreadable", unreadable.value],
  ] as const) {
    for (const [index, value] of values.entries()) {
      const diagnosticValue = requiredRecord(value, `resolution.${kind}[${index}]`);
      if (!diagnosticValue.ok) return diagnosticValue;
      const selector = canonicalRelativeText(diagnosticValue.value.selector, `resolution.${kind}[${index}].selector`);
      if (!selector.ok) return selector;
      if (diagnosticValue.value.path !== undefined) {
        const diagnosticPath = canonicalAbsoluteText(diagnosticValue.value.path, `resolution.${kind}[${index}].path`);
        if (!diagnosticPath.ok) return diagnosticPath;
        if (!withinPath(worktree, diagnosticPath.value))
          return runtimePolicyInvalid(`resolution.${kind}[${index}].path`, "escaped the worktree");
      }
      const code = requiredText(diagnosticValue.value.code, `resolution.${kind}[${index}].code`);
      if (!code.ok) return code;
      const message = requiredText(diagnosticValue.value.message, `resolution.${kind}[${index}].message`);
      if (!message.ok) return message;
    }
  }
  return success(record.value as unknown as WorkingSetPathResolutionEvidence);
}

function materializedPolicyDigestPayload(
  input: Pick<
    MaterializedFilesystemPolicy,
    "worktree" | "working_set" | "resolution" | "rules" | "registry_operations" | "unsupported"
  >,
): object {
  return {
    contract_id: FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION,
    serialization_key: FILESYSTEM_POLICY_SERIALIZATION_KEY,
    worktree: input.worktree,
    working_set: input.working_set,
    resolution: input.resolution,
    rules: input.rules,
    registry_operations: input.registry_operations,
    unsupported: input.unsupported,
  };
}

type SelectorScope = Readonly<{
  readonly readOnly: readonly string[];
  readonly write: readonly string[];
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
}>;

type ResolutionState = {
  readonly resolved: FilesystemPolicyResolvedPath[];
  readonly missingExact: string[];
  readonly unsupported: FilesystemPolicyResolutionDiagnostic[];
  readonly unreadable: FilesystemPolicyResolutionDiagnostic[];
  truncated: boolean;
  pathCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelectorScope(value: readonly string[] | SelectorScope): value is SelectorScope {
  return !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function boundedLimit(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function limitsOf(value: FilesystemPolicyResolutionLimits | undefined): Required<FilesystemPolicyResolutionLimits> {
  return {
    maxSelectors: boundedLimit(value?.maxSelectors, DEFAULT_MAX_SELECTORS),
    maxPaths: boundedLimit(value?.maxPaths, DEFAULT_MAX_PATHS),
    maxDepth: boundedLimit(value?.maxDepth, DEFAULT_MAX_DEPTH),
    maxDiagnostics: boundedLimit(value?.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS),
  };
}

function diagnostic(
  state: ResolutionState,
  limits: Required<FilesystemPolicyResolutionLimits>,
  destination: "unsupported" | "unreadable",
  value: FilesystemPolicyResolutionDiagnostic,
): void {
  const entries = state[destination];
  if (entries.length < limits.maxDiagnostics) entries.push(Object.freeze(value));
  else state.truncated = true;
}

function normalizeSelector(value: unknown): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || CONTROL_CHARACTER.test(value)) {
    return { ok: false, reason: "selector is not bounded text" };
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return { ok: false, reason: "selector is not repository-relative" };
  }
  if (UNSUPPORTED_SELECTOR.test(normalized)) return { ok: false, reason: "selector uses unsupported glob syntax" };
  return { ok: true, value: normalized };
}

function globRegex(selector: string): RegExp {
  let source = "^";
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] as string;
    if (character === "*" && selector[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function literalPrefix(selector: string): string {
  const wildcard = selector.search(/[?*]/u);
  const prefix = wildcard === -1 ? selector : selector.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash);
}

function identity(stat: fs.BigIntStats): FilesystemPolicyPathIdentity {
  return Object.freeze({ device: stat.dev.toString(10), inode: stat.ino.toString(10) });
}

function sameIdentity(left: FilesystemPolicyPathIdentity, right: FilesystemPolicyPathIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function observeParentDirectory(worktree: string, candidate: string): FilesystemPolicyParentEvidence | null {
  const parent = path.dirname(candidate);
  let descriptor: number | undefined;
  try {
    const canonicalWorktree = path.resolve(worktree);
    const canonicalParent = fs.realpathSync.native(parent);
    const relative = path.relative(canonicalWorktree, canonicalParent);
    if (
      canonicalParent !== path.resolve(parent) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    descriptor = fs.openSync(parent, fs.constants.O_RDONLY | noFollowFlag() | fs.constants.O_DIRECTORY);
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isDirectory()) return null;
    return Object.freeze({ path: parent, identity: identity(stat) });
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the conservative observation result.
      }
    }
  }
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
}

function inspectEntry(
  worktree: string,
  candidate: string,
  selector: string,
):
  | { ok: true; value: FilesystemPolicyResolvedPath }
  | { ok: false; destination: "unsupported" | "unreadable"; value: FilesystemPolicyResolutionDiagnostic } {
  let entry: fs.BigIntStats;
  try {
    entry = fs.lstatSync(candidate, { bigint: true });
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
    return {
      ok: false,
      destination: code === "EACCES" || code === "EPERM" ? "unreadable" : "unsupported",
      value: Object.freeze({
        selector,
        path: candidate,
        code: code === "EACCES" || code === "EPERM" ? "UNREADABLE" : "NON_REGULAR_ENTRY",
        message: `Unable to inspect selector entry (${code}).`,
      }),
    };
  }
  if (entry.isSymbolicLink()) {
    return {
      ok: false,
      destination: "unsupported",
      value: Object.freeze({ selector, path: candidate, code: "SYMLINK", message: "Symlink entries are fail-closed." }),
    };
  }
  const kind = entry.isFile() ? "file" : entry.isDirectory() ? "directory" : null;
  if (kind === null) {
    return {
      ok: false,
      destination: "unsupported",
      value: Object.freeze({
        selector,
        path: candidate,
        code: "NON_REGULAR_ENTRY",
        message: "Only regular files and directories are representable.",
      }),
    };
  }

  let canonical: string;
  let descriptor: number | undefined;
  let parentDescriptor: number | undefined;
  try {
    canonical = fs.realpathSync.native(candidate);
    const expected = path.resolve(candidate);
    const canonicalWorktree = path.resolve(worktree);
    const relativeCanonical = path.relative(canonicalWorktree, canonical);
    if (canonical !== expected || relativeCanonical === ".." || relativeCanonical.startsWith(`..${path.sep}`)) {
      return {
        ok: false,
        destination: "unsupported",
        value: Object.freeze({
          selector,
          path: candidate,
          code: "OUTSIDE_WORKTREE",
          message: "The selected entry is not a canonical path within the worktree.",
        }),
      };
    }
    const flags = fs.constants.O_RDONLY | noFollowFlag() | (kind === "directory" ? fs.constants.O_DIRECTORY : 0);
    descriptor = fs.openSync(candidate, flags);
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    const entryIdentity = identity(entry);
    if (!sameIdentity(entryIdentity, identity(descriptorStat))) {
      return {
        ok: false,
        destination: "unsupported",
        value: Object.freeze({
          selector,
          path: candidate,
          code: "ALIAS",
          message: "The pathname changed while physical identity was being observed.",
        }),
      };
    }
    const parentPath = path.dirname(candidate);
    parentDescriptor = fs.openSync(parentPath, fs.constants.O_RDONLY | noFollowFlag() | fs.constants.O_DIRECTORY);
    const parentStat = fs.fstatSync(parentDescriptor, { bigint: true });
    if (!parentStat.isDirectory()) throw new Error("parent is not a directory");
    return {
      ok: true,
      value: Object.freeze({
        selector,
        relativePath: path.relative(canonicalWorktree, candidate).split(path.sep).join("/"),
        absolutePath: candidate,
        kind,
        identity: entryIdentity,
        parent: Object.freeze({ path: parentPath, identity: identity(parentStat) }),
      }),
    };
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
    return {
      ok: false,
      destination: "unreadable",
      value: Object.freeze({
        selector,
        path: candidate,
        code: "UNREADABLE",
        message: `The selected entry or its parent could not be opened (${code}).`,
      }),
    };
  } finally {
    for (const handle of [descriptor, parentDescriptor]) {
      if (handle !== undefined) {
        try {
          fs.closeSync(handle);
        } catch {
          // The observation result is already determined; close failures do
          // not justify pathname-based cleanup or a broader grant.
        }
      }
    }
  }
}

function scanDirectory(
  root: string,
  selector: string,
  worktree: string,
  matcher: RegExp,
  limits: Required<FilesystemPolicyResolutionLimits>,
  state: ResolutionState,
  depth: number,
): void {
  if (state.truncated || depth > limits.maxDepth) {
    state.truncated = true;
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => compareText(left.name, right.name));
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
    if (code !== "ENOENT") {
      diagnostic(state, limits, "unreadable", {
        selector,
        path: root,
        code: "DIRECTORY_SCAN_FAILED",
        message: `Directory expansion failed (${code}).`,
      });
    }
    return;
  }
  for (const entry of entries) {
    if (state.truncated) return;
    const candidate = path.join(root, entry.name);
    const relative = path.relative(worktree, candidate).split(path.sep).join("/");
    if (entry.isSymbolicLink()) {
      if (matcher.test(relative)) {
        diagnostic(state, limits, "unsupported", {
          selector,
          path: candidate,
          code: "SYMLINK",
          message: "Symlink entries are fail-closed.",
        });
      }
      continue;
    }
    if (matcher.test(relative)) {
      if (state.pathCount >= limits.maxPaths) {
        state.truncated = true;
        return;
      }
      const observed = inspectEntry(worktree, candidate, selector);
      if (observed.ok) {
        state.resolved.push(observed.value);
        state.pathCount += 1;
      } else diagnostic(state, limits, observed.destination, observed.value);
    }
    if (entry.isDirectory()) scanDirectory(candidate, selector, worktree, matcher, limits, state, depth + 1);
  }
}

function emptyResolution(worktree: string, selectors: readonly string[]): WorkingSetPathResolutionEvidence {
  return Object.freeze({
    worktree,
    selectors: Object.freeze([...selectors]),
    resolved: Object.freeze([]),
    missingExact: Object.freeze([]),
    unsupported: Object.freeze([]),
    unreadable: Object.freeze([]),
    truncated: false,
    complete: true,
  });
}

/**
 * Resolve a bounded selector list while retaining every physical observation
 * needed by a fail-closed policy compiler.  This function intentionally
 * returns incomplete evidence instead of silently throwing away a partial
 * expansion; callers must inspect `complete` before issuing authority.
 */
export function resolveWorkingSetPathsWithEvidence(
  worktree: string,
  selectors: readonly string[] | SelectorScope,
  requestedLimits: FilesystemPolicyResolutionLimits = {},
): WorkingSetPathResolutionEvidence {
  const limits = limitsOf(requestedLimits);
  const rawSelectors = isSelectorScope(selectors)
    ? [...selectors.readOnly, ...selectors.write, ...selectors.create, ...selectors.delete, ...selectors.deny]
    : selectors;
  const normalizedWorktree = path.resolve(worktree);
  const state: ResolutionState = {
    resolved: [],
    missingExact: [],
    unsupported: [],
    unreadable: [],
    truncated: false,
    pathCount: 0,
  };
  const normalizedSelectors: string[] = [];
  if (rawSelectors.length > limits.maxSelectors) state.truncated = true;
  for (const raw of rawSelectors.slice(0, limits.maxSelectors)) {
    const parsed = normalizeSelector(raw);
    if (!parsed.ok) {
      diagnostic(state, limits, "unsupported", {
        selector: typeof raw === "string" ? raw.slice(0, 1_024) : "<invalid>",
        code: parsed.reason === "selector uses unsupported glob syntax" ? "UNSUPPORTED_SELECTOR" : "INVALID_SELECTOR",
        message: parsed.reason,
      });
      continue;
    }
    normalizedSelectors.push(parsed.value);
    const exact = !parsed.value.includes("*") && !parsed.value.includes("?");
    const candidate = path.resolve(normalizedWorktree, parsed.value);
    if (exact) {
      let stat: fs.BigIntStats;
      try {
        stat = fs.lstatSync(candidate, { bigint: true });
      } catch (error: unknown) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
        if (code === "ENOENT") state.missingExact.push(parsed.value);
        else {
          diagnostic(state, limits, "unreadable", {
            selector: parsed.value,
            path: candidate,
            code: "UNREADABLE",
            message: `Exact selector could not be inspected (${code}).`,
          });
        }
        continue;
      }
      if (stat.isSymbolicLink()) {
        diagnostic(state, limits, "unsupported", {
          selector: parsed.value,
          path: candidate,
          code: "SYMLINK",
          message: "Symlink entries are fail-closed.",
        });
        continue;
      }
      const observed = inspectEntry(normalizedWorktree, candidate, parsed.value);
      if (observed.ok) state.resolved.push(observed.value);
      else diagnostic(state, limits, observed.destination, observed.value);
      continue;
    }
    const prefix = literalPrefix(parsed.value);
    const root = path.resolve(normalizedWorktree, prefix || ".");
    const matcher = globRegex(parsed.value);
    let rootStat: fs.BigIntStats;
    try {
      rootStat = fs.lstatSync(root, { bigint: true });
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      if (code !== "ENOENT") {
        diagnostic(state, limits, "unreadable", {
          selector: parsed.value,
          path: root,
          code: "UNREADABLE",
          message: `Selector root could not be inspected (${code}).`,
        });
      }
      continue;
    }
    if (rootStat.isSymbolicLink()) {
      diagnostic(state, limits, "unsupported", {
        selector: parsed.value,
        path: root,
        code: "SYMLINK",
        message: "Selector roots may not resolve through symlinks.",
      });
      continue;
    }
    if (!rootStat.isDirectory()) {
      diagnostic(state, limits, "unsupported", {
        selector: parsed.value,
        path: root,
        code: "NON_REGULAR_ENTRY",
        message: "A wildcard selector must have a directory expansion root.",
      });
      continue;
    }
    scanDirectory(root, parsed.value, normalizedWorktree, matcher, limits, state, 0);
  }

  const byIdentity = new Map<string, FilesystemPolicyResolvedPath>();
  const aliases = new Set<string>();
  for (const candidate of state.resolved) {
    const key = `${candidate.identity.device}:${candidate.identity.inode}`;
    const previous = byIdentity.get(key);
    if (previous !== undefined && previous.absolutePath !== candidate.absolutePath) {
      aliases.add(previous.absolutePath);
      aliases.add(candidate.absolutePath);
      diagnostic(state, limits, "unsupported", {
        selector: candidate.selector,
        path: candidate.absolutePath,
        code: "ALIAS",
        message: "Multiple selected pathnames resolve to one physical file identity.",
      });
    } else byIdentity.set(key, candidate);
  }
  const resolved = state.resolved.filter((candidate) => !aliases.has(candidate.absolutePath));
  const unsupported = [...state.unsupported].sort((left, right) =>
    compareText(
      `${left.selector}:${left.path ?? ""}:${left.code}`,
      `${right.selector}:${right.path ?? ""}:${right.code}`,
    ),
  );
  const unreadable = [...state.unreadable].sort((left, right) =>
    compareText(
      `${left.selector}:${left.path ?? ""}:${left.code}`,
      `${right.selector}:${right.path ?? ""}:${right.code}`,
    ),
  );
  return Object.freeze({
    worktree: normalizedWorktree,
    selectors: Object.freeze([...new Set(normalizedSelectors)].sort(compareText)),
    resolved: Object.freeze(
      resolved.sort((left, right) =>
        compareText(`${left.relativePath}:${left.selector}`, `${right.relativePath}:${right.selector}`),
      ),
    ),
    missingExact: Object.freeze([...new Set(state.missingExact)].sort(compareText)),
    unsupported: Object.freeze(unsupported),
    unreadable: Object.freeze(unreadable),
    truncated: state.truncated,
    complete: !state.truncated && unsupported.length === 0 && unreadable.length === 0,
  });
}

function selectorScope(workingSet: WorkingSetRuntimeProjection): SelectorScope {
  return workingSet.scope;
}

function selectorForPath(resolution: WorkingSetPathResolutionEvidence, relativePath: string): readonly string[] {
  return resolution.resolved.filter((entry) => entry.relativePath === relativePath).map((entry) => entry.selector);
}

function matchesSelector(selector: string, relativePath: string): boolean {
  return globRegex(selector).test(relativePath);
}

function deniedPath(scope: SelectorScope, relativePath: string): boolean {
  return scope.deny.some((selector) => matchesSelector(selector, relativePath));
}

function namespaceRoot(selector: string): string | null {
  if (selector.endsWith("/**")) return selector.slice(0, -3);
  return null;
}

function denyHole(scope: SelectorScope, root: string): boolean {
  return scope.deny.some((deny) => {
    const prefix = literalPrefix(deny);
    return (
      deny === root ||
      deny.startsWith(`${root}/`) ||
      prefix === root ||
      prefix.startsWith(`${root}/`) ||
      matchesSelector(deny, `${root}/hole`)
    );
  });
}

function operationForScope(
  scope: SelectorScope,
  operation: "READONLY" | "WRITE" | "CREATE" | "DELETE",
): readonly string[] {
  if (operation === "READONLY") return scope.readOnly;
  if (operation === "WRITE") return scope.write;
  if (operation === "CREATE") return scope.create;
  return scope.delete;
}

function uniqueRules(rules: readonly FilesystemPolicyRule[]): readonly FilesystemPolicyRule[] {
  const seen = new Set<string>();
  return Object.freeze(
    [...rules]
      .filter((rule) => {
        const key = `${rule.kind}:${rule.operation}:${rule.relativePath}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) =>
        compareText(
          `${left.kind}:${left.operation}:${left.relativePath}:${left.selector}`,
          `${right.kind}:${right.operation}:${right.relativePath}:${right.selector}`,
        ),
      ),
  );
}

function policyError(reason: string, details: Record<string, string | number | boolean>): DomainResult<never> {
  return failure(new DomainError("PHYSICAL_OBSERVATION_UNAVAILABLE", reason, details));
}

function makeDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validatePolicyRule(value: unknown, field: string): DomainResult<FilesystemPolicyRule> {
  const record = requiredRecord(value, field);
  if (!record.ok) return record;
  const selector = canonicalRelativeText(record.value.selector, `${field}.selector`);
  if (!selector.ok) return selector;
  const relativePath = canonicalRelativeText(record.value.relativePath, `${field}.relativePath`);
  if (!relativePath.ok) return relativePath;
  if (record.value.operation !== "READONLY" && record.value.operation !== "WRITE") {
    return runtimePolicyInvalid(`${field}.operation`, "expected READONLY or WRITE");
  }
  if (record.value.kind !== "native-path-rule" && record.value.kind !== "native-namespace") {
    return runtimePolicyInvalid(`${field}.kind`, "expected a native path or namespace rule");
  }
  return success(record.value as unknown as FilesystemPolicyRule);
}

function validateRegistryOperation(
  value: unknown,
  field: string,
  worktree: string,
): DomainResult<FilesystemPolicyRegistryOperation> {
  const record = requiredRecord(value, field);
  if (!record.ok) return record;
  const selector = canonicalRelativeText(record.value.selector, `${field}.selector`);
  if (!selector.ok) return selector;
  const relativePath = canonicalRelativeText(record.value.relativePath, `${field}.relativePath`);
  if (!relativePath.ok) return relativePath;
  if (
    record.value.operation !== "CREATE" &&
    record.value.operation !== "DELETE" &&
    record.value.operation !== "RENAME" &&
    record.value.operation !== "ATOMIC_REPLACEMENT"
  ) {
    return runtimePolicyInvalid(`${field}.operation`, "expected a registry operation");
  }
  let parent: FilesystemPolicyParentEvidence | undefined;
  if (record.value.parent !== undefined) {
    const checked = validateParentEvidence(record.value.parent, `${field}.parent`, worktree);
    if (!checked.ok) return checked;
    parent = checked.value;
  }
  return success({
    ...(record.value as unknown as FilesystemPolicyRegistryOperation),
    ...(parent === undefined ? {} : { parent }),
  });
}

function validateUnsupportedCapability(
  value: unknown,
  field: string,
): DomainResult<FilesystemPolicyUnsupportedCapability> {
  const record = requiredRecord(value, field);
  if (!record.ok) return record;
  const selector = canonicalRelativeText(record.value.selector, `${field}.selector`);
  if (!selector.ok) return selector;
  const operation = requiredText(record.value.operation, `${field}.operation`);
  if (!operation.ok) return operation;
  const reason = requiredText(record.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(record.value as unknown as FilesystemPolicyUnsupportedCapability);
}

/** Validate a materialized policy at every runtime handoff boundary. */
export function validateMaterializedFilesystemPolicy(input: unknown): DomainResult<MaterializedFilesystemPolicy> {
  const record = requiredRecord(input, "filesystem_policy");
  if (!record.ok) return record;
  for (const field of MATERIALIZED_POLICY_FIELDS) {
    if (!(field in record.value)) return runtimePolicyInvalid(field, "required field is missing");
  }
  for (const field of Object.keys(record.value)) {
    if (!MATERIALIZED_POLICY_FIELDS.includes(field as (typeof MATERIALIZED_POLICY_FIELDS)[number])) {
      return runtimePolicyInvalid(field, "unknown field is not part of the canonical policy");
    }
  }
  if (record.value.contract_id !== FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID) {
    return runtimePolicyInvalid("contract_id", "unsupported contract");
  }
  if (record.value.schema_version !== FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION) {
    return runtimePolicyInvalid("schema_version", "unsupported schema version");
  }
  if (record.value.serialization_key !== FILESYSTEM_POLICY_SERIALIZATION_KEY) {
    return runtimePolicyInvalid("serialization_key", "unsupported serialization key");
  }
  const worktree = canonicalAbsoluteText(record.value.worktree, "worktree");
  if (!worktree.ok) return worktree;
  const workingSet = validateWorkingSetRuntimeProjection(record.value.working_set);
  if (!workingSet.ok) return failure(workingSet.error);
  const resolution = validateResolutionEvidence(record.value.resolution, worktree.value);
  if (!resolution.ok) return resolution;
  const rules = requiredArray(record.value.rules, "rules");
  if (!rules.ok) return rules;
  const registryOperations = requiredArray(record.value.registry_operations, "registry_operations");
  if (!registryOperations.ok) return registryOperations;
  const unsupported = requiredArray(record.value.unsupported, "unsupported");
  if (!unsupported.ok) return unsupported;
  if (
    rules.value.length > DEFAULT_MAX_PATHS ||
    registryOperations.value.length > DEFAULT_MAX_PATHS ||
    unsupported.value.length > DEFAULT_MAX_DIAGNOSTICS
  ) {
    return runtimePolicyInvalid("filesystem_policy", "contains too many entries");
  }
  for (const [index, rule] of rules.value.entries()) {
    const checked = validatePolicyRule(rule, `rules[${index}]`);
    if (!checked.ok) return checked;
  }
  for (const [index, operation] of registryOperations.value.entries()) {
    const checked = validateRegistryOperation(operation, `registry_operations[${index}]`, worktree.value);
    if (!checked.ok) return checked;
  }
  for (const [index, capability] of unsupported.value.entries()) {
    const checked = validateUnsupportedCapability(capability, `unsupported[${index}]`);
    if (!checked.ok) return checked;
  }
  const digest = requiredText(record.value.digest, "digest");
  if (!digest.ok || !DIGEST_TEXT.test(digest.value)) return runtimePolicyInvalid("digest", "expected a SHA-256 digest");
  const candidate = record.value as unknown as MaterializedFilesystemPolicy;
  const expectedDigest = makeDigest(materializedPolicyDigestPayload(candidate));
  if (digest.value !== expectedDigest) return runtimePolicyInvalid("digest", "does not match canonical policy content");
  return success(candidate);
}

function buildPlan(
  worktree: string,
  workingSet: WorkingSetRuntimeProjection,
  resolution: WorkingSetPathResolutionEvidence,
): FilesystemPolicyPlan {
  const scope = selectorScope(workingSet);
  const rules: FilesystemPolicyRule[] = [];
  const registryOperations: FilesystemPolicyRegistryOperation[] = [];
  const unsupported: FilesystemPolicyUnsupportedCapability[] = [];
  const resolvedBySelector = new Map<string, FilesystemPolicyResolvedPath[]>();
  for (const resolved of resolution.resolved) {
    const values = resolvedBySelector.get(resolved.selector) ?? [];
    values.push(resolved);
    resolvedBySelector.set(resolved.selector, values);
  }

  for (const operation of ["READONLY", "WRITE"] as const) {
    for (const selector of operationForScope(scope, operation)) {
      const matched = (resolvedBySelector.get(selector) ?? []).filter((entry) =>
        matchesSelector(selector, entry.relativePath),
      );
      const root = namespaceRoot(selector);
      if (root !== null && resolution.complete && !denyHole(scope, root)) {
        rules.push({ selector, relativePath: root, operation, kind: "native-namespace" });
        continue;
      }
      if (root !== null && denyHole(scope, root)) {
        unsupported.push({ selector, operation, reason: "A DENY hole prevents a safe native subtree grant." });
        continue;
      }
      if (root !== null && !resolution.complete) {
        unsupported.push({ selector, operation, reason: "Incomplete physical expansion prevents a subtree grant." });
        continue;
      }
      if (matched.length === 0) {
        if (resolution.missingExact.includes(selector)) {
          unsupported.push({ selector, operation, reason: "The exact READ/WRITE target is missing." });
        }
        continue;
      }
      for (const entry of resolution.complete ? matched : []) {
        if (deniedPath(scope, entry.relativePath)) {
          unsupported.push({ selector, operation, reason: "DENY overrides the exact capability." });
        } else if (entry.kind !== "file") {
          unsupported.push({ selector, operation, reason: "Directory exact READ/WRITE is not safely representable." });
        } else rules.push({ selector, relativePath: entry.relativePath, operation, kind: "native-path-rule" });
      }
    }
  }

  for (const operation of ["CREATE", "DELETE"] as const) {
    for (const selector of operationForScope(scope, operation)) {
      if (selector.includes("*") || selector.includes("?")) {
        unsupported.push({ selector, operation, reason: `${operation} requires an exact path.` });
        continue;
      }
      const matched = resolvedBySelector.get(selector) ?? [];
      const existing = matched[0];
      if (deniedPath(scope, selector) || (existing !== undefined && deniedPath(scope, existing.relativePath))) {
        unsupported.push({ selector, operation, reason: "DENY overrides the exact capability." });
        continue;
      }
      if (existing !== undefined) {
        registryOperations.push({ selector, relativePath: existing.relativePath, operation, parent: existing.parent });
        continue;
      }
      if (resolution.missingExact.includes(selector)) {
        const parent = observeParentDirectory(worktree, path.resolve(worktree, selector));
        if (parent !== null) {
          registryOperations.push({
            selector,
            relativePath: selector,
            operation,
            parent,
          });
        } else {
          unsupported.push({ selector, operation, reason: "The exact target parent could not be physically proven." });
        }
      } else {
        unsupported.push({ selector, operation, reason: "The exact target was not resolved." });
      }
    }
  }

  return Object.freeze({
    worktree,
    workingSet,
    resolution,
    rules: uniqueRules(rules),
    registryOperations: Object.freeze(
      registryOperations.sort((left, right) =>
        compareText(`${left.operation}:${left.relativePath}`, `${right.operation}:${right.relativePath}`),
      ),
    ),
    unsupported: Object.freeze(
      unsupported.sort((left, right) =>
        compareText(`${left.operation}:${left.selector}`, `${right.operation}:${right.selector}`),
      ),
    ),
  });
}

type MaterializationInput = Readonly<{
  readonly worktree: string;
  readonly working_set?: unknown;
  readonly workingSet?: unknown;
  readonly limits?: FilesystemPolicyResolutionLimits;
}>;

function inputOf(
  worktreeOrInput: string | MaterializationInput,
  projectionOrLimits?: unknown,
  requestedLimits?: FilesystemPolicyResolutionLimits,
): { worktree: string; projection: unknown; limits: FilesystemPolicyResolutionLimits } | null {
  if (typeof worktreeOrInput === "string") {
    return {
      worktree: worktreeOrInput,
      projection: projectionOrLimits,
      limits: requestedLimits ?? {},
    };
  }
  if (!isRecord(worktreeOrInput) || typeof worktreeOrInput.worktree !== "string") return null;
  return {
    worktree: worktreeOrInput.worktree,
    projection: worktreeOrInput.working_set ?? worktreeOrInput.workingSet,
    limits: worktreeOrInput.limits ?? {},
  };
}

/**
 * Resolve and classify one working-set runtime projection.  Unreadable or
 * truncated observations reject the materialization completely; unsupported
 * capabilities remain explicit in the returned plan and never become a
 * broader native grant.
 */
export function materializeFilesystemPolicy(
  worktreeOrInput: string | MaterializationInput,
  projectionOrLimits?: unknown,
  requestedLimits?: FilesystemPolicyResolutionLimits,
): DomainResult<MaterializedFilesystemPolicy> {
  const input = inputOf(worktreeOrInput, projectionOrLimits, requestedLimits);
  if (input === null) return policyError("Filesystem policy materializer input is invalid.", {});
  const projection = validateWorkingSetRuntimeProjection(input.projection);
  if (!projection.ok) return failure(projection.error);
  const normalizedWorktree = path.resolve(input.worktree);
  let worktreeStat: fs.BigIntStats;
  try {
    worktreeStat = fs.statSync(normalizedWorktree, { bigint: true });
    if (!worktreeStat.isDirectory() || fs.realpathSync.native(normalizedWorktree) !== normalizedWorktree) {
      return policyError("Filesystem policy worktree is not a canonical directory.", { worktree: normalizedWorktree });
    }
  } catch {
    return policyError("Filesystem policy worktree cannot be physically observed.", { worktree: normalizedWorktree });
  }
  const scope = selectorScope(projection.value);
  const selectors = [...scope.readOnly, ...scope.write, ...scope.create, ...scope.delete, ...scope.deny];
  const resolution = resolveWorkingSetPathsWithEvidence(normalizedWorktree, selectors, input.limits);
  if (resolution.truncated || resolution.unreadable.length > 0) {
    return policyError("Filesystem policy resolution is incomplete; no observed subset may be granted.", {
      truncated: resolution.truncated,
      unreadable: resolution.unreadable.length,
    });
  }
  const plan = buildPlan(normalizedWorktree, projection.value, resolution);
  const policy: MaterializedFilesystemPolicy = Object.freeze({
    contract_id: FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION,
    serialization_key: FILESYSTEM_POLICY_SERIALIZATION_KEY,
    worktree: normalizedWorktree,
    working_set: projection.value,
    resolution,
    rules: plan.rules,
    registry_operations: plan.registryOperations,
    unsupported: plan.unsupported,
    digest: makeDigest(
      materializedPolicyDigestPayload({
        worktree: normalizedWorktree,
        working_set: projection.value,
        resolution,
        rules: plan.rules,
        registry_operations: plan.registryOperations,
        unsupported: plan.unsupported,
      }),
    ),
  });
  return success(policy);
}

/** Select only native/registry capabilities already proven by the plan. */
export function selectFilesystemEnforcement(
  plan: FilesystemPolicyPlan | MaterializedFilesystemPolicy,
): FilesystemPolicyEnforcementSelection {
  const nativePathRules = plan.resolution.complete ? plan.rules.filter((rule) => rule.kind === "native-path-rule") : [];
  const nativeNamespace = plan.resolution.complete ? plan.rules.filter((rule) => rule.kind === "native-namespace") : [];
  const unsupported = [...plan.unsupported];
  const registryOperations = "registryOperations" in plan ? plan.registryOperations : plan.registry_operations;
  if (!plan.resolution.complete) {
    unsupported.push({
      selector: "<resolution>",
      operation: "READONLY",
      reason: "Physical resolution evidence is incomplete; no successful subset is authoritative.",
    });
  }
  return Object.freeze({
    status: unsupported.length === 0 ? "representable" : "unsupported",
    nativePathRules: Object.freeze([...nativePathRules]),
    nativeNamespace: Object.freeze([...nativeNamespace]),
    registryOperations: Object.freeze([...registryOperations]),
    unsupported: Object.freeze(unsupported),
  });
}

/** Serialize a materialized policy without consulting ambient filesystem state. */
export function serializeFilesystemPolicy(input: MaterializedFilesystemPolicy): DomainResult<string> {
  const validated = validateMaterializedFilesystemPolicy(input);
  return validated.ok ? success(JSON.stringify(validated.value)) : failure(validated.error);
}

/** Compatibility aliases for callers that use the domain's compile wording. */
export const compileFilesystemPolicy = materializeFilesystemPolicy;
export const serializeMaterializedFilesystemPolicy = serializeFilesystemPolicy;
