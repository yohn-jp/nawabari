import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DomainError } from "./domain/errors.js";
import { writeJsonAtomically } from "./registry/atomic.js";
import { readProcessStartTime, RegistryLockError, RepositoryLock, type LockLease } from "./registry/lock.js";
import type { LockOwnerRecord } from "./registry/types.js";

const CONTROL_SERVER_ENDPOINT_SCHEMA_VERSION = 1 as const;
const CONTROL_SERVER_ENDPOINT_FILE = "endpoint.json";
const CONTROL_SERVER_LEASE_DIRECTORY = "nawabari-control-server";
const MAX_ENDPOINT_BYTES = 4 * 1024;

export type ControlServerEndpointLocator = Readonly<{
  schema_version: typeof CONTROL_SERVER_ENDPOINT_SCHEMA_VERSION;
  host: "127.0.0.1";
  port: number;
  url: string;
  owner: Readonly<{
    generation: string;
    pid: number;
    hostname: string;
    process_start_time: string | null;
  }>;
}>;

export interface ControlServerLease {
  readonly directory: string;
  readonly endpointPath: string;
  publishEndpoint(port: number): Promise<void>;
  release(): Promise<void>;
}

export interface AcquireControlServerLeaseOptions {
  /** Internal test seam; production callers use the per-user default. */
  readonly directory?: string;
}

type EndpointRead =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "present"; readonly value: ControlServerEndpointLocator };

type OwnerLiveness = "alive" | "dead" | "unknown";

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function isPrivateDirectory(directory: string, uid: number | undefined): boolean {
  try {
    const stat = fs.lstatSync(directory);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      (uid === undefined || stat.uid === uid) &&
      (process.platform === "win32" || (stat.mode & 0o077) === 0)
    );
  } catch {
    return false;
  }
}

/** Stable per-user location; independent of the selected port, cwd, or repository. */
export function defaultControlServerOperationalDirectory(): string {
  const uid = currentUid();
  if (process.platform === "linux" && uid !== undefined) {
    const runtimeDirectory = `/run/user/${uid}`;
    if (isPrivateDirectory(runtimeDirectory, uid)) {
      return path.join(runtimeDirectory, CONTROL_SERVER_LEASE_DIRECTORY);
    }
  }

  const userScope =
    uid === undefined
      ? createHash("sha256").update(os.userInfo().username, "utf8").digest("hex").slice(0, 20)
      : String(uid);
  return path.join(os.tmpdir(), `${CONTROL_SERVER_LEASE_DIRECTORY}-${userScope}`);
}

export function controlServerEndpointPath(directory: string): string {
  return path.join(path.resolve(directory), CONTROL_SERVER_ENDPOINT_FILE);
}

function unavailable(message: string, reason: string, details: Record<string, string | number> = {}): DomainError {
  return new DomainError("BACKEND_UNAVAILABLE", message, { reason, ...details });
}

function rejected(message: string, reason: string, details: Record<string, string | number> = {}): DomainError {
  return new DomainError("OPERATION_REJECTED", message, { reason, ...details });
}

function ensureOperationalDirectory(directory: string): void {
  if (!path.isAbsolute(directory)) {
    throw unavailable("The Control Server operational directory must be absolute.", "invalid-operational-directory");
  }

  const uid = currentUid();
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    throw unavailable(
      "The Control Server operational directory could not be created.",
      "operational-directory-unavailable",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (!isPrivateDirectory(directory, uid)) {
    throw unavailable(
      "The Control Server operational directory is not a private directory owned by this user.",
      "untrusted-operational-directory",
    );
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseEndpoint(value: unknown): ControlServerEndpointLocator | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!exactKeys(candidate, ["schema_version", "host", "port", "url", "owner"])) return undefined;
  if (
    candidate.schema_version !== CONTROL_SERVER_ENDPOINT_SCHEMA_VERSION ||
    candidate.host !== "127.0.0.1" ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65_535 ||
    candidate.url !== `http://127.0.0.1:${candidate.port}/`
  ) {
    return undefined;
  }
  if (typeof candidate.owner !== "object" || candidate.owner === null || Array.isArray(candidate.owner)) {
    return undefined;
  }
  const owner = candidate.owner as Record<string, unknown>;
  if (
    !exactKeys(owner, ["generation", "pid", "hostname", "process_start_time"]) ||
    typeof owner.generation !== "string" ||
    owner.generation.length === 0 ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.hostname !== "string" ||
    owner.hostname.length === 0 ||
    (typeof owner.process_start_time !== "string" && owner.process_start_time !== null) ||
    (typeof owner.process_start_time === "string" && !/^\d+$/u.test(owner.process_start_time))
  ) {
    return undefined;
  }
  return {
    schema_version: CONTROL_SERVER_ENDPOINT_SCHEMA_VERSION,
    host: "127.0.0.1",
    port: candidate.port,
    url: candidate.url,
    owner: {
      generation: owner.generation,
      pid: owner.pid,
      hostname: owner.hostname,
      process_start_time: owner.process_start_time,
    },
  };
}

function readEndpoint(directory: string): EndpointRead {
  const endpointPath = controlServerEndpointPath(directory);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(endpointPath);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
  const uid = currentUid();
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_ENDPOINT_BYTES ||
    (uid !== undefined && stat.uid !== uid) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
  ) {
    return { kind: "invalid" };
  }
  try {
    const parsed = parseEndpoint(JSON.parse(fs.readFileSync(endpointPath, "utf8")) as unknown);
    return parsed === undefined ? { kind: "invalid" } : { kind: "present", value: parsed };
  } catch {
    return { kind: "invalid" };
  }
}

async function ownerLiveness(owner: ControlServerEndpointLocator["owner"]): Promise<OwnerLiveness> {
  if (
    process.platform !== "linux" ||
    owner.hostname !== os.hostname() ||
    owner.process_start_time === null ||
    !/^\d+$/u.test(owner.process_start_time)
  ) {
    return "unknown";
  }

  const currentStartTime = await readProcessStartTime(owner.pid);
  if (currentStartTime !== null) return currentStartTime === owner.process_start_time ? "alive" : "dead";
  try {
    process.kill(owner.pid, 0);
    return "unknown";
  } catch (error: unknown) {
    return error instanceof Error && "code" in error && error.code === "ESRCH" ? "dead" : "unknown";
  }
}

function removeEndpointIfGenerationMatches(directory: string, generation: string): void {
  const current = readEndpoint(directory);
  if (current.kind === "missing") return;
  if (current.kind !== "present" || current.value.owner.generation !== generation) {
    throw rejected("The Control Server endpoint locator belongs to an unknown generation.", "endpoint-owner-unknown");
  }
  fs.rmSync(controlServerEndpointPath(directory));
}

function registryLockFailure(error: RegistryLockError): DomainError {
  if (error.code === "LOCK_BUSY") {
    return rejected("A Control Server is already active for this user.", "server-already-running", {
      ...(error.owner === undefined ? {} : { owner_pid: error.owner.pid }),
    });
  }
  if (error.code === "LOCK_STALE") {
    return rejected(
      "The existing Control Server owner cannot be proven dead; its lease is retained.",
      "server-owner-unknown",
      {
        ...(error.owner === undefined ? {} : { owner_pid: error.owner.pid }),
      },
    );
  }
  return rejected("The Control Server lease is invalid and cannot be reclaimed safely.", "server-lease-invalid");
}

class ControlServerLeaseImpl implements ControlServerLease {
  private released = false;

  public constructor(
    public readonly directory: string,
    public readonly endpointPath: string,
    private readonly lockLease: LockLease,
  ) {}

  public async publishEndpoint(port: number): Promise<void> {
    if (this.released) throw rejected("The Control Server lease has already been released.", "lease-released");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new RangeError("Control Server endpoint port is invalid");
    }
    if (readEndpoint(this.directory).kind !== "missing") {
      throw rejected("The Control Server endpoint locator already exists.", "endpoint-locator-conflict");
    }
    const owner = this.lockLease.owner;
    const locator: ControlServerEndpointLocator = {
      schema_version: CONTROL_SERVER_ENDPOINT_SCHEMA_VERSION,
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}/`,
      owner: {
        generation: owner.token,
        pid: owner.pid,
        hostname: owner.hostname,
        process_start_time: owner.processStartTime,
      },
    };
    await writeJsonAtomically(this.endpointPath, locator, { ensureParent: false });
  }

  public async release(): Promise<void> {
    if (this.released) return;
    removeEndpointIfGenerationMatches(this.directory, this.lockLease.owner.token);
    await this.lockLease.release();
    this.released = true;
  }
}

export async function acquireControlServerLease(
  options: AcquireControlServerLeaseOptions = {},
): Promise<ControlServerLease> {
  const directory = path.resolve(options.directory ?? defaultControlServerOperationalDirectory());
  ensureOperationalDirectory(directory);
  const lock = new RepositoryLock({
    lockPath: path.join(directory, "server.lock"),
    staleAfterMs: 0,
    acquireTimeoutMs: 0,
  });

  let lockLease: LockLease;
  try {
    lockLease = await lock.acquire();
  } catch (error: unknown) {
    if (error instanceof RegistryLockError) throw registryLockFailure(error);
    throw unavailable("The Control Server singleton lease could not be acquired.", "lease-acquisition-failed", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const endpoint = readEndpoint(directory);
    if (endpoint.kind === "invalid") {
      throw rejected(
        "The existing Control Server endpoint locator is invalid; ownership cannot be established.",
        "endpoint-locator-invalid",
      );
    }
    if (endpoint.kind === "present") {
      const liveness = await ownerLiveness(endpoint.value.owner);
      if (liveness !== "dead") {
        throw rejected(
          "The existing Control Server endpoint owner is live or cannot be proven dead.",
          liveness === "alive" ? "server-already-running" : "server-owner-unknown",
          { owner_pid: endpoint.value.owner.pid, port: endpoint.value.port },
        );
      }
      removeEndpointIfGenerationMatches(directory, endpoint.value.owner.generation);
    }
    return new ControlServerLeaseImpl(directory, controlServerEndpointPath(directory), lockLease);
  } catch (error: unknown) {
    await lockLease.release();
    throw error;
  }
}
