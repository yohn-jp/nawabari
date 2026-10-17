import fs from "node:fs";
import process from "node:process";

import { DomainError } from "./errors.js";

export type SandboxExecutionNamespace = "pid" | "user" | "mount" | "ipc" | "uts";

export type SandboxNamespaceObservation = Readonly<{
  state: "observed" | "unknown";
  identity: string | null;
  distinct_from_caller: boolean | null;
}>;

export type SandboxExecutionStartObservation = Readonly<{
  state: "observed" | "unknown";
  outer_pid: number | null;
  process_start_ticks: string | null;
  namespaces: Readonly<Record<SandboxExecutionNamespace, SandboxNamespaceObservation>>;
  observed_at: string | null;
}>;

export type SandboxExecutionTerminationReason = "exited" | "timeout" | "cancelled" | "output-limit" | "unknown";

export type SandboxPhysicalExecutionEvidence = Readonly<{
  schema_version: 1;
  correlation_id: string;
  procfs: Readonly<{ mode: "private" | "denied"; reason: string | null }>;
  start: SandboxExecutionStartObservation;
  termination: Readonly<{
    state: "observed-exited" | "observed-running" | "unknown";
    reason: SandboxExecutionTerminationReason;
    method: "procfs-process-observation" | "unknown";
    observed_at: string | null;
  }>;
  cleanup: Readonly<{
    state: "observed-empty" | "observed-populated" | "unknown";
    method: "pid-namespace-proc-scan" | "unknown";
    observed_at: string | null;
    process_count: number | null;
  }>;
}>;

export type SandboxRawOutput = Readonly<{
  encoding: "base64";
  capture_mode: "pipes" | "inherited";
  stdout: string;
  stderr: string;
  /** Captured byte counts, matching the decoded base64 stream lengths. */
  stdout_bytes: number;
  stderr_bytes: number;
  /** Bytes observed from the respective pipes, including bytes beyond the retained limit. */
  observed_stdout_bytes: number;
  observed_stderr_bytes: number;
  complete: boolean;
  truncated: boolean;
}>;

export type SandboxExecutionEvidenceSnapshot = Readonly<{
  schema_version: 1;
  execution_id: string;
  exit_code: number | null;
  signal: string | null;
  raw_output: SandboxRawOutput;
  physical_execution: SandboxPhysicalExecutionEvidence;
}>;

type ProcNamespace = Exclude<SandboxExecutionNamespace, "mount"> | "mnt";

const PROC_NAMESPACES: ReadonlyArray<readonly [SandboxExecutionNamespace, ProcNamespace]> = [
  ["pid", "pid"],
  ["user", "user"],
  ["mount", "mnt"],
  ["ipc", "ipc"],
  ["uts", "uts"],
];

const MAX_PROC_ENTRIES = 8_192;
const MAX_PROC_SCAN_MS = 500;
const MAX_CLEANUP_OBSERVATION_MS = 750;
const CLEANUP_RETRY_MS = 25;

function now(): string {
  return new Date().toISOString();
}

function unknownNamespace(): SandboxNamespaceObservation {
  return { state: "unknown", identity: null, distinct_from_caller: null };
}

function unknownStart(): SandboxExecutionStartObservation {
  return {
    state: "unknown",
    outer_pid: null,
    process_start_ticks: null,
    namespaces: {
      pid: unknownNamespace(),
      user: unknownNamespace(),
      mount: unknownNamespace(),
      ipc: unknownNamespace(),
      uts: unknownNamespace(),
    },
    observed_at: null,
  };
}

/** Parse Bubblewrap's --info-fd document without trusting extra fields. */
export function parseBubblewrapInfo(value: string): number | null {
  if (value.length > 4_096) return null;
  try {
    const document: unknown = JSON.parse(value.trim());
    if (typeof document !== "object" || document === null || Array.isArray(document)) return null;
    const pid = (document as Record<string, unknown>)["child-pid"];
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processStartTicks(pid: number, procRoot: string): string | null {
  try {
    const stat = fs.readFileSync(`${procRoot}/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return null;
    const fieldsAfterComm = stat
      .slice(close + 1)
      .trim()
      .split(/\s+/u);
    const ticks = fieldsAfterComm[19]; // field 22 (starttime), with field 3 at index 0.
    return ticks !== undefined && /^\d+$/u.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

function namespaceIdentity(pid: number, namespace: ProcNamespace, procRoot: string): string | null {
  try {
    const identity = fs.readlinkSync(`${procRoot}/${pid}/ns/${namespace}`);
    return /^[a-z]+:\[\d+\]$/u.test(identity) ? identity : null;
  } catch {
    return null;
  }
}

/**
 * Observe Bubblewrap's host-visible payload PID and its actual namespace links
 * before the launcher releases --block-fd. Missing or shared namespace links
 * remain unknown and must never be replaced with claims derived from argv.
 */
export function observeSandboxExecutionStart(
  outerPid: number | null,
  procRoot = "/proc",
  callerPid = process.pid,
): SandboxExecutionStartObservation {
  if (outerPid === null) return unknownStart();
  const processTicks = processStartTicks(outerPid, procRoot);
  const namespaces = {} as Record<SandboxExecutionNamespace, SandboxNamespaceObservation>;
  let complete = processTicks !== null;
  for (const [name, procName] of PROC_NAMESPACES) {
    const identity = namespaceIdentity(outerPid, procName, procRoot);
    const callerIdentity = namespaceIdentity(callerPid, procName, procRoot);
    const distinct = identity === null || callerIdentity === null ? null : identity !== callerIdentity;
    namespaces[name] = {
      state: identity === null ? "unknown" : "observed",
      identity,
      distinct_from_caller: distinct,
    };
    if (identity === null || callerIdentity === null || distinct !== true) complete = false;
  }
  return {
    state: complete ? "observed" : "unknown",
    outer_pid: outerPid,
    process_start_ticks: processTicks,
    namespaces,
    observed_at: now(),
  };
}

type ProcScan = Readonly<{
  state: "observed-empty" | "observed-populated" | "unknown";
  process_count: number | null;
}>;

function scanPidNamespace(namespace: string, procRoot: string): ProcScan {
  const started = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(procRoot);
  } catch {
    return { state: "unknown", process_count: null };
  }
  if (entries.length > MAX_PROC_ENTRIES) return { state: "unknown", process_count: null };

  let processCount = 0;
  let incomplete = false;
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    if (Date.now() - started > MAX_PROC_SCAN_MS) return { state: "unknown", process_count: processCount };
    try {
      if (fs.readlinkSync(`${procRoot}/${entry}/ns/pid`) === namespace) processCount += 1;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      // Entries can vanish while /proc is being enumerated; permission and
      // other read failures prevent a complete descendant observation.
      if (code !== "ENOENT" && code !== "ESRCH") incomplete = true;
    }
  }
  if (incomplete) return { state: "unknown", process_count: processCount };
  return { state: processCount === 0 ? "observed-empty" : "observed-populated", process_count: processCount };
}

function observeProcessTermination(
  start: SandboxExecutionStartObservation,
  procRoot: string,
): SandboxPhysicalExecutionEvidence["termination"] {
  if (start.outer_pid === null || start.process_start_ticks === null) {
    return { state: "unknown", reason: "unknown", method: "unknown", observed_at: null };
  }
  try {
    const stat = fs.readFileSync(`${procRoot}/${start.outer_pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fieldsAfterComm =
      close < 0
        ? []
        : stat
            .slice(close + 1)
            .trim()
            .split(/\s+/u);
    const ticks = fieldsAfterComm[19];
    if (ticks === undefined || !/^\d+$/u.test(ticks)) {
      return { state: "unknown", reason: "unknown", method: "unknown", observed_at: null };
    }
    // A zombie/dead task has exited even while its parent retains the PID.
    // Namespace cleanup remains independently measured, including that PID.
    if (ticks !== start.process_start_ticks || fieldsAfterComm[0] === "Z" || fieldsAfterComm[0] === "X") {
      return {
        state: "observed-exited",
        reason: "unknown",
        method: "procfs-process-observation",
        observed_at: now(),
      };
    }
    return {
      state: "observed-running",
      reason: "unknown",
      method: "procfs-process-observation",
      observed_at: now(),
    };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") {
      return {
        state: "observed-exited",
        reason: "unknown",
        method: "procfs-process-observation",
        observed_at: now(),
      };
    }
    return { state: "unknown", reason: "unknown", method: "unknown", observed_at: null };
  }
}

/**
 * Re-observe the owned payload and all visible processes in its captured PID
 * namespace after Bubblewrap exits. An incomplete /proc scan is explicitly
 * unknown; launcher exit alone is never treated as descendant cleanup.
 */
export async function observeSandboxExecutionTermination(
  start: SandboxExecutionStartObservation,
  reason: SandboxExecutionTerminationReason,
  options: Readonly<{ proc_root?: string; cleanup_timeout_ms?: number; retry_ms?: number }> = {},
): Promise<Pick<SandboxPhysicalExecutionEvidence, "termination" | "cleanup">> {
  const procRoot = options.proc_root ?? "/proc";
  const termination = observeProcessTermination(start, procRoot);
  const namespace = start.namespaces.pid.identity;
  if (start.state !== "observed" || namespace === null) {
    return {
      termination: { ...termination, reason },
      cleanup: { state: "unknown", method: "unknown", observed_at: null, process_count: null },
    };
  }

  const timeoutMs = options.cleanup_timeout_ms ?? MAX_CLEANUP_OBSERVATION_MS;
  const retryMs = options.retry_ms ?? CLEANUP_RETRY_MS;
  const deadline = Date.now() + timeoutMs;
  let last = scanPidNamespace(namespace, procRoot);
  while (last.state === "observed-populated" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryMs, Math.max(1, deadline - Date.now()))));
    last = scanPidNamespace(namespace, procRoot);
  }
  return {
    termination: { ...termination, reason },
    cleanup: {
      state: last.state,
      method: last.state === "unknown" ? "unknown" : "pid-namespace-proc-scan",
      observed_at: last.state === "unknown" ? null : now(),
      process_count: last.process_count,
    },
  };
}

export function makeSandboxRawOutput(
  input: Readonly<{
    stdout: Buffer;
    stderr: Buffer;
    observed_stdout_bytes: number;
    observed_stderr_bytes: number;
    complete: boolean;
    capture_mode: "pipes" | "inherited";
  }>,
): SandboxRawOutput {
  return {
    encoding: "base64",
    capture_mode: input.capture_mode,
    stdout: input.stdout.toString("base64"),
    stderr: input.stderr.toString("base64"),
    stdout_bytes: input.stdout.byteLength,
    stderr_bytes: input.stderr.byteLength,
    observed_stdout_bytes: input.observed_stdout_bytes,
    observed_stderr_bytes: input.observed_stderr_bytes,
    complete: input.complete,
    truncated: input.capture_mode === "pipes" && !input.complete,
  };
}

export function isSandboxExecutionEvidenceSnapshot(value: unknown): value is SandboxExecutionEvidenceSnapshot {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SandboxExecutionEvidenceSnapshot>;
  return (
    candidate.schema_version === 1 &&
    typeof candidate.execution_id === "string" &&
    (candidate.exit_code === null || typeof candidate.exit_code === "number") &&
    (candidate.signal === null || typeof candidate.signal === "string") &&
    typeof candidate.raw_output === "object" &&
    candidate.raw_output !== null &&
    typeof candidate.physical_execution === "object" &&
    candidate.physical_execution !== null
  );
}

/** Read a launcher-owned snapshot preserved in a DomainError's JSON details. */
export function sandboxExecutionEvidenceFromError(error: DomainError): SandboxExecutionEvidenceSnapshot | null {
  const candidate = error.details?.execution_evidence;
  return isSandboxExecutionEvidenceSnapshot(candidate) ? candidate : null;
}
