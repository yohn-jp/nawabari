import type { SandboxPhysicalExecutionEvidence, SandboxRawOutput } from "../domain/sandbox-execution-evidence.js";
import { success, type DomainResult } from "../domain/errors.js";
import type { SandboxExecutionResult } from "../domain/sandbox-launcher.js";

const UNKNOWN_NAMESPACES = {
  pid: { state: "unknown", identity: null, distinct_from_caller: null },
  user: { state: "unknown", identity: null, distinct_from_caller: null },
  mount: { state: "unknown", identity: null, distinct_from_caller: null },
  ipc: { state: "unknown", identity: null, distinct_from_caller: null },
  uts: { state: "unknown", identity: null, distinct_from_caller: null },
} as const;

/** Add explicit non-physical evidence to a test-only fake launcher result. */
export function withSandboxExecutionEvidence<T extends Readonly<{ stdout: string; stderr: string }>>(
  result: T,
  executionId = "mock-execution",
): T &
  Readonly<{
    execution_id: string;
    raw_output: SandboxRawOutput;
    physical_execution: SandboxPhysicalExecutionEvidence;
  }> {
  const stdout = Buffer.from(result.stdout, "utf8");
  const stderr = Buffer.from(result.stderr, "utf8");
  return {
    ...result,
    execution_id: executionId,
    raw_output: {
      encoding: "base64",
      capture_mode: "pipes",
      stdout: stdout.toString("base64"),
      stderr: stderr.toString("base64"),
      stdout_bytes: stdout.byteLength,
      stderr_bytes: stderr.byteLength,
      observed_stdout_bytes: stdout.byteLength,
      observed_stderr_bytes: stderr.byteLength,
      complete: true,
      truncated: false,
    },
    physical_execution: {
      schema_version: 1,
      correlation_id: executionId,
      procfs: { mode: "private", reason: null },
      start: {
        state: "unknown",
        outer_pid: null,
        process_start_ticks: null,
        namespaces: UNKNOWN_NAMESPACES,
        observed_at: null,
      },
      termination: {
        state: "unknown",
        reason: "unknown",
        method: "unknown",
        observed_at: null,
      },
      cleanup: {
        state: "unknown",
        method: "unknown",
        observed_at: null,
        process_count: null,
      },
    },
  };
}

/** Build a typed fake runner result while leaving all physical claims unknown. */
export function sandboxExecutionMockSuccess<
  T extends Pick<SandboxExecutionResult, "exit_code" | "signal" | "stdout" | "stderr" | "duration_ms">,
>(result: T): DomainResult<SandboxExecutionResult> {
  return success(withSandboxExecutionEvidence(result));
}
