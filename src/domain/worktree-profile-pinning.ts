import { createHash } from "node:crypto";
import type { JsonObject } from "./errors.js";
import { validateWorktreeRuntimeProfile, type ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

export const PINNED_WORKTREE_PROFILE_SCHEMA_VERSION = 1 as const;
export const PINNED_WORKTREE_PROFILE_SERIALIZATION_KEY = "pinned-worktree-profile" as const;

export type PinnedWorktreeProfileProvenance = Readonly<{
  repository: Readonly<{ id: string; revision: string }>;
  base: Readonly<{ revision: string }>;
  catalog: Readonly<{ path: string; blob_oid: string }>;
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
  if (
    !record(value) ||
    !record(value.repository) ||
    typeof value.repository.id !== "string" ||
    !FULL_OID.test(value.repository.revision) ||
    !record(value.base) ||
    !FULL_OID.test(value.base.revision) ||
    !record(value.catalog) ||
    value.catalog.path !== "nawabari.profiles.json" ||
    !FULL_OID.test(value.catalog.blob_oid) ||
    !record(value.selection) ||
    typeof value.selection.profile !== "string" ||
    !record(value.selection.parameters)
  )
    throw new Error("Invalid pinned worktree profile provenance");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
