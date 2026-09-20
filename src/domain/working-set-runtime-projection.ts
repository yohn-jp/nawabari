import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import type { EffectiveWorkingSet, EffectiveWorkingSetScope } from "../working-set.js";

/** Versioned runtime consumer contract for a bounded Effective Working Set. */
export const WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID = "nawabari.working-set-runtime-projection.v1" as const;
export const WORKING_SET_RUNTIME_PROJECTION_SCHEMA_VERSION = 1 as const;

export type WorkingSetRuntimeProjection = Readonly<{
  readonly contract_id: typeof WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID;
  readonly schema_version: typeof WORKING_SET_RUNTIME_PROJECTION_SCHEMA_VERSION;
  readonly working_set_id: string;
  readonly revision: number;
  readonly repository: EffectiveWorkingSet["repository"];
  readonly base: EffectiveWorkingSet["base"];
  readonly scope: EffectiveWorkingSetScope;
}>;

export type WorkingSetRuntimeOperation = "READONLY" | "WRITE" | "CREATE" | "DELETE";

const OPERATIONS = ["READONLY", "WRITE", "CREATE", "DELETE"] as const;
const MAX_PATHS = 2_048;
const MAX_TEXT = 1_024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Working-set runtime field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function boundedText(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT || !SAFE_TEXT.test(value)) {
    return invalid(field, "expected bounded text");
  }
  return success(value.normalize("NFC"));
}

function revision(value: unknown, field: string): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(field, "expected a positive revision");
  return success(value as number);
}

function selector(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return invalid(field, "expected a repository-relative selector", normalized);
  }
  return success(normalized);
}

function scope(value: unknown): DomainResult<EffectiveWorkingSetScope> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("scope", "expected an object");
  const record = value as Record<string, unknown>;
  const result = {} as Record<keyof EffectiveWorkingSetScope, readonly string[]>;
  for (const operation of ["readOnly", "write", "create", "delete", "deny"] as const) {
    const entries = record[operation];
    if (!Array.isArray(entries) || entries.length > MAX_PATHS)
      return invalid(`scope.${operation}`, "expected a bounded array");
    const values: string[] = [];
    for (const [index, entry] of entries.entries()) {
      const parsed = selector(entry, `scope.${operation}[${index}]`);
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    if (new Set(values).size !== values.length) return invalid(`scope.${operation}`, "contains duplicate selectors");
    result[operation] = Object.freeze(values.sort());
  }
  return success(Object.freeze(result));
}

function identity(
  value: unknown,
  field: string,
): DomainResult<{ readonly repositoryHost: string; readonly repositoryId: string; readonly repository?: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid(field, "expected an object");
  const record = value as Record<string, unknown>;
  const host = boundedText(record.repositoryHost, `${field}.repositoryHost`);
  if (!host.ok) return host;
  const id = boundedText(record.repositoryId, `${field}.repositoryId`);
  if (!id.ok) return id;
  if (record.repository !== undefined) {
    const locator = boundedText(record.repository, `${field}.repository`);
    if (!locator.ok) return locator;
    return success(Object.freeze({ repositoryHost: host.value, repositoryId: id.value, repository: locator.value }));
  }
  return success(Object.freeze({ repositoryHost: host.value, repositoryId: id.value }));
}

function base(value: unknown): DomainResult<EffectiveWorkingSet["base"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("base", "expected an object");
  const record = value as Record<string, unknown>;
  const branch = boundedText(record.branch, "base.branch");
  if (!branch.ok) return branch;
  const revisionValue = boundedText(record.revision, "base.revision");
  if (!revisionValue.ok) return revisionValue;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(revisionValue.value))
    return invalid("base.revision", "expected an immutable revision");
  if (record.freshness !== undefined) {
    const freshness = boundedText(record.freshness, "base.freshness");
    if (!freshness.ok) return freshness;
    return success(
      Object.freeze({ branch: branch.value, revision: revisionValue.value.toLowerCase(), freshness: freshness.value }),
    );
  }
  return success(Object.freeze({ branch: branch.value, revision: revisionValue.value.toLowerCase() }));
}

/** Validate the bounded runtime form without consulting the filesystem. */
export function validateWorkingSetRuntimeProjection(input: unknown): DomainResult<WorkingSetRuntimeProjection> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return invalid("working_set", "expected an object");
  const value = input as Record<string, unknown>;
  if (value.contract_id !== WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID)
    return invalid("working_set.contract_id", "unsupported contract");
  if (value.schema_version !== WORKING_SET_RUNTIME_PROJECTION_SCHEMA_VERSION)
    return invalid("working_set.schema_version", "unsupported schema version");
  const id = boundedText(value.working_set_id, "working_set.working_set_id");
  if (!id.ok) return id;
  const stateRevision = revision(value.revision, "working_set.revision");
  if (!stateRevision.ok) return stateRevision;
  const repository = identity(value.repository, "working_set.repository");
  if (!repository.ok) return repository;
  const baseValue = base(value.base);
  if (!baseValue.ok) return baseValue;
  const scopeValue = scope(value.scope);
  if (!scopeValue.ok) return scopeValue;
  return success(
    Object.freeze({
      contract_id: WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID,
      schema_version: WORKING_SET_RUNTIME_PROJECTION_SCHEMA_VERSION,
      working_set_id: id.value,
      revision: stateRevision.value,
      repository: repository.value,
      base: baseValue.value,
      scope: scopeValue.value,
    }),
  );
}

/** Convert a validated Effective Working Set into the runtime consumer form. */
export function compileWorkingSetRuntimeProjection(
  workingSet: EffectiveWorkingSet,
): DomainResult<WorkingSetRuntimeProjection> {
  return validateWorkingSetRuntimeProjection({
    contract_id: WORKING_SET_RUNTIME_PROJECTION_CONTRACT_ID,
    schema_version: WORKING_SET_RUNTIME_PROJECTION_SCHEMA_VERSION,
    working_set_id: workingSet.id,
    revision: workingSet.revision,
    repository: workingSet.repository,
    base: workingSet.base,
    scope: workingSet.scope,
  });
}

function globRegex(selectorValue: string): RegExp {
  let source = "^";
  for (let index = 0; index < selectorValue.length; index += 1) {
    const character = selectorValue[index] as string;
    if (character === "*" && selectorValue[index + 1] === "*") {
      source += ".*";
      index += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function isDenied(scopeValue: EffectiveWorkingSetScope, relative: string): boolean {
  return scopeValue.deny.some((entry) => globRegex(entry).test(relative));
}

function operationSelectors(
  scopeValue: EffectiveWorkingSetScope,
  operation: WorkingSetRuntimeOperation,
): readonly string[] {
  if (operation === "READONLY") return scopeValue.readOnly;
  if (operation === "WRITE") return scopeValue.write;
  if (operation === "CREATE") return scopeValue.create;
  return scopeValue.delete;
}

/** Return whether a repository-relative path has one explicit operation grant. */
export function allowsWorkingSetPath(
  projection: WorkingSetRuntimeProjection,
  relativePath: string,
  operation: WorkingSetRuntimeOperation,
): boolean {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || isDenied(projection.scope, normalized)) return false;
  return operationSelectors(projection.scope, operation).some((entry) => globRegex(entry).test(normalized));
}

function literalPrefix(selectorValue: string): string {
  const wildcard = selectorValue.search(/[?*]/u);
  const prefix = wildcard === -1 ? selectorValue : selectorValue.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash);
}

function walk(root: string, result: string[], max = MAX_PATHS * 8): void {
  if (result.length >= max) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (result.length >= max || entry.isSymbolicLink()) continue;
    const candidate = path.join(root, entry.name);
    result.push(candidate);
    if (entry.isDirectory()) walk(candidate, result, max);
  }
}

/** Resolve selectors to current physical paths without following symlinks. */
export function resolveWorkingSetPaths(worktree: string, selectors: readonly string[]): readonly string[] {
  const paths = new Set<string>();
  const canonicalWorktree = path.resolve(worktree);
  for (const selectorValue of selectors) {
    const prefix = literalPrefix(selectorValue);
    const root = path.resolve(worktree, prefix || ".");
    const candidates: string[] = [];
    if (selectorValue.includes("*") || selectorValue.includes("?")) walk(root, candidates);
    else candidates.push(path.resolve(worktree, selectorValue));
    const matcher = globRegex(selectorValue);
    for (const candidate of candidates) {
      const relative = path.relative(worktree, candidate).split(path.sep).join("/");
      if (relative === "" || !matcher.test(relative)) continue;
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink()) continue;
        const resolved = fs.realpathSync.native(candidate);
        const escaped = path.relative(canonicalWorktree, resolved);
        if (escaped === ".." || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) continue;
        paths.add(candidate);
      } catch {
        // A missing exact CREATE target is handled by the launcher through its
        // parent directory rule; missing READ/WRITE targets are not granted.
      }
    }
  }
  return [...paths].sort();
}

/** Convert an EWS selector to the namespace path used by Landlock. */
export function workingSetNamespacePath(worktree: string, relativePath: string): string {
  return path.posix.join(worktree.split(path.sep).join("/"), relativePath);
}

/** Narrow, bounded diagnostics that never include file contents. */
export function workingSetDeniedError(operation: WorkingSetRuntimeOperation, relativePath: string): DomainError {
  return new DomainError("OPERATION_REJECTED", `Working-set ${operation} access is denied.`, {
    operation,
    path: relativePath.slice(0, MAX_TEXT),
  });
}

export { OPERATIONS as WORKING_SET_RUNTIME_OPERATIONS };
