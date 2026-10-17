import type { ChildProcess } from "node:child_process";
import process from "node:process";
import type { Readable, Writable } from "node:stream";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  makeSandboxRawOutput,
  observeSandboxExecutionStart,
  observeSandboxExecutionTermination,
  parseBubblewrapInfo,
  type SandboxExecutionEvidenceSnapshot,
  type SandboxExecutionStartObservation,
  type SandboxExecutionTerminationReason,
  type SandboxPhysicalExecutionEvidence,
  type SandboxRawOutput,
} from "./sandbox-execution-evidence.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const START_OBSERVATION_TIMEOUT_MS = 10_000;

export type SandboxProcfsSelection = Readonly<{
  mode: "private" | "denied";
  reason: string | null;
}>;

export type ObservedSandboxProcessOptions = Readonly<{
  execution_id: string;
  procfs: SandboxProcfsSelection;
  interactive?: boolean;
  timeout_ms?: number;
  max_output_bytes?: number;
  signal?: AbortSignal;
  /** Forward parent SIGINT/SIGTERM when using inherited stdio. */
  forward_parent_signals?: boolean;
}>;

export type ObservedSandboxProcessResult = Readonly<{
  execution_id: string;
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  raw_output: SandboxRawOutput;
  physical_execution: SandboxPhysicalExecutionEvidence;
}>;

function boundedRawOutputChunk(
  chunks: Buffer[],
  bytesCaptured: number,
  maxBytes: number,
  value: Buffer | string,
): { readonly bytes_captured: number; readonly exceeded: boolean } {
  const encoded = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const remaining = Math.max(0, maxBytes - bytesCaptured);
  const retained = encoded.subarray(0, remaining);
  if (retained.byteLength > 0) chunks.push(Buffer.from(retained));
  return {
    bytes_captured: bytesCaptured + retained.byteLength,
    exceeded: retained.byteLength < encoded.byteLength,
  };
}

/**
 * Observe and release one already-spawned Bubblewrap process.
 *
 * The caller must pass a child launched with the compiled invocation's
 * seccomp descriptor at fd 3, Bubblewrap `--info-fd 4` connected to
 * `child.stdio[4]`, and `--block-fd 5` connected to `child.stdio[5]`. The
 * payload is not released unless the actual PID, user, mount, IPC, and UTS
 * namespace identities are observable and differ from the caller's.
 */
export function runObservedSandboxChild(
  child: ChildProcess,
  options: ObservedSandboxProcessOptions,
): Promise<DomainResult<ObservedSandboxProcessResult>> {
  const interactive = options.interactive === true;
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !options.execution_id ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    (options.procfs.mode === "private" && options.procfs.reason !== null) ||
    (options.procfs.mode === "denied" &&
      (typeof options.procfs.reason !== "string" || options.procfs.reason.length === 0))
  ) {
    return Promise.resolve(
      failure(new DomainError("INVALID_ARGUMENT", "The physical sandbox observation request is invalid.", {})),
    );
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedOutputBytes = 0;
    let observedStdoutBytes = 0;
    let observedStderrBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let outputExceeded = false;
    let spawnError: Error | null = null;
    let startFailure: string | null = null;
    let settled = false;
    let startObservation: SandboxExecutionStartObservation = observeSandboxExecutionStart(null);
    let terminationReason: SandboxExecutionTerminationReason = "unknown";
    let gateReleased = false;
    let infoDocument = "";
    let timer: NodeJS.Timeout | null = null;
    let startTimer: NodeJS.Timeout | null = null;
    const streams = child.stdio as Array<Readable | Writable | null>;
    const infoStream = streams[4] as Readable | null | undefined;
    const blockStream = streams[5] as Writable | null | undefined;

    const killChild = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may have exited between the state update and signal delivery.
      }
    };

    const failBeforeRelease = (reason: string): void => {
      if (gateReleased || startFailure !== null) return;
      startFailure = reason;
      if (startTimer !== null) clearTimeout(startTimer);
      killChild();
    };

    const releasePayload = (): void => {
      if (gateReleased || startFailure !== null || settled || timedOut || cancelled || outputExceeded) return;
      gateReleased = true;
      if (startTimer !== null) clearTimeout(startTimer);
      try {
        // Bubblewrap reads exactly one byte from --block-fd before execing.
        blockStream?.end(Buffer.from([1]));
      } catch (error: unknown) {
        gateReleased = false;
        failBeforeRelease(error instanceof Error ? error.message.slice(0, 200) : "block-fd write failed");
      }
    };

    const consumeInfo = (): void => {
      if (gateReleased || startFailure !== null || settled || timedOut || cancelled || outputExceeded) return;
      const outerPid = parseBubblewrapInfo(infoDocument);
      if (outerPid === null) {
        failBeforeRelease("Bubblewrap did not publish a valid --info-fd child PID.");
        return;
      }
      startObservation = observeSandboxExecutionStart(outerPid);
      if (startObservation.state !== "observed") {
        failBeforeRelease("The payload PID namespaces could not be observed as distinct before release.");
        return;
      }
      releasePayload();
    };

    const makeRawOutput = (): SandboxRawOutput =>
      makeSandboxRawOutput({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        observed_stdout_bytes: observedStdoutBytes,
        observed_stderr_bytes: observedStderrBytes,
        complete: !interactive && !timedOut && !cancelled && !outputExceeded,
        capture_mode: interactive ? "inherited" : "pipes",
      });

    const makePhysicalEvidence = async (): Promise<SandboxPhysicalExecutionEvidence> => {
      const observed = await observeSandboxExecutionTermination(startObservation, terminationReason);
      return {
        schema_version: 1,
        correlation_id: options.execution_id,
        procfs: { mode: options.procfs.mode, reason: options.procfs.reason },
        start: startObservation,
        termination: observed.termination,
        cleanup: observed.cleanup,
      };
    };

    const captureChunk = (stream: "stdout" | "stderr", value: Buffer | string): void => {
      if (interactive) return;
      const encoded = typeof value === "string" ? Buffer.from(value, "utf8") : value;
      if (stream === "stdout") observedStdoutBytes += encoded.byteLength;
      else observedStderrBytes += encoded.byteLength;
      const collected = boundedRawOutputChunk(
        stream === "stdout" ? stdout : stderr,
        capturedOutputBytes,
        maxOutputBytes,
        encoded,
      );
      capturedOutputBytes = collected.bytes_captured;
      if (collected.exceeded && !outputExceeded) {
        outputExceeded = true;
        terminationReason = "output-limit";
        killChild();
      }
    };

    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    if (interactive && options.forward_parent_signals === true) {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        const handler = (): void => {
          if (!settled) child.kill(signal);
        };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    const removeSignalHandlers = (): void => {
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      signalHandlers.clear();
    };

    const onAbort = (): void => {
      if (settled || cancelled || timedOut || outputExceeded) return;
      cancelled = true;
      terminationReason = "cancelled";
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    if (infoStream == null || blockStream == null) {
      failBeforeRelease("Bubblewrap did not provide the required --info-fd and --block-fd streams.");
    } else {
      infoStream.setEncoding("utf8");
      infoStream.on("data", (value: string | Buffer) => {
        infoDocument += typeof value === "string" ? value : value.toString("utf8");
        if (infoDocument.length > 4_096) {
          failBeforeRelease("Bubblewrap --info-fd output exceeded the bounded observation size.");
          return;
        }
        if (infoDocument.includes("\n}")) consumeInfo();
      });
      infoStream.on("end", () => {
        if (!gateReleased && startFailure === null && infoDocument.trim().length > 0) consumeInfo();
      });
      infoStream.on("error", (error: Error) => failBeforeRelease(error.message.slice(0, 200)));
      blockStream.on("error", (error: Error) => {
        if (gateReleased) {
          startFailure = error.message.slice(0, 200);
          killChild();
        } else {
          failBeforeRelease(error.message.slice(0, 200));
        }
      });
      startTimer = setTimeout(() => {
        failBeforeRelease("Bubblewrap did not publish an observable namespace before the deadline.");
      }, START_OBSERVATION_TIMEOUT_MS);
    }

    if (!interactive) {
      child.stdout?.on("data", (value: Buffer | string) => captureChunk("stdout", value));
      child.stderr?.on("data", (value: Buffer | string) => captureChunk("stderr", value));
    }
    child.once("error", (error: Error) => {
      spawnError = error;
    });

    child.once("close", (code, signal) => {
      void (async () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (startTimer !== null) clearTimeout(startTimer);
        removeSignalHandlers();
        options.signal?.removeEventListener("abort", onAbort);
        if (!gateReleased && startFailure === null && !timedOut && !cancelled && spawnError === null) {
          startFailure = "Bubblewrap exited before publishing an observable namespace for payload release.";
        }
        if (terminationReason === "unknown" && startFailure === null) terminationReason = "exited";

        const rawOutput = makeRawOutput();
        const physicalExecution = await makePhysicalEvidence();
        const snapshot: SandboxExecutionEvidenceSnapshot = {
          schema_version: 1,
          execution_id: options.execution_id,
          exit_code: code,
          signal,
          raw_output: rawOutput,
          physical_execution: physicalExecution,
        };
        const evidenceDetails: JsonObject = {
          execution_id: options.execution_id,
          execution_evidence: snapshot as unknown as JsonObject,
        };
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        const diagnostic = stderrText.slice(0, maxOutputBytes);
        const fail = (error: DomainError): void => {
          resolve(
            failure(
              new DomainError(error.code, error.message, {
                ...(error.details ?? {}),
                ...evidenceDetails,
              }),
            ),
          );
        };

        if (spawnError !== null) {
          fail(
            new DomainError("SANDBOX_EXECUTION_FAILED", "Bubblewrap failed before the command could run.", {
              reason: spawnError.message.slice(0, 200),
            }),
          );
          return;
        }
        if (timedOut) {
          fail(
            new DomainError("SANDBOX_EXECUTION_TIMEOUT", "The sandboxed command exceeded its execution timeout.", {
              timeout_ms: timeoutMs,
            }),
          );
          return;
        }
        if (outputExceeded) {
          fail(
            new DomainError("SANDBOX_OUTPUT_LIMIT", "The sandboxed command exceeded its output limit.", {
              max_output_bytes: maxOutputBytes,
            }),
          );
          return;
        }
        if (cancelled) {
          fail(
            new DomainError("SANDBOX_EXECUTION_FAILED", "The protected execution was cancelled by its owner.", {
              reason: "cancelled",
            }),
          );
          return;
        }
        if (code !== 0 && /^bwrap:/mu.test(diagnostic)) {
          const seccompFailure = /seccomp/u.test(diagnostic);
          fail(
            new DomainError(
              seccompFailure ? "SANDBOX_CAPABILITY_UNAVAILABLE" : "SANDBOX_EXECUTION_FAILED",
              seccompFailure
                ? "The required seccomp baseline could not be applied by bubblewrap."
                : "Bubblewrap could not establish the protected execution boundary.",
              { stderr: diagnostic },
            ),
          );
          return;
        }
        if (startFailure !== null) {
          fail(
            new DomainError(
              "SANDBOX_EXECUTION_FAILED",
              "Bubblewrap did not establish an observable protected execution before payload release.",
              { reason: startFailure },
            ),
          );
          return;
        }

        resolve(
          success({
            execution_id: options.execution_id,
            exit_code: code,
            signal,
            stdout: stdoutText,
            stderr: stderrText,
            duration_ms: Date.now() - started,
            raw_output: rawOutput,
            physical_execution: physicalExecution,
          }),
        );
      })();
    });

    if (!interactive) {
      timer = setTimeout(() => {
        timedOut = true;
        terminationReason = "timeout";
        killChild();
      }, timeoutMs);
    }
  });
}
