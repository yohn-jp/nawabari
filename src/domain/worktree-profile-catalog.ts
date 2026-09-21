import { DomainError, failure, success, type DomainResult } from "./errors.js";
import type { GitCommandRunner, RepositoryContext } from "../git.js";
import { defaultGit } from "../git.js";
import {
  validateWorktreeRuntimeProfile,
  type ResolvedWorktreeRuntimeProfile,
  type WorktreeRuntimeProfile,
} from "./worktree-runtime-profile.js";

export const WORKTREE_PROFILE_CATALOG_PATH = "nawabari.profiles.json" as const;
export const WORKTREE_PROFILE_CATALOG_SERIALIZATION_KEY = "worktree-profile" as const;
export const WORKTREE_PROFILE_CATALOG_MAX_SIZE = 64 as const;
export const WORKTREE_PROFILE_INHERITANCE_MAX_DEPTH = 8 as const;

type RecordValue = Record<string, unknown>;
export type CatalogWorktreeProfile = ResolvedWorktreeRuntimeProfile & Readonly<{ extends: readonly string[] }>;
export type WorktreeProfileCatalog = Readonly<{ profiles: readonly CatalogWorktreeProfile[] }>;
export type WorktreeProfileSelection = Readonly<{ profile: string }>;
export type WorktreeProfileParameterValues = Readonly<Record<string, unknown>>;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function error(
  code: "RUNTIME_PROFILE_INVALID" | "RUNTIME_PROFILE_AMBIGUOUS" | "RUNTIME_PROFILE_MISSING",
  message: string,
  details: RecordValue = {},
): DomainResult<never> {
  return failure(new DomainError(code, message, details));
}
function sorted<T>(values: readonly T[], key: (value: T) => string): readonly T[] {
  return Object.freeze([...values].sort((a, b) => key(a).localeCompare(key(b))));
}
function profileKey(profile: WorktreeRuntimeProfile): string {
  return `${profile.id}\u0000${profile.version}`;
}

function catalogInput(value: unknown): unknown {
  if (!record(value)) return value;
  if (Object.keys(value).length === 1 && "worktree-profile" in value) return value["worktree-profile"];
  return value;
}

export function validateWorktreeProfileCatalog(input: unknown): DomainResult<WorktreeProfileCatalog> {
  const value = catalogInput(input);
  if (!record(value) || !Array.isArray(value.profiles))
    return error("RUNTIME_PROFILE_INVALID", "Worktree profile catalog must contain a profiles array.");
  if (value.profiles.length === 0 || value.profiles.length > WORKTREE_PROFILE_CATALOG_MAX_SIZE)
    return error("RUNTIME_PROFILE_INVALID", "Worktree profile catalog size is outside its bounds.");
  const profiles: CatalogWorktreeProfile[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.profiles.entries()) {
    if (!record(item)) return error("RUNTIME_PROFILE_INVALID", `Catalog profile ${index} is not an object.`);
    if (!Array.isArray(item.extends) || item.extends.some((parent) => typeof parent !== "string"))
      return error("RUNTIME_PROFILE_INVALID", `Catalog profile ${index} has invalid extends.`);
    const { extends: parents, ...profileInput } = item;
    const result = validateWorktreeRuntimeProfile(profileInput);
    if (!result.ok) return failure(result.error);
    if (ids.has(result.value.id))
      return error("RUNTIME_PROFILE_AMBIGUOUS", `Duplicate worktree profile '${result.value.id}'.`, {
        profile_id: result.value.id,
      });
    ids.add(result.value.id);
    if (parents.some((parent) => parent === result.value.id))
      return error("RUNTIME_PROFILE_AMBIGUOUS", `Profile '${result.value.id}' extends itself.`);
    profiles.push(Object.freeze({ ...result.value, extends: Object.freeze([...new Set(parents)].sort()) }));
  }
  return success(Object.freeze({ profiles: sorted(profiles, (profile) => profile.id) }));
}

export function loadWorktreeProfileCatalog(
  repository: RepositoryContext,
  revision: string,
  path = WORKTREE_PROFILE_CATALOG_PATH,
  git: GitCommandRunner = defaultGit,
): DomainResult<WorktreeProfileCatalog> {
  if (!/^[0-9a-f]{40}$/u.test(revision))
    return error("RUNTIME_PROFILE_INVALID", "Catalog revision must be an immutable full commit id.");
  if (path !== WORKTREE_PROFILE_CATALOG_PATH || path.includes("/") || path.includes("\\") || path.includes(".."))
    return error("RUNTIME_PROFILE_INVALID", "Catalog path is not canonical.");
  try {
    const text = git.run(["show", `${revision}:${path}`], repository.worktreePath);
    return validateWorktreeProfileCatalog(JSON.parse(text) as unknown);
  } catch (cause) {
    return error("RUNTIME_PROFILE_MISSING", "The pinned repository catalog could not be read.", {
      path,
      revision,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function mergeProfile(
  parent: CatalogWorktreeProfile,
  child: CatalogWorktreeProfile,
): DomainResult<CatalogWorktreeProfile> {
  if (parent.version !== child.version)
    return error("RUNTIME_PROFILE_AMBIGUOUS", `Profile '${child.id}' conflicts with inherited profile version.`);
  const fields = ["materialSelection", "filesystem", "tools", "shell", "environment", "git", "execution"] as const;
  const { extends: _parentExtends, ...parentFields } = parent;
  const { extends: childExtends, ...childFields } = child;
  const merged: RecordValue = { ...parentFields, ...childFields, id: child.id, version: child.version };
  for (const field of fields) {
    const a = JSON.stringify(parent[field]);
    const b = JSON.stringify(child[field]);
    if (a !== b && field !== "materialSelection" && field !== "filesystem")
      return error("RUNTIME_PROFILE_AMBIGUOUS", `Profile '${child.id}' conflicts with inherited field '${field}'.`);
  }
  const material = {
    ...child.materialSelection,
    profiles: [...new Set([...parent.materialSelection.profiles, ...child.materialSelection.profiles])].sort(),
  };
  merged.materialSelection = material;
  const check = validateWorktreeRuntimeProfile(merged);
  return check.ok ? success(Object.freeze({ ...check.value, extends: childExtends })) : failure(check.error);
}

export function resolveWorktreeProfile(
  selection: unknown,
  catalog: unknown,
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  const parsedCatalog = validateWorktreeProfileCatalog(catalog);
  if (!parsedCatalog.ok) return failure(parsedCatalog.error);
  if (!record(selection) || typeof selection.profile !== "string")
    return error("RUNTIME_PROFILE_INVALID", "Profile selection requires one profile id.");
  const byId = new Map(parsedCatalog.value.profiles.map((profile) => [profile.id, profile]));
  const visiting = new Set<string>();
  const resolved = new Map<string, CatalogWorktreeProfile>();
  const visit = (id: string, depth: number): DomainResult<CatalogWorktreeProfile> => {
    const existing = resolved.get(id);
    if (existing) return success(existing);
    if (depth > WORKTREE_PROFILE_INHERITANCE_MAX_DEPTH)
      return error("RUNTIME_PROFILE_INVALID", "Worktree profile inheritance exceeds its maximum depth.");
    const profile = byId.get(id);
    if (!profile) return error("RUNTIME_PROFILE_MISSING", `Unknown parent profile '${id}'.`, { profile_id: id });
    if (visiting.has(id))
      return error("RUNTIME_PROFILE_AMBIGUOUS", `Worktree profile inheritance cycle includes '${id}'.`, {
        profile_id: id,
      });
    visiting.add(id);
    let current: DomainResult<ResolvedWorktreeRuntimeProfile> = success(profile);
    for (const parent of (profile as WorktreeRuntimeProfile & { extends?: readonly string[] }).extends ?? []) {
      const parentResult = visit(parent, depth + 1);
      if (!parentResult.ok) {
        visiting.delete(id);
        return parentResult;
      }
      current = mergeProfile(parentResult.value, current.ok ? current.value : profile);
      if (!current.ok) {
        visiting.delete(id);
        return current;
      }
    }
    visiting.delete(id);
    resolved.set(id, current.value);
    return current;
  };
  const result = visit(selection.profile, 0);
  if (!result.ok) return failure(result.error);
  const { extends: _extends, ...resolvedProfile } = result.value;
  return success(Object.freeze(resolvedProfile));
}

export function substituteProfileParameters(
  profile: unknown,
  values: WorktreeProfileParameterValues,
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  const checked = validateWorktreeRuntimeProfile(profile);
  if (!checked.ok) return failure(checked.error);
  const allowed = new Set(["materialSelection.profiles", "shell.entrypoint"]);
  for (const key of Object.keys(values))
    if (!allowed.has(key)) return error("RUNTIME_PROFILE_INVALID", `Unknown profile parameter '${key}'.`);
  const output: RecordValue = { ...checked.value };
  if ("materialSelection.profiles" in values) {
    const selected = values["materialSelection.profiles"];
    if (!Array.isArray(selected) || selected.some((value) => typeof value !== "string"))
      return error("RUNTIME_PROFILE_INVALID", "materialSelection.profiles requires profile identifiers.");
    output.materialSelection = { ...checked.value.materialSelection, profiles: selected };
  }
  if ("shell.entrypoint" in values) output.shell = { entrypoint: values["shell.entrypoint"] };
  const result = validateWorktreeRuntimeProfile(output);
  return result.ok ? result : failure(result.error);
}
