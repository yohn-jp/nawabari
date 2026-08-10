import fs from "node:fs";
import path from "node:path";

import {
  defaultGit,
  normalizeBranchId,
  resolveRepositoryContext,
  type GitCommandRunner,
  type RepositoryContext,
} from "./git.js";
import { SessionRegistryError } from "./errors.js";
import { generateSessionId, isSessionId } from "./session-id.js";

export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const REGISTRY_DIRECTORY_NAME = "git-paw";
export const REGISTRY_FILE_NAME = "session-registry.json";
export const REGISTRY_LOCK_FILE_NAME = "session-registry.lock";

export type RegistrySchemaVersion = typeof REGISTRY_SCHEMA_VERSION;
export type SessionState = "new" | "active" | "closing" | "closed" | "stale";

export interface SessionRecord {
  readonly schemaVersion: RegistrySchemaVersion;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly label?: string;
}

export interface CreateSessionOptions {
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly label?: string;
}

export interface SessionRegistryOptions {
  readonly cwd?: string;
  readonly repository?: RepositoryContext;
  readonly git?: GitCommandRunner;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly lockTimeoutMs?: number;
}

export interface RegistryPaths {
  readonly directory: string;
  readonly registry: string;
  readonly lock: string;
}

export interface PersistedSessionRecord {
  readonly schema_version: RegistrySchemaVersion;
  readonly session_id: string;
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly worktree_path: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly state: SessionState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly label?: string;
}

export interface PersistedRegistry {
  readonly schema_version: RegistrySchemaVersion;
  readonly repository_id: string;
  readonly sessions: readonly PersistedSessionRecord[];
}

const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing", "stale"]);
const SESSION_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing", "closed", "stale"]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ID_GENERATION_ATTEMPTS = 8;

export class SessionRegistry {
  readonly repository: RepositoryContext;
  readonly paths: RegistryPaths;

  private readonly git: GitCommandRunner | undefined;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly lockTimeoutMs: number;

  constructor(options: SessionRegistryOptions = {}) {
    this.repository = options.repository ?? resolveRepositoryContext({ cwd: options.cwd, git: options.git });
    this.git = options.git ?? defaultGit;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? generateSessionId;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;

    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
      throw new RangeError("lockTimeoutMs must be a non-negative safe integer");
    }

    const directory = path.join(this.repository.commonGitDirectory, REGISTRY_DIRECTORY_NAME);
    this.paths = Object.freeze({
      directory,
      registry: path.join(directory, REGISTRY_FILE_NAME),
      lock: path.join(directory, REGISTRY_LOCK_FILE_NAME),
    });
  }

  read(): readonly SessionRecord[] {
    return this.readUnsafe().map(cloneSessionRecord);
  }

  list(): readonly SessionRecord[] {
    return this.read();
  }

  get(sessionId: string): SessionRecord | undefined {
    assertSessionId(sessionId);
    const record = this.readUnsafe().find((candidate) => candidate.sessionId === sessionId);
    return record === undefined ? undefined : cloneSessionRecord(record);
  }

  create(options: CreateSessionOptions = {}): SessionRecord {
    const resources = this.resolveCreationResources(options);

    return this.mutate((records) => {
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        const sessionId = this.idGenerator();
        assertSessionId(sessionId);
        if (records.some((record) => record.sessionId === sessionId)) {
          continue;
        }

        const timestamp = toTimestamp(this.clock());
        const record = freezeSessionRecord({
          schemaVersion: REGISTRY_SCHEMA_VERSION,
          sessionId,
          repositoryId: this.repository.repositoryId,
          worktreeId: resources.worktreeId,
          worktreePath: resources.worktreePath,
          branchId: resources.branchId,
          branchName: resources.branchName,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          ...(options.label === undefined ? {} : { label: validateLabel(options.label) }),
        });

        assertNoOwnershipConflict(records, record);
        return { records: [...records, record], result: cloneSessionRecord(record) };
      }

      throw new SessionRegistryError(
        "SESSION_ID_COLLISION",
        `Could not generate a unique session ID after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
        { attempts: MAX_ID_GENERATION_ATTEMPTS },
      );
    });
  }

  createSession(options: CreateSessionOptions = {}): SessionRecord {
    return this.create(options);
  }

  register(record: SessionRecord): SessionRecord {
    const validated = validateSessionRecord(record, this.repository.repositoryId);
    return this.mutate((records) => {
      if (records.some((candidate) => candidate.sessionId === validated.sessionId)) {
        throw new SessionRegistryError("DUPLICATE_SESSION_ID", `Session ID already exists: ${validated.sessionId}`, {
          sessionId: validated.sessionId,
        });
      }
      assertNoOwnershipConflict(records, validated);
      return { records: [...records, validated], result: cloneSessionRecord(validated) };
    });
  }

  registerSession(record: SessionRecord): SessionRecord {
    return this.register(record);
  }

  resolveCurrentSession(): SessionRecord {
    const records = this.readUnsafe();
    const matches = records.filter(
      (record) => ACTIVE_STATES.has(record.state) && record.worktreeId === this.repository.worktreePath,
    );

    if (matches.length === 1) {
      return cloneSessionRecord(matches[0]);
    }
    if (matches.length > 1) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Multiple active sessions claim the current worktree: ${this.repository.worktreePath}`,
        { worktree: this.repository.worktreePath },
      );
    }

    throw new SessionRegistryError(
      "SESSION_NOT_FOUND",
      `No active session owns the current worktree: ${this.repository.worktreePath}`,
      { worktree: this.repository.worktreePath },
    );
  }

  currentSession(): SessionRecord {
    return this.resolveCurrentSession();
  }

  private resolveCreationResources(options: CreateSessionOptions): CreationResources {
    const worktreePath = canonicalWorktreePath(options.worktreePath ?? this.repository.worktreePath);
    const branchName =
      options.branchName ??
      (worktreePath === this.repository.worktreePath ? readCurrentBranch(this.git, worktreePath) : undefined);

    if (branchName === undefined) {
      throw new SessionRegistryError(
        "WORKTREE_IDENTITY_AMBIGUOUS",
        `A branch identity is required for a worktree other than the current worktree: ${worktreePath}`,
        { worktree: worktreePath },
      );
    }

    const branchId = normalizeBranchId(branchName);
    return {
      worktreeId: worktreePath,
      worktreePath,
      branchId,
      branchName: branchId.slice("refs/heads/".length),
    };
  }

  private readUnsafe(): readonly SessionRecord[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.paths.registry, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not read ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "REGISTRY_CORRUPT",
        `Registry is not valid JSON: ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }

    return parseRegistry(parsed, this.repository.repositoryId);
  }

  private writeUnsafe(records: readonly SessionRecord[]): void {
    const registry: PersistedRegistry = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      repository_id: this.repository.repositoryId,
      sessions: records.map(toPersistedSessionRecord),
    };
    const contents = `${JSON.stringify(registry, null, 2)}\n`;
    const temporaryPath = `${this.paths.registry}.tmp-${process.pid}-${generateSessionId()}`;
    let descriptor: number | undefined;

    try {
      fs.mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.paths.registry);
      syncDirectory(this.paths.directory);
    } catch (error: unknown) {
      if (descriptor !== undefined) {
        closeQuietly(descriptor);
      }
      unlinkQuietly(temporaryPath);
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not atomically write ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }
  }

  private mutate<T>(mutation: (records: readonly SessionRecord[]) => MutationResult<T>): T {
    return this.withLock(() => {
      const records = this.readUnsafe();
      const { records: nextRecords, result } = mutation(records);
      validateRecords(nextRecords, this.repository.repositoryId);
      this.writeUnsafe(nextRecords);
      return result;
    });
  }

  private withLock<T>(operation: () => T): T {
    fs.mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    let descriptor: number | undefined;

    while (descriptor === undefined) {
      try {
        descriptor = fs.openSync(this.paths.lock, "wx", 0o600);
        fs.writeFileSync(descriptor, `${process.pid}\n`, "utf8");
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== "EEXIST") {
          throw new SessionRegistryError(
            "REGISTRY_IO_FAILURE",
            `Could not acquire ${this.paths.lock}`,
            {
              path: this.paths.lock,
            },
            error,
          );
        }
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new SessionRegistryError("REGISTRY_LOCK_TIMEOUT", `Timed out waiting for ${this.paths.lock}`, {
            path: this.paths.lock,
            timeoutMs: this.lockTimeoutMs,
          });
        }
        waitBriefly();
      }
    }

    try {
      return operation();
    } finally {
      closeQuietly(descriptor);
      try {
        fs.unlinkSync(this.paths.lock);
      } catch (error: unknown) {
        throw new SessionRegistryError(
          "REGISTRY_IO_FAILURE",
          `Could not release ${this.paths.lock}`,
          {
            path: this.paths.lock,
          },
          error,
        );
      }
    }
  }
}

interface CreationResources {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
}

interface MutationResult<T> {
  readonly records: readonly SessionRecord[];
  readonly result: T;
}

export function toPersistedSessionRecord(record: SessionRecord): PersistedSessionRecord {
  const validated = validateSessionRecord(record, record.repositoryId);
  return {
    schema_version: validated.schemaVersion,
    session_id: validated.sessionId,
    repository_id: validated.repositoryId,
    worktree_id: validated.worktreeId,
    worktree_path: validated.worktreePath,
    branch_id: validated.branchId,
    branch_name: validated.branchName,
    state: validated.state,
    created_at: validated.createdAt,
    updated_at: validated.updatedAt,
    ...(validated.label === undefined ? {} : { label: validated.label }),
  };
}

function parseRegistry(value: unknown, expectedRepositoryId: string): readonly SessionRecord[] {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry root must be an object");
  }
  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) {
    if (typeof value.schema_version === "number") {
      throw new SessionRegistryError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Unsupported registry schema version: ${value.schema_version}`,
        {
          schemaVersion: value.schema_version,
        },
      );
    }
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry schema_version must be a number");
  }
  assertExactKeys(value, ["schema_version", "repository_id", "sessions"]);

  if (typeof value.repository_id !== "string" || value.repository_id !== expectedRepositoryId) {
    throw new SessionRegistryError(
      "REGISTRY_REPOSITORY_MISMATCH",
      "Registry repository identity does not match the current repository",
      { expectedRepositoryId, actualRepositoryId: stringifyDetail(value.repository_id) },
    );
  }
  if (!Array.isArray(value.sessions)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry sessions must be an array");
  }

  const records = value.sessions.map((candidate, index) => parseSessionRecord(candidate, index, expectedRepositoryId));
  validateRecords(records, expectedRepositoryId);
  return records;
}

function parseSessionRecord(value: unknown, index: number, expectedRepositoryId: string): SessionRecord {
  if (!isRecord(value)) {
    throw invalidRecord(index, "record must be an object");
  }
  assertExactKeys(
    value,
    [
      "schema_version",
      "session_id",
      "repository_id",
      "worktree_id",
      "worktree_path",
      "branch_id",
      "branch_name",
      "state",
      "created_at",
      "updated_at",
    ],
    ["label"],
    index,
  );

  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) {
    if (typeof value.schema_version === "number") {
      throw new SessionRegistryError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Unsupported session schema version: ${value.schema_version}`,
        {
          schemaVersion: value.schema_version,
          index,
        },
      );
    }
    throw invalidRecord(index, "schema_version must be a number");
  }

  const record: SessionRecord = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    sessionId: requireString(value.session_id, index, "session_id"),
    repositoryId: requireString(value.repository_id, index, "repository_id"),
    worktreeId: requireString(value.worktree_id, index, "worktree_id"),
    worktreePath: requireString(value.worktree_path, index, "worktree_path"),
    branchId: requireString(value.branch_id, index, "branch_id"),
    branchName: requireString(value.branch_name, index, "branch_name"),
    state: requireState(value.state, index),
    createdAt: requireString(value.created_at, index, "created_at"),
    updatedAt: requireString(value.updated_at, index, "updated_at"),
    ...(value.label === undefined ? {} : { label: requireString(value.label, index, "label") }),
  };

  return validateSessionRecord(record, expectedRepositoryId, index);
}

function validateSessionRecord(record: SessionRecord, expectedRepositoryId: string, index?: number): SessionRecord {
  const position = index === undefined ? "" : ` at index ${index}`;
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new SessionRegistryError("UNSUPPORTED_SCHEMA_VERSION", `Unsupported session schema version${position}`, {
      schemaVersion: record.schemaVersion,
    });
  }
  if (!isSessionId(record.sessionId)) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `Invalid session ID${position}: ${record.sessionId}`, {
      sessionId: record.sessionId,
    });
  }
  if (record.repositoryId !== expectedRepositoryId) {
    throw new SessionRegistryError(
      "REGISTRY_REPOSITORY_MISMATCH",
      `Session repository identity does not match${position}`,
      {
        expectedRepositoryId,
        actualRepositoryId: record.repositoryId,
      },
    );
  }
  if (
    !isAbsolutePath(record.repositoryId) ||
    !isAbsolutePath(record.worktreeId) ||
    !isAbsolutePath(record.worktreePath)
  ) {
    throw invalidRecord(index, "repository and worktree identities must be absolute paths");
  }
  if (record.worktreeId !== record.worktreePath) {
    throw invalidRecord(index, "worktree_id must equal the canonical worktree_path");
  }
  if (normalizeBranchId(record.branchName) !== record.branchId) {
    throw invalidRecord(index, "branch_id must be the canonical identity of branch_name");
  }
  if (record.branchName !== record.branchId.slice("refs/heads/".length)) {
    throw invalidRecord(index, "branch_name must be the short name represented by branch_id");
  }
  if (!SESSION_STATES.has(record.state)) {
    throw invalidRecord(index, `unsupported lifecycle state: ${record.state}`);
  }
  if (!isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
    throw invalidRecord(index, "created_at and updated_at must be canonical UTC timestamps");
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw invalidRecord(index, "updated_at cannot precede created_at");
  }
  if (record.label !== undefined && typeof record.label !== "string") {
    throw invalidRecord(index, "label must be a string");
  }

  return freezeSessionRecord({ ...record });
}

function validateRecords(records: readonly SessionRecord[], expectedRepositoryId: string): void {
  const sessionIds = new Set<string>();
  const worktreeOwners = new Map<string, string>();
  const branchOwners = new Map<string, string>();

  for (const [index, record] of records.entries()) {
    const validated = validateSessionRecord(record, expectedRepositoryId, index);
    if (sessionIds.has(validated.sessionId)) {
      throw new SessionRegistryError("DUPLICATE_SESSION_ID", `Duplicate session ID: ${validated.sessionId}`, {
        sessionId: validated.sessionId,
      });
    }
    sessionIds.add(validated.sessionId);

    if (!ACTIVE_STATES.has(validated.state)) {
      continue;
    }
    const existingWorktreeOwner = worktreeOwners.get(validated.worktreeId);
    if (existingWorktreeOwner !== undefined) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Worktree is claimed by multiple active sessions: ${validated.worktreePath}`,
        { worktree: validated.worktreePath, sessionId: validated.sessionId, ownerSessionId: existingWorktreeOwner },
      );
    }
    worktreeOwners.set(validated.worktreeId, validated.sessionId);

    const existingBranchOwner = branchOwners.get(validated.branchId);
    if (existingBranchOwner !== undefined) {
      throw new SessionRegistryError(
        "DUPLICATE_BRANCH_OWNERSHIP",
        `Branch is claimed by multiple active sessions: ${validated.branchId}`,
        { branch: validated.branchId, sessionId: validated.sessionId, ownerSessionId: existingBranchOwner },
      );
    }
    branchOwners.set(validated.branchId, validated.sessionId);
  }
}

function assertNoOwnershipConflict(records: readonly SessionRecord[], candidate: SessionRecord): void {
  if (!ACTIVE_STATES.has(candidate.state)) {
    return;
  }
  for (const record of records) {
    if (!ACTIVE_STATES.has(record.state)) {
      continue;
    }
    if (record.worktreeId === candidate.worktreeId) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Worktree is already owned: ${candidate.worktreePath}`,
        {
          worktree: candidate.worktreePath,
          ownerSessionId: record.sessionId,
        },
      );
    }
    if (record.branchId === candidate.branchId) {
      throw new SessionRegistryError("DUPLICATE_BRANCH_OWNERSHIP", `Branch is already owned: ${candidate.branchId}`, {
        branch: candidate.branchId,
        ownerSessionId: record.sessionId,
      });
    }
  }
}

function canonicalWorktreePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return fs.realpathSync.native(resolved);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      `Could not resolve worktree identity: ${resolved}`,
      {
        worktree: resolved,
      },
      error,
    );
  }
}

function readCurrentBranch(git: GitCommandRunner | undefined, cwd: string): string {
  if (git === undefined) {
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      `A Git runner is required to resolve the current branch for ${cwd}`,
      { cwd },
    );
  }
  try {
    const branchName = git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (branchName.length === 0) {
      throw new SessionRegistryError("WORKTREE_IDENTITY_AMBIGUOUS", `The worktree at ${cwd} has no branch`, { cwd });
    }
    return branchName;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code === "WORKTREE_IDENTITY_AMBIGUOUS") {
      throw error;
    }
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      `Could not resolve the current branch for ${cwd}`,
      { cwd },
      error,
    );
  }
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `Invalid session ID: ${sessionId}`, { sessionId });
  }
}

function validateLabel(label: string): string {
  if (typeof label !== "string") {
    throw new SessionRegistryError("INVALID_SESSION_RECORD", "Session label must be a string");
  }
  return label;
}

function toTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new SessionRegistryError("INVALID_SESSION_RECORD", "Session clock returned an invalid timestamp");
  }
  return date.toISOString();
}

function isTimestamp(value: string): boolean {
  return (
    ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
  );
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !value.includes("\u0000");
}

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  return freezeSessionRecord({ ...record });
}

function freezeSessionRecord(record: SessionRecord): SessionRecord {
  return Object.freeze(record);
}

function requireString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRecord(index, `${field} must be a non-empty string`);
  }
  return value;
}

function requireState(value: unknown, index: number): SessionState {
  if (typeof value !== "string" || !SESSION_STATES.has(value as SessionState)) {
    throw invalidRecord(index, `state is invalid: ${stringifyDetail(value)}`);
  }
  return value as SessionState;
}

function invalidRecord(index: number | undefined, reason: string): SessionRegistryError {
  return new SessionRegistryError(
    "INVALID_SESSION_RECORD",
    `Invalid session record${index === undefined ? "" : ` at index ${index}`}: ${reason}`,
    {
      ...(index === undefined ? {} : { index }),
    },
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  index?: number,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.length !== required.length + optional.filter((key) => Object.hasOwn(value, key)).length ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw invalidRecord(index, `unexpected or missing fields: ${keys.join(", ")}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalidRecord(index, `missing field: ${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function stringifyDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "<invalid>";
}

function waitBriefly(): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, 10);
}

function closeQuietly(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch {
    // The original operation's error is more useful than a best-effort close error.
  }
}

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // A missing temporary file is already the desired state.
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // file itself was fsynced before rename, so continue on that limitation.
  } finally {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
  }
}
