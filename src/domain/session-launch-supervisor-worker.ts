import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

import {
  SESSION_ADMISSION_CONTRACT_ID,
  validateExecutionAdmissionReservation,
  type ExecutionAdmissionReservation,
} from "./session-admission-decision.js";
import {
  SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
  type SupervisorChildResult,
  type TrustedSandboxPayload,
} from "./session-launch-supervisor.js";
import {
  sandboxExecutionEvidenceFromError,
  type SandboxExecutionEvidenceSnapshot,
} from "./sandbox-execution-evidence.js";
import { runObservedSandboxChild, type ObservedSandboxProcessResult } from "./sandbox-physical-execution.js";

const MAX_PRIVATE_ENVELOPE_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TEXT_LENGTH = 4_096;

type WorkerGoMessage = {
  readonly type: "GO";
  readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
  readonly admission_contract_id: typeof SESSION_ADMISSION_CONTRACT_ID;
  readonly reservation: ExecutionAdmissionReservation;
  readonly payload: TrustedSandboxPayload;
};

export type TrustedSessionSupervisorWorkerOptions = {
  /** Test seam; production reads the inherited fd 4. */
  readonly control?: Readable;
  /** Test seam; production writes the inherited fd 5. */
  readonly result?: Writable;
  /** Test seam; production uses node:child_process.spawn. */
  readonly spawn_process?: typeof spawn;
  /** Test-only execution limit; production uses the launcher default. */
  readonly timeout_ms?: number;
  /** Test-only output limit; production uses the launcher default. */
  readonly max_output_bytes?: number;
  /** Test seam; production uses the shared namespace-gated physical observer. */
  readonly run_observed_child?: typeof runObservedSandboxChild;
  /** Inherited seccomp descriptor, fixed to fd 3 in the private protocol. */
  readonly seccomp_fd?: number;
};

type SandboxExecutionResult = ObservedSandboxProcessResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function isAbsolutePath(value: unknown): value is string {
  return isBoundedText(value) && value.startsWith("/");
}

function isSafeFd(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validatePayload(value: unknown, seccompFd: number): value is TrustedSandboxPayload {
  if (!isRecord(value)) return false;
  if (!isAbsolutePath(value.executable) || !isAbsolutePath(value.cwd)) return false;
  if (!Array.isArray(value.args) || value.args.some((entry) => !isBoundedText(entry))) return false;
  if (!Array.isArray(value.stdio) || value.stdio.length !== 4 || value.stdio[3] !== seccompFd) return false;
  if (value.seccomp_fd !== seccompFd || !isSafeFd(value.seccomp_fd)) return false;
  for (const entry of value.stdio.slice(0, 3)) {
    if (typeof entry === "number" && !isSafeFd(entry)) return false;
    if (typeof entry === "string" && entry !== "ignore" && entry !== "inherit" && entry !== "pipe") return false;
  }
  if (
    !isRecord(value.procfs) ||
    (value.procfs.mode !== "private" && value.procfs.mode !== "denied") ||
    (value.procfs.mode === "private" && value.procfs.reason !== null) ||
    (value.procfs.mode === "denied" &&
      (typeof value.procfs.reason !== "string" ||
        value.procfs.reason.length === 0 ||
        value.procfs.reason.includes("\0")))
  ) {
    return false;
  }
  if (
    (value.timeout_ms !== undefined &&
      (!Number.isSafeInteger(value.timeout_ms) ||
        (value.timeout_ms as number) < 1 ||
        (value.timeout_ms as number) > 15 * 60 * 1_000)) ||
    (value.max_output_bytes !== undefined &&
      (!Number.isSafeInteger(value.max_output_bytes) ||
        (value.max_output_bytes as number) < 1 ||
        (value.max_output_bytes as number) > DEFAULT_MAX_OUTPUT_BYTES))
  ) {
    return false;
  }
  if (!isRecord(value.env)) return false;
  for (const [key, entry] of Object.entries(value.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !isBoundedText(entry)) return false;
  }
  return true;
}

function parseGoMessage(raw: Buffer, seccompFd: number): WorkerGoMessage | null {
  if (raw.byteLength === 0 || raw.byteLength > MAX_PRIVATE_ENVELOPE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "GO" ||
    parsed.contract_id !== SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID ||
    parsed.admission_contract_id !== SESSION_ADMISSION_CONTRACT_ID
  ) {
    return null;
  }
  if (!isRecord(parsed.reservation)) return null;
  const reservation = validateExecutionAdmissionReservation(parsed.reservation as ExecutionAdmissionReservation);
  if (!reservation.ok || !validatePayload(parsed.payload, seccompFd)) return null;
  return {
    type: "GO",
    contract_id: SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
    admission_contract_id: SESSION_ADMISSION_CONTRACT_ID,
    reservation: reservation.value,
    payload: parsed.payload,
  };
}

async function readBoundedControl(control: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;
  for await (const value of control) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
    bytes += chunk.byteLength;
    if (bytes <= MAX_PRIVATE_ENVELOPE_BYTES) chunks.push(chunk);
    else oversized = true;
  }
  return oversized ? null : Buffer.concat(chunks);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : "unknown";
}

function runPayload(
  payload: TrustedSandboxPayload,
  executionId: string,
  options: TrustedSessionSupervisorWorkerOptions,
): Promise<SupervisorChildResult> {
  const interactive =
    payload.stdio[0] === "inherit" && payload.stdio[1] === "inherit" && payload.stdio[2] === "inherit";
  let child: ChildProcess;
  try {
    child = (options.spawn_process ?? spawn)(payload.executable, [...payload.args], {
      cwd: payload.cwd,
      env: { ...payload.env },
      shell: false,
      stdio: [payload.stdio[0], payload.stdio[1], payload.stdio[2], payload.seccomp_fd, "pipe", "pipe"],
    });
  } catch (error: unknown) {
    return Promise.resolve({ status: "failed", error: errorText(error) });
  }
  return (options.run_observed_child ?? runObservedSandboxChild)(child, {
    execution_id: executionId,
    procfs: payload.procfs,
    interactive,
    timeout_ms: payload.timeout_ms ?? options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    max_output_bytes: payload.max_output_bytes ?? options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    forward_parent_signals: interactive,
  }).then((observed) => {
    if (!observed.ok) {
      const evidence: SandboxExecutionEvidenceSnapshot | null = sandboxExecutionEvidenceFromError(observed.error);
      return {
        status: "failed",
        error: errorText(observed.error),
        ...(evidence === null ? {} : { result: evidence }),
      };
    }
    const result: SandboxExecutionResult = observed.value;
    return { status: "completed", result };
  });
}

async function writeResult(result: Writable, value: SupervisorChildResult): Promise<boolean> {
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return false;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PRIVATE_ENVELOPE_BYTES) return false;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      result.removeListener("error", onError);
      resolve(ok);
    };
    const onError = (): void => finish(false);
    result.once("error", onError);
    result.end(`${raw}\n`, () => finish(true));
  });
}

/** Execute the package-owned one-shot worker protocol on inherited fd 4/5. */
export async function runTrustedSessionSupervisorWorker(
  options: TrustedSessionSupervisorWorkerOptions = {},
): Promise<SupervisorChildResult> {
  const seccompFd = options.seccomp_fd ?? 3;
  const control = options.control ?? fs.createReadStream(null as unknown as string, { fd: 4, autoClose: false });
  const result = options.result ?? fs.createWriteStream(null as unknown as string, { fd: 5, autoClose: false });
  const raw = await readBoundedControl(control);
  if (raw === null) return { status: "unknown" };
  const message = parseGoMessage(raw, seccompFd);
  if (message === null) return { status: "unknown" };
  const outcome = await runPayload(message.payload, message.reservation.execution_id, options);
  if (!(await writeResult(result, outcome))) return { status: "unknown" };
  return outcome;
}

const workerEntrypoint = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === workerEntrypoint) {
  void runTrustedSessionSupervisorWorker().then((result) => {
    process.exitCode = result.status === "unknown" ? 1 : 0;
  });
}
