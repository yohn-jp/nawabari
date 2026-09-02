import { hostname as getHostname } from "node:os";
import fs from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { writeJsonAtomically, writeJsonAtomicallySync } from "./atomic.js";
import { RegistryError } from "./errors.js";
import { LOCK_SCHEMA_VERSION, type LockOwnerRecord } from "./types.js";

export type LockFailureCode = "LOCK_BUSY" | "LOCK_STALE" | "LOCK_INVALID" | "LOCK_IO_ERROR" | "LOCK_RELEASE_FAILED";

/**
 * Stale-lock recovery is safe only where Nawabari can compare an exact
 * process-generation identity.  The current implementation provides that
 * identity through Linux /proc start-time ticks.
 */
export const REGISTRY_LOCK_RECOVERY_SUPPORTED_PLATFORMS = ["linux"] as const;

export class RegistryLockError extends RegistryError {
  public readonly lockPath: string;
  public readonly owner?: LockOwnerRecord;

  public constructor(
    code: LockFailureCode,
    message: string,
    lockPath: string,
    details: Readonly<Record<string, unknown>> = {},
    owner?: LockOwnerRecord,
  ) {
    super(code, message, details);
    this.name = "RegistryLockError";
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export interface RepositoryLockOptions {
  lockPath: string;
  staleAfterMs?: number;
  acquireTimeoutMs?: number;
  retryDelayMs?: number;
  metadataGraceMs?: number;
  hostname?: string;
  processStartTime?: string | null;
  /** Test seam for deterministic platform-specific lock behavior. */
  platform?: NodeJS.Platform;
  clock?: () => number;
  /** Test seam used to exercise the reclaim/create race deterministically. */
  beforeReclaimRemove?: () => void | Promise<void>;
  /** Test seam used to confirm a contender observed an active reclaim marker. */
  onReclaimMarkerObserved?: () => void;
}

export interface LockLease {
  readonly token: string;
  readonly owner: LockOwnerRecord;
  release(): Promise<void>;
}

export interface SyncLockLease {
  readonly token: string;
  readonly owner: LockOwnerRecord;
  release(): void;
}

const DEFAULT_STALE_AFTER_MS = 5_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_DELAY_MS = 10;
// Lock-directory creation and owner metadata publication are separate
// filesystem operations. Give a contending process enough time to observe
// the atomic owner-file rename under a loaded CI or local filesystem before
// treating an otherwise young lock as invalid.
const DEFAULT_METADATA_GRACE_MS = 1_000;

interface LockOptionsResolved {
  lockPath: string;
  staleAfterMs: number;
  acquireTimeoutMs: number;
  retryDelayMs: number;
  metadataGraceMs: number;
  hostname: string;
  processStartTime: string | null | undefined;
  platform: NodeJS.Platform;
  clock: () => number;
  beforeReclaimRemove?: () => void | Promise<void>;
  onReclaimMarkerObserved?: () => void;
}

type LockInspection = { kind: "wait"; owner?: LockOwnerRecord } | { kind: "stale"; owner: LockOwnerRecord };

type OwnerLiveness = "alive" | "dead" | "unknown";

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseLockOwner(value: unknown): LockOwnerRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const processStartTime = value.processStartTime;
  if (
    value.schemaVersion !== LOCK_SCHEMA_VERSION ||
    typeof value.token !== "string" ||
    value.token.length === 0 ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    (typeof processStartTime !== "string" && processStartTime !== null) ||
    !isTimestamp(value.acquiredAt)
  ) {
    return undefined;
  }

  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token: value.token,
    pid: value.pid,
    hostname: value.hostname,
    processStartTime,
    acquiredAt: value.acquiredAt,
  };
}

async function readOwner(directory: string): Promise<LockOwnerRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(directory, "owner.json"), "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  try {
    return parseLockOwner(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

function readOwnerSync(directory: string): LockOwnerRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(join(directory, "owner.json"), "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }

  try {
    return parseLockOwner(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

async function createOwner(options: LockOptionsResolved, now: number): Promise<LockOwnerRecord> {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    hostname: options.hostname,
    processStartTime:
      options.processStartTime === undefined
        ? await readProcessStartTimeForPlatform(process.pid, options.platform)
        : options.processStartTime,
    acquiredAt: new Date(now).toISOString(),
  };
}

function createOwnerSync(options: LockOptionsResolved, now: number): LockOwnerRecord {
  return {
    schemaVersion: LOCK_SCHEMA_VERSION,
    token: randomUUID(),
    pid: process.pid,
    hostname: options.hostname,
    processStartTime:
      options.processStartTime === undefined
        ? readProcessStartTimeSyncForPlatform(process.pid, options.platform)
        : options.processStartTime,
    acquiredAt: new Date(now).toISOString(),
  };
}

function assertNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

/**
 * Read Linux's process start token. A PID alone is not sufficient for safe
 * stale-lock recovery because the operating system can reuse a PID.
 */
export async function readProcessStartTime(pid: number): Promise<string | null> {
  return readProcessStartTimeForPlatform(pid, process.platform);
}

async function readProcessStartTimeForPlatform(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  if (platform !== "linux") {
    return null;
  }

  try {
    return parseProcessStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

function parseProcessStartTime(raw: string): string | null {
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd === -1) {
    return null;
  }

  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  return startTime === undefined || startTime.length === 0 ? null : startTime;
}

function readProcessStartTimeSync(pid: number): string | null {
  return readProcessStartTimeSyncForPlatform(pid, process.platform);
}

function readProcessStartTimeSyncForPlatform(pid: number, platform: NodeJS.Platform): string | null {
  if (platform !== "linux") {
    return null;
  }

  try {
    return parseProcessStartTime(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return null;
  }
}

async function ownerLiveness(
  owner: LockOwnerRecord,
  localHostname: string,
  platform: NodeJS.Platform,
): Promise<OwnerLiveness> {
  if (owner.hostname !== localHostname || owner.processStartTime === null || platform !== "linux") {
    return "unknown";
  }
  if (!/^\d+$/.test(owner.processStartTime)) {
    return "unknown";
  }

  const currentStartTime = await readProcessStartTimeForPlatform(owner.pid, platform);
  if (currentStartTime !== null) {
    return currentStartTime === owner.processStartTime ? "alive" : "dead";
  }

  try {
    process.kill(owner.pid, 0);
    return "unknown";
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? "dead" : "unknown";
  }
}

function ownerLivenessSync(owner: LockOwnerRecord, localHostname: string, platform: NodeJS.Platform): OwnerLiveness {
  if (owner.hostname !== localHostname || owner.processStartTime === null || platform !== "linux") {
    return "unknown";
  }
  if (!/^\d+$/.test(owner.processStartTime)) {
    return "unknown";
  }

  const currentStartTime = readProcessStartTimeSyncForPlatform(owner.pid, platform);
  if (currentStartTime !== null) {
    return currentStartTime === owner.processStartTime ? "alive" : "dead";
  }

  try {
    process.kill(owner.pid, 0);
    return "unknown";
  } catch (error) {
    return isErrorCode(error, "ESRCH") ? "dead" : "unknown";
  }
}

function detailsForOwner(owner: LockOwnerRecord | undefined): Readonly<Record<string, unknown>> {
  return owner === undefined ? {} : { owner };
}

function asLockError(error: unknown, code: LockFailureCode, message: string, lockPath: string): RegistryLockError {
  if (error instanceof RegistryLockError) {
    return error;
  }

  return new RegistryLockError(code, message, lockPath, {
    cause: error instanceof Error ? error.message : String(error),
  });
}

class Lease implements LockLease {
  private released = false;

  public constructor(
    public readonly token: string,
    public readonly owner: LockOwnerRecord,
    private readonly releaseLock: (owner: LockOwnerRecord) => Promise<void>,
  ) {}

  public async release(): Promise<void> {
    if (this.released) {
      return;
    }

    await this.releaseLock(this.owner);
    this.released = true;
  }
}

class SyncLease implements SyncLockLease {
  private released = false;

  public constructor(
    public readonly token: string,
    public readonly owner: LockOwnerRecord,
    private readonly releaseLock: (owner: LockOwnerRecord) => void,
  ) {}

  public release(): void {
    if (this.released) {
      return;
    }

    this.releaseLock(this.owner);
    this.released = true;
  }
}

export class RepositoryLock {
  private readonly options: LockOptionsResolved;
  private readonly reclaimPath: string;

  public constructor(options: RepositoryLockOptions) {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    const metadataGraceMs = options.metadataGraceMs ?? DEFAULT_METADATA_GRACE_MS;
    assertNonNegative("staleAfterMs", staleAfterMs);
    assertNonNegative("acquireTimeoutMs", acquireTimeoutMs);
    assertNonNegative("retryDelayMs", retryDelayMs);
    assertNonNegative("metadataGraceMs", metadataGraceMs);

    this.options = {
      lockPath: resolve(options.lockPath),
      staleAfterMs,
      acquireTimeoutMs,
      retryDelayMs,
      metadataGraceMs,
      hostname: options.hostname ?? getHostname(),
      processStartTime: options.processStartTime,
      platform: options.platform ?? process.platform,
      clock: options.clock ?? Date.now,
      beforeReclaimRemove: options.beforeReclaimRemove,
      onReclaimMarkerObserved: options.onReclaimMarkerObserved,
    };
    this.reclaimPath = `${this.options.lockPath}.reclaim`;
  }

  public get lockPath(): string {
    return this.options.lockPath;
  }

  public async acquire(): Promise<LockLease> {
    await mkdir(dirname(this.options.lockPath), { recursive: true, mode: 0o700 });
    const deadline = this.options.clock() + this.options.acquireTimeoutMs;

    while (true) {
      const created = await this.tryCreate();
      if (created !== undefined) {
        return created;
      }

      const inspection = await this.inspectExisting();
      if (inspection.kind === "stale") {
        const reclaimed = await this.tryReclaim(inspection.owner);
        if (reclaimed) {
          continue;
        }
      }

      const remaining = deadline - this.options.clock();
      if (remaining <= 0) {
        throw new RegistryLockError(
          "LOCK_BUSY",
          "Repository registry lock is held by another process",
          this.options.lockPath,
          detailsForOwner(inspection.owner),
          inspection.owner,
        );
      }

      await sleep(Math.min(Math.max(this.options.retryDelayMs, 1), remaining));
    }
  }

  /** Synchronous adapter for the legacy synchronous SessionRegistry API. */
  public acquireSync(): SyncLockLease {
    fs.mkdirSync(dirname(this.options.lockPath), { recursive: true, mode: 0o700 });
    const deadline = this.options.clock() + this.options.acquireTimeoutMs;

    while (true) {
      const created = this.tryCreateSync();
      if (created !== undefined) {
        return created;
      }

      const inspection = this.inspectExistingSync();
      if (inspection.kind === "stale") {
        const reclaimed = this.tryReclaimSync(inspection.owner);
        if (reclaimed) {
          continue;
        }
      }

      const remaining = deadline - this.options.clock();
      if (remaining <= 0) {
        throw new RegistryLockError(
          "LOCK_BUSY",
          "Repository registry lock is held by another process",
          this.options.lockPath,
          detailsForOwner(inspection.owner),
          inspection.owner,
        );
      }

      waitSync(Math.min(Math.max(this.options.retryDelayMs, 1), remaining));
    }
  }

  private async tryCreate(): Promise<LockLease | undefined> {
    if (await this.reclaimMarkerExists()) {
      this.options.onReclaimMarkerObserved?.();
      return undefined;
    }

    const now = this.options.clock();
    const owner = await createOwner(this.options, now);
    try {
      await mkdir(this.options.lockPath, { mode: 0o700 });
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        return undefined;
      }
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot create repository registry lock", this.options.lockPath);
    }

    // A reclaimer may have claimed the marker between the first check and
    // mkdir(). Never publish a new owner while that marker is active.
    if (await this.reclaimMarkerExists()) {
      this.options.onReclaimMarkerObserved?.();
      await rm(this.options.lockPath, { recursive: true, force: true });
      return undefined;
    }

    try {
      await writeJsonAtomically(join(this.options.lockPath, "owner.json"), owner, {
        ensureParent: false,
      });
    } catch (error) {
      await this.removeCreatedLock(owner.token);
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot initialize repository registry lock", this.options.lockPath);
    }

    return new Lease(owner.token, owner, (leaseOwner) => this.release(leaseOwner));
  }

  private tryCreateSync(): SyncLockLease | undefined {
    if (this.reclaimMarkerExistsSync()) {
      this.options.onReclaimMarkerObserved?.();
      return undefined;
    }

    const owner = createOwnerSync(this.options, this.options.clock());
    try {
      fs.mkdirSync(this.options.lockPath, { mode: 0o700 });
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        return undefined;
      }
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot create repository registry lock", this.options.lockPath);
    }

    if (this.reclaimMarkerExistsSync()) {
      this.options.onReclaimMarkerObserved?.();
      fs.rmSync(this.options.lockPath, { recursive: true, force: true });
      return undefined;
    }

    try {
      writeJsonAtomicallySync(join(this.options.lockPath, "owner.json"), owner, { ensureParent: false });
    } catch (error) {
      this.removeCreatedLockSync(owner.token);
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot initialize repository registry lock", this.options.lockPath);
    }

    return new SyncLease(owner.token, owner, (leaseOwner) => this.releaseSync(leaseOwner));
  }

  private async inspectExisting(): Promise<LockInspection> {
    let lockStats;
    try {
      lockStats = await stat(this.options.lockPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return { kind: "wait" };
      }
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot inspect repository registry lock", this.options.lockPath);
    }

    const owner = await readOwner(this.options.lockPath);
    const now = this.options.clock();
    if (owner === undefined) {
      if (now - lockStats.mtimeMs < this.options.metadataGraceMs) {
        return { kind: "wait" };
      }
      throw new RegistryLockError(
        "LOCK_INVALID",
        "Repository registry lock metadata is missing or invalid",
        this.options.lockPath,
      );
    }

    const acquiredAt = Date.parse(owner.acquiredAt);
    const age = now - acquiredAt;
    if (!Number.isFinite(age) || age < 0) {
      throw new RegistryLockError(
        "LOCK_INVALID",
        "Repository registry lock timestamp is invalid",
        this.options.lockPath,
        detailsForOwner(owner),
        owner,
      );
    }

    if (age < this.options.staleAfterMs) {
      return { kind: "wait", owner };
    }

    const liveness = await ownerLiveness(owner, this.options.hostname, this.options.platform);
    if (liveness === "alive") {
      return { kind: "wait", owner };
    }
    if (liveness === "unknown") {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Repository registry lock is old but its owner cannot be proven dead",
        this.options.lockPath,
        { ...detailsForOwner(owner), reason: "owner_liveness_unknown" },
        owner,
      );
    }

    return { kind: "stale", owner };
  }

  private inspectExistingSync(): LockInspection {
    let lockStats: fs.Stats;
    try {
      lockStats = fs.statSync(this.options.lockPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return { kind: "wait" };
      }
      throw asLockError(error, "LOCK_IO_ERROR", "Cannot inspect repository registry lock", this.options.lockPath);
    }

    const owner = readOwnerSync(this.options.lockPath);
    const now = this.options.clock();
    if (owner === undefined) {
      if (now - lockStats.mtimeMs < this.options.metadataGraceMs) {
        return { kind: "wait" };
      }
      throw new RegistryLockError(
        "LOCK_INVALID",
        "Repository registry lock metadata is missing or invalid",
        this.options.lockPath,
      );
    }

    const age = now - Date.parse(owner.acquiredAt);
    if (!Number.isFinite(age) || age < 0) {
      throw new RegistryLockError(
        "LOCK_INVALID",
        "Repository registry lock timestamp is invalid",
        this.options.lockPath,
        detailsForOwner(owner),
        owner,
      );
    }
    if (age < this.options.staleAfterMs) {
      return { kind: "wait", owner };
    }

    const liveness = ownerLivenessSync(owner, this.options.hostname, this.options.platform);
    if (liveness === "alive") {
      return { kind: "wait", owner };
    }
    if (liveness === "unknown") {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Repository registry lock is old but its owner cannot be proven dead",
        this.options.lockPath,
        { ...detailsForOwner(owner), reason: "owner_liveness_unknown" },
        owner,
      );
    }

    return { kind: "stale", owner };
  }

  private async tryReclaim(owner: LockOwnerRecord): Promise<boolean> {
    let markerCreated = false;
    try {
      await mkdir(this.reclaimPath, { mode: 0o700 });
      markerCreated = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw asLockError(error, "LOCK_IO_ERROR", "Cannot coordinate stale lock recovery", this.options.lockPath);
      }

      try {
        await this.handleExistingReclaimer();
      } catch (error) {
        // An active reclaimer is a normal contention state. Wait for its
        // marker to disappear; malformed or abandoned metadata still fails
        // closed through the typed error.
        if (error instanceof RegistryLockError && error.details.reason === "reclaimer_active") {
          return false;
        }
        throw error;
      }
      return false;
    }

    const reclaimer = await createOwner(this.options, this.options.clock());
    try {
      await writeJsonAtomically(join(this.reclaimPath, "owner.json"), reclaimer, {
        ensureParent: false,
      });

      const currentOwner = await readOwner(this.options.lockPath);
      if (currentOwner === undefined || currentOwner.token !== owner.token) {
        return false;
      }

      const currentLiveness = await ownerLiveness(currentOwner, this.options.hostname, this.options.platform);
      const currentAge = this.options.clock() - Date.parse(currentOwner.acquiredAt);
      if (currentLiveness !== "dead" || currentAge < this.options.staleAfterMs) {
        return false;
      }

      const finalOwner = await readOwner(this.options.lockPath);
      if (finalOwner === undefined || finalOwner.token !== owner.token) {
        return false;
      }
      const finalAge = this.options.clock() - Date.parse(finalOwner.acquiredAt);
      if (
        (await ownerLiveness(finalOwner, this.options.hostname, this.options.platform)) !== "dead" ||
        !Number.isFinite(finalAge) ||
        finalAge < this.options.staleAfterMs ||
        !(await this.reclaimMarkerExists())
      ) {
        return false;
      }

      // The marker blocks new creators for the entire interval between the
      // final owner-token check and removal. This is the TOCTOU boundary.
      await this.options.beforeReclaimRemove?.();

      try {
        await rm(this.options.lockPath, { recursive: true, force: false });
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw asLockError(
            error,
            "LOCK_IO_ERROR",
            "Cannot remove stale repository registry lock",
            this.options.lockPath,
          );
        }
        return false;
      }
      return true;
    } finally {
      if (markerCreated) {
        await rm(this.reclaimPath, { recursive: true, force: true });
      }
    }
  }

  private tryReclaimSync(owner: LockOwnerRecord): boolean {
    let markerCreated = false;
    try {
      fs.mkdirSync(this.reclaimPath, { mode: 0o700 });
      markerCreated = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) {
        throw asLockError(error, "LOCK_IO_ERROR", "Cannot coordinate stale lock recovery", this.options.lockPath);
      }
      try {
        this.handleExistingReclaimerSync();
      } catch (error) {
        if (error instanceof RegistryLockError && error.details.reason === "reclaimer_active") {
          return false;
        }
        throw error;
      }
      return false;
    }

    const reclaimer = createOwnerSync(this.options, this.options.clock());
    try {
      writeJsonAtomicallySync(join(this.reclaimPath, "owner.json"), reclaimer, { ensureParent: false });

      const currentOwner = readOwnerSync(this.options.lockPath);
      if (currentOwner === undefined || currentOwner.token !== owner.token) {
        return false;
      }
      const currentAge = this.options.clock() - Date.parse(currentOwner.acquiredAt);
      if (
        ownerLivenessSync(currentOwner, this.options.hostname, this.options.platform) !== "dead" ||
        currentAge < this.options.staleAfterMs
      ) {
        return false;
      }

      const finalOwner = readOwnerSync(this.options.lockPath);
      const finalAge = finalOwner === undefined ? Number.NaN : this.options.clock() - Date.parse(finalOwner.acquiredAt);
      if (
        finalOwner === undefined ||
        finalOwner.token !== owner.token ||
        ownerLivenessSync(finalOwner, this.options.hostname, this.options.platform) !== "dead" ||
        !Number.isFinite(finalAge) ||
        finalAge < this.options.staleAfterMs ||
        !this.reclaimMarkerExistsSync()
      ) {
        return false;
      }

      const hookResult = this.options.beforeReclaimRemove?.();
      if (hookResult !== undefined && typeof (hookResult as Promise<void>).then === "function") {
        throw new RegistryLockError(
          "LOCK_IO_ERROR",
          "Synchronous stale-lock reclaim hook returned a promise",
          this.options.lockPath,
        );
      }

      try {
        fs.rmSync(this.options.lockPath, { recursive: true, force: false });
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) {
          throw asLockError(
            error,
            "LOCK_IO_ERROR",
            "Cannot remove stale repository registry lock",
            this.options.lockPath,
          );
        }
        return false;
      }
      return true;
    } finally {
      if (markerCreated) {
        fs.rmSync(this.reclaimPath, { recursive: true, force: true });
      }
    }
  }

  private async handleExistingReclaimer(): Promise<void> {
    const reclaimer = await readOwner(this.reclaimPath);
    if (reclaimer === undefined) {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Stale lock recovery is already in progress with invalid metadata",
        this.options.lockPath,
        { reason: "reclaimer_invalid" },
      );
    }

    const age = this.options.clock() - Date.parse(reclaimer.acquiredAt);
    const liveness = await ownerLiveness(reclaimer, this.options.hostname, this.options.platform);
    if (liveness !== "dead" || age < this.options.staleAfterMs) {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Stale lock recovery is already in progress",
        this.options.lockPath,
        { reason: "reclaimer_active", reclaimer },
        reclaimer,
      );
    }

    try {
      await rm(this.reclaimPath, { recursive: true, force: false });
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw asLockError(error, "LOCK_IO_ERROR", "Cannot clear stale lock recovery marker", this.options.lockPath);
      }
    }
  }

  private handleExistingReclaimerSync(): void {
    const reclaimer = readOwnerSync(this.reclaimPath);
    if (reclaimer === undefined) {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Stale lock recovery is already in progress with invalid metadata",
        this.options.lockPath,
        { reason: "reclaimer_invalid" },
      );
    }

    const age = this.options.clock() - Date.parse(reclaimer.acquiredAt);
    const liveness = ownerLivenessSync(reclaimer, this.options.hostname, this.options.platform);
    if (liveness !== "dead" || age < this.options.staleAfterMs) {
      throw new RegistryLockError(
        "LOCK_STALE",
        "Stale lock recovery is already in progress",
        this.options.lockPath,
        { reason: "reclaimer_active", reclaimer },
        reclaimer,
      );
    }

    try {
      fs.rmSync(this.reclaimPath, { recursive: true, force: false });
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        throw asLockError(error, "LOCK_IO_ERROR", "Cannot clear stale lock recovery marker", this.options.lockPath);
      }
    }
  }

  private async removeCreatedLock(token: string): Promise<void> {
    const owner = await readOwner(this.options.lockPath);
    if (owner !== undefined && owner.token !== token) {
      return;
    }
    await rm(this.options.lockPath, { recursive: true, force: true });
  }

  private removeCreatedLockSync(token: string): void {
    const owner = readOwnerSync(this.options.lockPath);
    if (owner !== undefined && owner.token !== token) {
      return;
    }
    fs.rmSync(this.options.lockPath, { recursive: true, force: true });
  }

  private async release(owner: LockOwnerRecord): Promise<void> {
    const currentOwner = await readOwner(this.options.lockPath);
    if (currentOwner === undefined) {
      try {
        await stat(this.options.lockPath);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
          return;
        }
        throw new RegistryLockError(
          "LOCK_RELEASE_FAILED",
          "Cannot verify repository registry lock during release",
          this.options.lockPath,
          { cause: error instanceof Error ? error.message : String(error) },
          owner,
        );
      }
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Repository registry lock metadata disappeared during release",
        this.options.lockPath,
        {},
        owner,
      );
    }

    if (currentOwner.token !== owner.token) {
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Repository registry lock is owned by another token",
        this.options.lockPath,
        detailsForOwner(currentOwner),
        currentOwner,
      );
    }

    try {
      await rm(this.options.lockPath, { recursive: true, force: false });
    } catch (error) {
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Cannot release repository registry lock",
        this.options.lockPath,
        { cause: error instanceof Error ? error.message : String(error) },
        owner,
      );
    }
  }

  private releaseSync(owner: LockOwnerRecord): void {
    const currentOwner = readOwnerSync(this.options.lockPath);
    if (currentOwner === undefined) {
      try {
        fs.statSync(this.options.lockPath);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
          return;
        }
        throw new RegistryLockError(
          "LOCK_RELEASE_FAILED",
          "Cannot verify repository registry lock during release",
          this.options.lockPath,
          { cause: error instanceof Error ? error.message : String(error) },
          owner,
        );
      }
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Repository registry lock metadata disappeared during release",
        this.options.lockPath,
        {},
        owner,
      );
    }

    if (currentOwner.token !== owner.token) {
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Repository registry lock is owned by another token",
        this.options.lockPath,
        detailsForOwner(currentOwner),
        currentOwner,
      );
    }

    try {
      fs.rmSync(this.options.lockPath, { recursive: true, force: false });
    } catch (error) {
      throw new RegistryLockError(
        "LOCK_RELEASE_FAILED",
        "Cannot release repository registry lock",
        this.options.lockPath,
        { cause: error instanceof Error ? error.message : String(error) },
        owner,
      );
    }
  }

  private async reclaimMarkerExists(): Promise<boolean> {
    try {
      await stat(this.reclaimPath);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  private reclaimMarkerExistsSync(): boolean {
    try {
      fs.statSync(this.reclaimPath);
      return true;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }
}

function waitSync(milliseconds: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}
