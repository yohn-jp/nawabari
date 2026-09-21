import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import { CANONICAL_EXECUTABLE_ROOT } from "./runtime-executable-projection.js";
import { validateWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

/** Versioned identity for the session/execution environment materializer. */
export const SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID = "nawabari.session-runtime-directory-manifest.v1" as const;
export const SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY = "sandbox" as const;

export const SESSION_RUNTIME_LOGICAL_HOME = "/home/nawabari" as const;
export const SESSION_RUNTIME_LOGICAL_CONFIG_HOME = "/home/nawabari/.config" as const;
export const SESSION_RUNTIME_LOGICAL_CACHE_HOME = "/home/nawabari/.cache" as const;
export const SESSION_RUNTIME_LOGICAL_DATA_HOME = "/home/nawabari/.local/share" as const;
export const SESSION_RUNTIME_LOGICAL_STATE_HOME = "/home/nawabari/.local/state" as const;
export const SESSION_RUNTIME_LOGICAL_TMPDIR = "/tmp" as const;

const DIRECTORY_MODE = 0o700;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_DISPLAY_VALUE_LENGTH = 128;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DISPLAY_VALUE = /^[\x20-\x7e]+$/u;

type UnknownRecord = Record<string, unknown>;

/** Inputs issued by the owning session/execution authority. */
export type SessionRuntimeEnvironmentIdentity = Readonly<{
  readonly session_id: string;
  readonly execution_id: string;
  /** Durable host root for this session; it becomes logical /home/nawabari. */
  readonly session_root: string;
  /** Ephemeral host root for this execution; it becomes logical /tmp. */
  readonly execution_root: string;
  /** Required when the profile explicitly selects a shared read-only cache. */
  readonly shared_cache_root?: string;
  /** Expected ownership of every materialized directory. */
  readonly owner_uid: number;
  readonly owner_gid: number;
  /** Explicit terminal display value; ambient TERM is never consulted. */
  readonly term?: string;
}>;

export type SessionRuntimeDirectoryScope = "session" | "execution" | "shared-read-only";
export type SessionRuntimeDirectoryDurability = "durable" | "ephemeral";
export type SessionRuntimeDirectoryAccess = "read-write" | "read-only";

export type SessionRuntimeDirectory = Readonly<{
  readonly path: string;
  readonly scope: SessionRuntimeDirectoryScope;
  readonly durability: SessionRuntimeDirectoryDurability;
  readonly access: SessionRuntimeDirectoryAccess;
  readonly mode: 0o700;
}>;

export type SessionRuntimeDirectoryManifest = Readonly<{
  readonly contract_id: typeof SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID;
  readonly schema_version: typeof SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION;
  readonly session_id: string;
  readonly execution_id: string;
  readonly profile: Readonly<{ readonly id: string; readonly version: string }>;
  readonly owner: Readonly<{ readonly uid: number; readonly gid: number }>;
  readonly session: Readonly<{
    readonly root: SessionRuntimeDirectory;
    readonly home: SessionRuntimeDirectory;
    readonly xdg: Readonly<{
      readonly config: SessionRuntimeDirectory;
      readonly cache: SessionRuntimeDirectory;
      readonly data: SessionRuntimeDirectory;
      readonly state: SessionRuntimeDirectory;
    }>;
  }>;
  readonly execution: Readonly<{
    readonly root: SessionRuntimeDirectory;
    readonly tmp: SessionRuntimeDirectory;
  }>;
}>;

export type SessionRuntimeEnvironment = Readonly<Record<string, string>>;

export type CompiledSessionEnvironment = Readonly<{
  readonly environment: SessionRuntimeEnvironment;
  readonly manifest: SessionRuntimeDirectoryManifest;
}>;

export type SessionRuntimeDirectoryObservation = Readonly<{
  readonly path: string;
  readonly scope: SessionRuntimeDirectoryScope;
  readonly durability: SessionRuntimeDirectoryDurability;
  readonly access: SessionRuntimeDirectoryAccess;
  readonly mode: 0o700;
  readonly uid: number;
  readonly gid: number;
  readonly dev: string;
  readonly ino: string;
}>;

export type MaterializedSessionRuntimeDirectories = Readonly<{
  readonly manifest: SessionRuntimeDirectoryManifest;
  readonly directories: readonly SessionRuntimeDirectoryObservation[];
}>;

export type SessionRuntimeEnvironmentErrorCode = Extract<
  ErrorCode,
  "RUNTIME_PROJECTION_INVALID" | "RUNTIME_PROJECTION_AMBIGUOUS" | "INTERNAL_ERROR"
>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROJECTION_INVALID",
      `Session runtime environment field '${field}' is invalid: ${reason}.`,
      {
        field,
        ...(value === undefined ? {} : { value }),
      },
    ),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROJECTION_AMBIGUOUS",
      `Session runtime environment field '${field}' is ambiguous: ${reason}.`,
      { field, ...(value === undefined ? {} : { value }) },
    ),
  );
}

function materializationFailure(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("INTERNAL_ERROR", `Session runtime directory '${field}' failed: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertKeys(value: UnknownRecord, allowed: readonly string[], field: string): DomainResult<null> {
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) return invalid(`${field}.${key}`, "unknown fields are not supported");
  }
  return success(null);
}

function identifier(value: unknown, field: string): DomainResult<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !IDENTIFIER.test(value)
  ) {
    return invalid(field, "expected a bounded stable identifier");
  }
  return success(value);
}

function absolutePath(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !path.posix.isAbsolute(value)) {
    return invalid(field, "expected an absolute POSIX path");
  }
  if (path.posix.normalize(value) !== value || value === "/") {
    return invalid(field, "path must be normalized and must not be the filesystem root", value);
  }
  return success(value);
}

function ownerId(value: unknown, field: string): DomainResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4_294_967_295) {
    return invalid(field, "expected an unsigned numeric owner identity");
  }
  return success(value);
}

function displayValue(value: unknown, field: string): DomainResult<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_DISPLAY_VALUE_LENGTH ||
    !DISPLAY_VALUE.test(value)
  ) {
    return invalid(field, "expected bounded printable display text");
  }
  return success(value);
}

function canonicalHostPath(value: string, field: string): DomainResult<string> {
  const checked = absolutePath(value, field);
  if (!checked.ok) return checked;
  return success(checked.value);
}

function isBelow(parent: string, candidate: string): boolean {
  const relative = path.posix.relative(parent, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
}

function directory(
  value: unknown,
  field: string,
  expectedScope: SessionRuntimeDirectoryScope,
  expectedDurability: SessionRuntimeDirectoryDurability,
  expectedAccess: SessionRuntimeDirectoryAccess,
): DomainResult<SessionRuntimeDirectory> {
  if (!isRecord(value)) return invalid(field, "expected a directory descriptor");
  const keys = assertKeys(value, ["path", "scope", "durability", "access", "mode"], field);
  if (!keys.ok) return keys;
  const directoryPath = absolutePath(value.path, `${field}.path`);
  if (!directoryPath.ok) return directoryPath;
  if (value.scope !== expectedScope) return invalid(`${field}.scope`, `must be '${expectedScope}'`);
  if (value.durability !== expectedDurability) return invalid(`${field}.durability`, `must be '${expectedDurability}'`);
  if (value.access !== expectedAccess) return invalid(`${field}.access`, `must be '${expectedAccess}'`);
  if (value.mode !== DIRECTORY_MODE) return invalid(`${field}.mode`, "must be 0700");
  return success(
    Object.freeze({
      path: directoryPath.value,
      scope: expectedScope,
      durability: expectedDurability,
      access: expectedAccess,
      mode: DIRECTORY_MODE,
    }),
  );
}

function validateManifest(input: unknown): DomainResult<SessionRuntimeDirectoryManifest> {
  if (!isRecord(input)) return invalid("manifest", "expected an object");
  const keys = assertKeys(
    input,
    ["contract_id", "schema_version", "session_id", "execution_id", "profile", "owner", "session", "execution"],
    "manifest",
  );
  if (!keys.ok) return keys;
  if (input.contract_id !== SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID) {
    return invalid("contract_id", "does not match the canonical session runtime directory contract");
  }
  if (input.schema_version !== SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION) {
    return invalid("schema_version", "does not match the canonical session runtime directory schema");
  }
  const sessionId = identifier(input.session_id, "session_id");
  if (!sessionId.ok) return sessionId;
  const executionId = identifier(input.execution_id, "execution_id");
  if (!executionId.ok) return executionId;

  if (!isRecord(input.profile)) return invalid("profile", "expected the selected profile identity");
  const profileKeys = assertKeys(input.profile, ["id", "version"], "profile");
  if (!profileKeys.ok) return profileKeys;
  const profileId = identifier(input.profile.id, "profile.id");
  if (!profileId.ok) return profileId;
  if (typeof input.profile.version !== "string" || input.profile.version.length === 0) {
    return invalid("profile.version", "expected non-empty profile version");
  }

  if (!isRecord(input.owner)) return invalid("owner", "expected an owner identity");
  const ownerKeys = assertKeys(input.owner, ["uid", "gid"], "owner");
  if (!ownerKeys.ok) return ownerKeys;
  const uid = ownerId(input.owner.uid, "owner.uid");
  if (!uid.ok) return uid;
  const gid = ownerId(input.owner.gid, "owner.gid");
  if (!gid.ok) return gid;

  if (!isRecord(input.session)) return invalid("session", "expected the durable session directory group");
  const sessionKeys = assertKeys(input.session, ["root", "home", "xdg"], "session");
  if (!sessionKeys.ok) return sessionKeys;
  const sessionRoot = directory(input.session.root, "session.root", "session", "durable", "read-write");
  if (!sessionRoot.ok) return sessionRoot;
  const home = directory(input.session.home, "session.home", "session", "durable", "read-write");
  if (!home.ok) return home;
  if (home.value.path !== sessionRoot.value.path) return ambiguous("session.home", "must be the session root");
  if (!isRecord(input.session.xdg)) return invalid("session.xdg", "expected XDG directory descriptors");
  const xdgKeys = assertKeys(input.session.xdg, ["config", "cache", "data", "state"], "session.xdg");
  if (!xdgKeys.ok) return xdgKeys;
  const config = directory(input.session.xdg.config, "session.xdg.config", "session", "durable", "read-write");
  if (!config.ok) return config;
  if (!isBelow(home.value.path, config.value.path)) {
    return invalid("session.xdg.config.path", "must be below HOME");
  }
  const cacheValue = input.session.xdg.cache;
  if (!isRecord(cacheValue)) return invalid("session.xdg.cache", "expected a cache directory descriptor");
  if (cacheValue.scope === "session") {
    const cache = directory(cacheValue, "session.xdg.cache", "session", "durable", "read-write");
    if (!cache.ok) return cache;
    if (!cache.value.path.startsWith(`${home.value.path}/`)) {
      return invalid("session.xdg.cache.path", "session cache must be below HOME");
    }
    // Continue with the canonical session-cache descriptor below.
  } else if (cacheValue.scope !== "shared-read-only") {
    return invalid("session.xdg.cache.scope", "must be session or shared-read-only");
  }
  const cache =
    cacheValue.scope === "session"
      ? directory(cacheValue, "session.xdg.cache", "session", "durable", "read-write")
      : directory(cacheValue, "session.xdg.cache", "shared-read-only", "durable", "read-only");
  if (!cache.ok) return cache;
  const data = directory(input.session.xdg.data, "session.xdg.data", "session", "durable", "read-write");
  if (!data.ok) return data;
  if (!isBelow(home.value.path, data.value.path)) {
    return invalid("session.xdg.data.path", "must be below HOME");
  }
  const state = directory(input.session.xdg.state, "session.xdg.state", "session", "durable", "read-write");
  if (!state.ok) return state;
  if (!isBelow(home.value.path, state.value.path)) {
    return invalid("session.xdg.state.path", "must be below HOME");
  }

  if (!isRecord(input.execution)) return invalid("execution", "expected the ephemeral execution directory group");
  const executionKeys = assertKeys(input.execution, ["root", "tmp"], "execution");
  if (!executionKeys.ok) return executionKeys;
  const executionRoot = directory(input.execution.root, "execution.root", "execution", "ephemeral", "read-write");
  if (!executionRoot.ok) return executionRoot;
  const tmp = directory(input.execution.tmp, "execution.tmp", "execution", "ephemeral", "read-write");
  if (!tmp.ok) return tmp;
  if (tmp.value.path !== executionRoot.value.path) return ambiguous("execution.tmp", "must be the execution root");
  if (executionRoot.value.path === sessionRoot.value.path) {
    return ambiguous("execution.root", "must not be the durable session root");
  }

  const all = [home.value, config.value, cache.value, data.value, state.value, tmp.value];
  const paths = new Set<string>();
  for (const candidate of all) {
    if (paths.has(candidate.path)) return ambiguous("directories", "duplicate directory path", candidate.path);
    paths.add(candidate.path);
  }
  return success(
    Object.freeze({
      contract_id: SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID,
      schema_version: SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION,
      session_id: sessionId.value,
      execution_id: executionId.value,
      profile: Object.freeze({ id: profileId.value, version: input.profile.version }),
      owner: Object.freeze({ uid: uid.value, gid: gid.value }),
      session: Object.freeze({
        root: sessionRoot.value,
        home: home.value,
        xdg: Object.freeze({ config: config.value, cache: cache.value, data: data.value, state: state.value }),
      }),
      execution: Object.freeze({ root: executionRoot.value, tmp: tmp.value }),
    }),
  );
}

function assertDistinctRoots(
  sessionRoot: string,
  executionRoot: string,
  sharedCacheRoot: string | undefined,
): DomainResult<null> {
  const roots = [sessionRoot, executionRoot, ...(sharedCacheRoot === undefined ? [] : [sharedCacheRoot])];
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) return ambiguous("identity", "directory roots must be distinct", root);
    seen.add(root);
  }
  return success(null);
}

function validateIdentity(input: unknown): DomainResult<SessionRuntimeEnvironmentIdentity> {
  if (!isRecord(input)) return invalid("identity", "expected an explicit session/execution identity");
  const keys = assertKeys(
    input,
    [
      "session_id",
      "execution_id",
      "session_root",
      "execution_root",
      "shared_cache_root",
      "owner_uid",
      "owner_gid",
      "term",
    ],
    "identity",
  );
  if (!keys.ok) return keys;
  const sessionId = identifier(input.session_id, "identity.session_id");
  if (!sessionId.ok) return sessionId;
  const executionId = identifier(input.execution_id, "identity.execution_id");
  if (!executionId.ok) return executionId;
  const sessionRoot = canonicalHostPath(String(input.session_root), "identity.session_root");
  if (!sessionRoot.ok) return sessionRoot;
  const executionRoot = canonicalHostPath(String(input.execution_root), "identity.execution_root");
  if (!executionRoot.ok) return executionRoot;
  let sharedCacheRoot: string | undefined;
  if (input.shared_cache_root !== undefined) {
    const checked = canonicalHostPath(String(input.shared_cache_root), "identity.shared_cache_root");
    if (!checked.ok) return checked;
    sharedCacheRoot = checked.value;
  }
  const ownerUid = ownerId(input.owner_uid, "identity.owner_uid");
  if (!ownerUid.ok) return ownerUid;
  const ownerGid = ownerId(input.owner_gid, "identity.owner_gid");
  if (!ownerGid.ok) return ownerGid;
  let term: string | undefined;
  if (input.term !== undefined) {
    const checked = displayValue(input.term, "identity.term");
    if (!checked.ok) return checked;
    term = checked.value;
  }
  const distinct = assertDistinctRoots(sessionRoot.value, executionRoot.value, sharedCacheRoot);
  if (!distinct.ok) return distinct;
  return success(
    Object.freeze({
      session_id: sessionId.value,
      execution_id: executionId.value,
      session_root: sessionRoot.value,
      execution_root: executionRoot.value,
      ...(sharedCacheRoot === undefined ? {} : { shared_cache_root: sharedCacheRoot }),
      owner_uid: ownerUid.value,
      owner_gid: ownerGid.value,
      ...(term === undefined ? {} : { term }),
    }),
  );
}

function directoryDescriptor(
  directoryPath: string,
  scope: SessionRuntimeDirectoryScope,
  durability: SessionRuntimeDirectoryDurability,
  access: SessionRuntimeDirectoryAccess,
): SessionRuntimeDirectory {
  return Object.freeze({ path: directoryPath, scope, durability, access, mode: DIRECTORY_MODE });
}

/**
 * Compile one explicit profile and session identity into the fixed runtime
 * environment. This is pure: it does not read the host environment or touch
 * the filesystem. Host paths are retained only in the returned manifest;
 * processes receive the existing logical /home/nawabari and /tmp roots.
 */
export function compileSessionEnvironment(
  profileInput: unknown,
  identityInput: unknown,
): DomainResult<CompiledSessionEnvironment> {
  const profile = validateWorktreeRuntimeProfile(profileInput);
  if (!profile.ok) return failure(profile.error);
  const identity = validateIdentity(identityInput);
  if (!identity.ok) return identity;
  const selected = profile.value;
  const cacheIsShared = selected.environment.xdg.cache === "shared-read-only";
  if (cacheIsShared && identity.value.shared_cache_root === undefined) {
    return invalid("identity.shared_cache_root", "is required by the shared-read-only cache profile");
  }
  if (!cacheIsShared && identity.value.shared_cache_root !== undefined) {
    return ambiguous("identity.shared_cache_root", "was supplied but the profile selects a session cache");
  }

  const home = directoryDescriptor(identity.value.session_root, "session", "durable", "read-write");
  const config = directoryDescriptor(path.posix.join(home.path, ".config"), "session", "durable", "read-write");
  const cache = cacheIsShared
    ? directoryDescriptor(identity.value.shared_cache_root as string, "shared-read-only", "durable", "read-only")
    : directoryDescriptor(path.posix.join(home.path, ".cache"), "session", "durable", "read-write");
  const data = directoryDescriptor(path.posix.join(home.path, ".local", "share"), "session", "durable", "read-write");
  const state = directoryDescriptor(path.posix.join(home.path, ".local", "state"), "session", "durable", "read-write");
  const tmp = directoryDescriptor(identity.value.execution_root, "execution", "ephemeral", "read-write");
  const manifestResult = validateManifest({
    contract_id: SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID,
    schema_version: SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION,
    session_id: identity.value.session_id,
    execution_id: identity.value.execution_id,
    profile: { id: selected.id, version: selected.version },
    owner: { uid: identity.value.owner_uid, gid: identity.value.owner_gid },
    session: { root: home, home, xdg: { config, cache, data, state } },
    execution: { root: tmp, tmp },
  });
  if (!manifestResult.ok) return manifestResult;

  const environment: Record<string, string> = {
    PATH: CANONICAL_EXECUTABLE_ROOT,
    SHELL: `${CANONICAL_EXECUTABLE_ROOT}/${selected.shell.entrypoint}`,
    HOME: SESSION_RUNTIME_LOGICAL_HOME,
    TMPDIR: SESSION_RUNTIME_LOGICAL_TMPDIR,
    XDG_CONFIG_HOME: SESSION_RUNTIME_LOGICAL_CONFIG_HOME,
    XDG_CACHE_HOME: SESSION_RUNTIME_LOGICAL_CACHE_HOME,
    XDG_DATA_HOME: SESSION_RUNTIME_LOGICAL_DATA_HOME,
    XDG_STATE_HOME: SESSION_RUNTIME_LOGICAL_STATE_HOME,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (identity.value.term !== undefined) environment.TERM = identity.value.term;
  return success(
    Object.freeze({
      environment: Object.freeze(environment),
      manifest: manifestResult.value,
    }),
  );
}

function manifestJsonValue(manifest: SessionRuntimeDirectoryManifest): JsonObject {
  return manifest as unknown as JsonObject;
}

/** Validate and canonicalize the descriptor consumed by materialization. */
export function validateSessionRuntimeDirectoryManifest(input: unknown): DomainResult<SessionRuntimeDirectoryManifest> {
  return validateManifest(input);
}

/** Serialize the manifest under the canonical sandbox document key. */
export function serializeSessionRuntimeDirectoryManifest(input: unknown): DomainResult<string> {
  const manifest = validateManifest(input);
  return manifest.ok
    ? success(JSON.stringify({ [SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY]: manifestJsonValue(manifest.value) }))
    : failure(manifest.error);
}

function directoryEntries(manifest: SessionRuntimeDirectoryManifest): readonly SessionRuntimeDirectory[] {
  return [
    manifest.session.root,
    manifest.session.home,
    manifest.session.xdg.config,
    manifest.session.xdg.cache,
    manifest.session.xdg.data,
    manifest.session.xdg.state,
    manifest.execution.root,
    manifest.execution.tmp,
  ];
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function directoryFlags(): number {
  return fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
}

function ensureDirectoryTree(directoryPath: string): DomainResult<null> {
  const parts = directoryPath.split(path.posix.sep).filter((part) => part.length > 0);
  let current = "/";
  try {
    for (const part of parts) {
      current = path.posix.join(current, part);
      const existing = fs.lstatSync(current, { throwIfNoEntry: false });
      if (existing === undefined) {
        fs.mkdirSync(current, { mode: DIRECTORY_MODE });
        fs.chmodSync(current, DIRECTORY_MODE);
      } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
        return materializationFailure("path", "a parent is not a real directory", current);
      }
    }
    return success(null);
  } catch (error) {
    return materializationFailure(
      "path",
      error instanceof Error ? error.message : "unable to create directory tree",
      directoryPath,
    );
  }
}

function inspectDirectory(
  descriptor: SessionRuntimeDirectory,
  expectedUid: number,
  expectedGid: number,
): DomainResult<SessionRuntimeDirectoryObservation> {
  let fd: number | null = null;
  try {
    fd = fs.openSync(descriptor.path, directoryFlags());
    const descriptorStat = fs.fstatSync(fd, { bigint: true });
    if (!descriptorStat.isDirectory())
      return materializationFailure("dirfd", "the opened object is not a directory", descriptor.path);
    if ((descriptorStat.mode & 0o777n) !== BigInt(DIRECTORY_MODE)) {
      return materializationFailure("mode", "directory mode is not 0700", descriptor.path);
    }
    if (Number(descriptorStat.uid) !== expectedUid || Number(descriptorStat.gid) !== expectedGid) {
      return materializationFailure("owner", "directory ownership does not match the issued identity", descriptor.path);
    }
    const pathStat = fs.lstatSync(descriptor.path, { bigint: true });
    if (pathStat.isSymbolicLink() || !sameIdentity(descriptorStat, pathStat)) {
      return materializationFailure(
        "dirfd",
        "directory pathname identity differs from its descriptor",
        descriptor.path,
      );
    }
    return success(
      Object.freeze({
        path: descriptor.path,
        scope: descriptor.scope,
        durability: descriptor.durability,
        access: descriptor.access,
        mode: DIRECTORY_MODE,
        uid: Number(descriptorStat.uid),
        gid: Number(descriptorStat.gid),
        dev: descriptorStat.dev.toString(),
        ino: descriptorStat.ino.toString(),
      }),
    );
  } catch (error) {
    return materializationFailure(
      "dirfd",
      error instanceof Error ? error.message : "unable to open or inspect directory",
      descriptor.path,
    );
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the materialization result or original failure.
      }
    }
  }
}

/**
 * Materialize only the paths in the validated manifest. Every directory is
 * opened with a directory fd, checked against its pathname identity, and
 * required to be owned by the issued uid/gid with mode 0700. Shared cache is
 * represented as read-only metadata and is never made writable here.
 */
export function materializeSessionRuntimeDirectories(
  input: unknown,
): DomainResult<MaterializedSessionRuntimeDirectories> {
  const manifest = validateManifest(input);
  if (!manifest.ok) return manifest;
  const ordered = directoryEntries(manifest.value);
  const unique = new Set<string>();
  const observations: SessionRuntimeDirectoryObservation[] = [];
  for (const entry of ordered) {
    if (unique.has(entry.path)) continue;
    unique.add(entry.path);
    if (entry.access === "read-write") {
      const created = ensureDirectoryTree(entry.path);
      if (!created.ok) return created;
    } else {
      try {
        if (fs.lstatSync(entry.path, { throwIfNoEntry: false }) === undefined) {
          return materializationFailure("shared-cache", "an explicit read-only cache must already exist", entry.path);
        }
      } catch (error) {
        return materializationFailure(
          "shared-cache",
          error instanceof Error ? error.message : "unable to inspect the read-only cache",
          entry.path,
        );
      }
    }
    const inspected = inspectDirectory(entry, manifest.value.owner.uid, manifest.value.owner.gid);
    if (!inspected.ok) return inspected;
    observations.push(inspected.value);
  }
  observations.sort((left, right) => compareText(left.path, right.path));
  return success(Object.freeze({ manifest: manifest.value, directories: Object.freeze(observations) }));
}

/**
 * Remove only one execution's ephemeral root after re-validating its owner,
 * mode, and descriptor identity. Durable session directories are never part
 * of this operation.
 */
export function cleanupSessionRuntimeDirectories(
  input: unknown,
): DomainResult<{ readonly execution_id: string; readonly removed: boolean }> {
  const manifest = validateManifest(input);
  if (!manifest.ok) return manifest;
  const inspected = inspectDirectory(manifest.value.execution.tmp, manifest.value.owner.uid, manifest.value.owner.gid);
  if (!inspected.ok) return inspected;
  try {
    fs.rmSync(manifest.value.execution.tmp.path, { recursive: true, force: false });
    return success(Object.freeze({ execution_id: manifest.value.execution_id, removed: true }));
  } catch (error) {
    return materializationFailure(
      "cleanup",
      error instanceof Error ? error.message : "unable to remove execution directory",
      manifest.value.execution.tmp.path,
    );
  }
}

export const SESSION_RUNTIME_DIRECTORY_MANIFEST_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: SESSION_RUNTIME_DIRECTORY_MANIFEST_CONTRACT_ID,
  schema_version: SESSION_RUNTIME_DIRECTORY_MANIFEST_SCHEMA_VERSION,
  serialization_key: SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY,
  scopes: ["session", "shared-read-only", "execution"],
  durability: { session: "durable", execution: "ephemeral" },
  required_mode: "0700",
  authorities: {
    profile: "validated WorktreeRuntimeProfile.environment",
    ownership: "issued session owner uid/gid",
    executable_path: CANONICAL_EXECUTABLE_ROOT,
  },
  excludes: ["ambient HOME", "ambient XDG roots", "ambient TMPDIR", "arbitrary environment overrides"],
});
