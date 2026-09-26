import { createHash } from "node:crypto";
import type { JsonObject } from "./errors.js";
import {
  BUILTIN_WORKTREE_PROFILE_IDS,
  getBuiltinWorktreeProfile,
  type BuiltinWorktreeProfileId,
} from "./worktree-profile-builtins.js";
import { validateWorktreeRuntimeProfile, type ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

export const PINNED_WORKTREE_PROFILE_SCHEMA_VERSION = 1 as const;
export const PINNED_WORKTREE_PROFILE_SERIALIZATION_KEY = "pinned-worktree-profile" as const;

export type RepositoryWorktreeProfileCatalogSource = Readonly<{
  readonly kind: "repository";
  readonly path: "nawabari.profiles.json";
  readonly blob_oid: string;
}>;

export type BuiltinWorktreeProfileCatalogSource = Readonly<{
  readonly kind: "builtin";
  readonly id: BuiltinWorktreeProfileId;
  readonly revision: string;
}>;

/** Schema-v1 repository provenance accepted only while parsing old pins. */
export type LegacyRepositoryWorktreeProfileCatalogSource = Readonly<{
  readonly path: "nawabari.profiles.json";
  readonly blob_oid: string;
}>;

export type WorktreeProfileCatalogSource = RepositoryWorktreeProfileCatalogSource | BuiltinWorktreeProfileCatalogSource;

export type PinnedWorktreeProfileProvenance = Readonly<{
  repository: Readonly<{ id: string; revision: string }>;
  base: Readonly<{ revision: string }>;
  catalog: WorktreeProfileCatalogSource | LegacyRepositoryWorktreeProfileCatalogSource;
  selection: Readonly<{ profile: string; parameters: JsonObject }>;
}>;

export type PinnedWorktreeProfile = Readonly<{
  schema_version: typeof PINNED_WORKTREE_PROFILE_SCHEMA_VERSION;
  resolved: ResolvedWorktreeRuntimeProfile;
  provenance: PinnedWorktreeProfileProvenance;
  digest: string;
  pinned_at?: string;
}>;

type RecordValue = Record<string, unknown>;
const FULL_OID = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** SHA-256 identity of the validated canonical built-in declaration. */
export function builtinWorktreeProfileRevision(id: string): string {
  const profile = getBuiltinWorktreeProfile(id);
  if (!profile.ok) throw profile.error;
  return createHash("sha256").update(stable(profile.value), "utf8").digest("hex");
}

function digestInput(resolved: ResolvedWorktreeRuntimeProfile, provenance: PinnedWorktreeProfileProvenance): string {
  return stable({ resolved, provenance });
}

export function pinnedWorktreeProfileDigest(
  resolved: ResolvedWorktreeRuntimeProfile,
  provenance: PinnedWorktreeProfileProvenance,
): string {
  return createHash("sha256").update(digestInput(resolved, provenance), "utf8").digest("hex");
}

export function pinWorktreeProfile(
  resolved: unknown,
  provenance: PinnedWorktreeProfileProvenance,
  pinnedAt?: string,
): PinnedWorktreeProfile {
  const checked = validateWorktreeRuntimeProfile(resolved);
  if (!checked.ok) throw checked.error;
  assertProvenance(provenance);
  const output = {
    schema_version: PINNED_WORKTREE_PROFILE_SCHEMA_VERSION,
    resolved: checked.value,
    provenance: clone(provenance),
    digest: pinnedWorktreeProfileDigest(checked.value, provenance),
    ...(pinnedAt === undefined ? {} : { pinned_at: pinnedAt }),
  } as PinnedWorktreeProfile;
  return Object.freeze(output);
}

export function parsePinnedProfileRecord(input: unknown): PinnedWorktreeProfile {
  const value =
    record(input) && record(input[PINNED_WORKTREE_PROFILE_SERIALIZATION_KEY])
      ? input[PINNED_WORKTREE_PROFILE_SERIALIZATION_KEY]
      : input;
  if (!record(value) || value.schema_version !== PINNED_WORKTREE_PROFILE_SCHEMA_VERSION)
    throw new Error("Invalid pinned worktree profile schema");
  const pinned = pinWorktreeProfile(
    value.resolved,
    value.provenance as PinnedWorktreeProfileProvenance,
    value.pinned_at as string | undefined,
  );
  if (typeof value.digest !== "string" || !SHA256.test(value.digest) || value.digest !== pinned.digest)
    throw new Error("Pinned worktree profile digest mismatch");
  return Object.freeze({ ...pinned, digest: value.digest });
}

function assertProvenance(value: PinnedWorktreeProfileProvenance): void {
  const catalog = (value && record(value) && record(value.catalog) ? value.catalog : undefined) as
    RecordValue | undefined;
  const validBuiltin =
    record(catalog) &&
    catalog.kind === "builtin" &&
    typeof catalog.id === "string" &&
    BUILTIN_WORKTREE_PROFILE_IDS.includes(catalog.id as BuiltinWorktreeProfileId) &&
    typeof catalog.revision === "string" &&
    SHA256.test(catalog.revision) &&
    builtinWorktreeProfileRevision(catalog.id) === catalog.revision;
  const validRepository =
    record(catalog) &&
    catalog.kind === "repository" &&
    catalog.path === "nawabari.profiles.json" &&
    typeof catalog.blob_oid === "string" &&
    FULL_OID.test(catalog.blob_oid);
  const validLegacyRepository =
    record(catalog) &&
    catalog.kind === undefined &&
    catalog.path === "nawabari.profiles.json" &&
    typeof catalog.blob_oid === "string" &&
    FULL_OID.test(catalog.blob_oid);
  if (
    !record(value) ||
    !record(value.repository) ||
    typeof value.repository.id !== "string" ||
    !FULL_OID.test(value.repository.revision) ||
    !record(value.base) ||
    !FULL_OID.test(value.base.revision) ||
    !(validBuiltin || validRepository || validLegacyRepository) ||
    !record(value.selection) ||
    typeof value.selection.profile !== "string" ||
    !record(value.selection.parameters)
  )
    throw new Error("Invalid pinned worktree profile provenance");

  if (validBuiltin && value.selection.profile !== catalog.id) {
    throw new Error("Built-in worktree profile selection does not match its provenance");
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
