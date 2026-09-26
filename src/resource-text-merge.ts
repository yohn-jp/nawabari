import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MERGE_PREVIEW_OPERATION, MERGE_PREVIEW_SCHEMA_VERSION, type MergeBytes } from "./resource-merge-decision.js";

export const MERGE_PREVIEW_MAX_OUTPUT_BYTES = 64 * 1024;
export const MERGE_PREVIEW_TIMEOUT_MS = 10_000;
export const MERGE_PREVIEW_MARKER_SIZE = 7;

export type MergeExitInput =
  | number
  | null
  | {
      readonly status?: number | null;
      readonly signal?: string | null;
      readonly timedOut?: boolean;
      readonly outputTruncated?: boolean;
      readonly error?: string;
    };

export type MergeExitResult =
  | { readonly outcome: "clean"; readonly conflictCount: 0 }
  | { readonly outcome: "conflict"; readonly conflictCount: number }
  | {
      readonly outcome: "unknown";
      readonly conflictCount: null;
      readonly reason:
        "signal" | "timeout" | "output-limit" | "invalid-exit" | "process-failed" | "executable-unavailable";
    };

type MergeUnknownReason =
  "signal" | "timeout" | "output-limit" | "invalid-exit" | "process-failed" | "executable-unavailable";

export interface TextMergeInput {
  readonly base: MergeBytes;
  readonly left: MergeBytes;
  readonly right: MergeBytes;
  readonly markerSize?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  /** Optional factual evidence supplied by the caller before text merging. */
  readonly binary?: boolean;
  readonly submodule?: boolean;
  readonly mergeDriver?: string | null;
  readonly mergeBases?: number;
}

export interface ConflictRange {
  /** 1-based line numbers in the generated preview, including markers. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface TextMergeResult {
  readonly operation: typeof MERGE_PREVIEW_OPERATION;
  readonly schemaVersion: typeof MERGE_PREVIEW_SCHEMA_VERSION;
  readonly outcome: "clean" | "conflict" | "unknown";
  readonly conflictCount: number | null;
  readonly preview: string | null;
  readonly previewBytes: number;
  readonly conflictRanges: readonly ConflictRange[];
  readonly exitCode: number | null;
  readonly reason?: string;
}

/**
 * Convert Git's documented merge-file exit contract into an explicit
 * fail-closed result.  Only zero is clean; 1..127 are conflict counts.
 */
export function classifyMergeExit(exit: MergeExitInput): MergeExitResult {
  if (typeof exit === "number") {
    if (!Number.isInteger(exit) || exit < 0) return unknownExit("invalid-exit");
    if (exit === 0) return { outcome: "clean", conflictCount: 0 };
    if (exit <= 127) return { outcome: "conflict", conflictCount: exit };
    return unknownExit("process-failed");
  }
  if (exit === null) return unknownExit("signal");
  if (exit.outputTruncated === true) return unknownExit("output-limit");
  if (exit.timedOut === true) return unknownExit("timeout");
  if (exit.signal !== undefined && exit.signal !== null) return unknownExit("signal");
  if (exit.error === "executable-unavailable") return unknownExit("executable-unavailable");
  if (exit.status === undefined || exit.status === null) return unknownExit("process-failed");
  return classifyMergeExit(exit.status);
}

/**
 * Run Git's file-based merge preview in a private directory.  No repository
 * path, index, ref, object store, attributes, merge driver, or network is
 * made available to the subprocess.  The only files Git can observe are the
 * three fixed-byte regular files created for this invocation.
 */
export function analyzeTextMerge(input: TextMergeInput, gitExecutable: string): TextMergeResult {
  const validation = validateInput(input, gitExecutable);
  if (validation !== null) return unknownResult(validation, null, 0);

  const markerSize = input.markerSize ?? MERGE_PREVIEW_MARKER_SIZE;
  const maxOutputBytes = input.maxOutputBytes ?? MERGE_PREVIEW_MAX_OUTPUT_BYTES;
  const timeoutMs = input.timeoutMs ?? MERGE_PREVIEW_TIMEOUT_MS;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-merge-preview-"));
  try {
    const leftPath = path.join(temporaryRoot, "left");
    const basePath = path.join(temporaryRoot, "base");
    const rightPath = path.join(temporaryRoot, "right");
    writePrivateFile(leftPath, input.left);
    writePrivateFile(basePath, input.base);
    writePrivateFile(rightPath, input.right);

    const environment = isolatedEnvironment(temporaryRoot);
    const result = spawnSync(
      gitExecutable,
      [
        "merge-file",
        "-p",
        "--diff3",
        `--marker-size=${markerSize}`,
        "-L",
        "left",
        "-L",
        "base",
        "-L",
        "right",
        "--",
        leftPath,
        basePath,
        rightPath,
      ],
      {
        cwd: temporaryRoot,
        env: environment,
        encoding: "buffer",
        maxBuffer: maxOutputBytes,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      },
    );

    const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
    const outputTooLarge = stdout.byteLength > maxOutputBytes || hasOutputLimitError(result.error);
    const classification = classifyMergeExit({
      status: result.status,
      signal: result.signal,
      timedOut: errorCode(result.error) === "ETIMEDOUT",
      outputTruncated: outputTooLarge,
      error: errorCode(result.error) === "ENOENT" ? "executable-unavailable" : undefined,
    });
    if (classification.outcome === "unknown")
      return unknownResult(classification.reason, result.status, stdout.byteLength);

    const preview = decodeUtf8(stdout);
    if (preview === null) return unknownResult("process-failed", result.status, stdout.byteLength);
    const conflictRanges = classification.outcome === "conflict" ? findConflictRanges(preview) : [];
    return Object.freeze({
      operation: MERGE_PREVIEW_OPERATION,
      schemaVersion: MERGE_PREVIEW_SCHEMA_VERSION,
      outcome: classification.outcome,
      conflictCount: classification.conflictCount,
      preview,
      previewBytes: stdout.byteLength,
      conflictRanges: Object.freeze(conflictRanges),
      exitCode: result.status,
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function validateInput(input: TextMergeInput, gitExecutable: string): string | null {
  if (!isRecord(input)) return "observation-unavailable";
  if (!path.isAbsolute(gitExecutable)) return "executable-unavailable";
  if (
    !Number.isSafeInteger(input.markerSize ?? MERGE_PREVIEW_MARKER_SIZE) ||
    (input.markerSize ?? MERGE_PREVIEW_MARKER_SIZE) < 3
  ) {
    return "invalid-exit";
  }
  if (
    !Number.isSafeInteger(input.maxOutputBytes ?? MERGE_PREVIEW_MAX_OUTPUT_BYTES) ||
    (input.maxOutputBytes ?? MERGE_PREVIEW_MAX_OUTPUT_BYTES) < 1
  ) {
    return "output-limit";
  }
  if (
    !Number.isSafeInteger(input.timeoutMs ?? MERGE_PREVIEW_TIMEOUT_MS) ||
    (input.timeoutMs ?? MERGE_PREVIEW_TIMEOUT_MS) < 1
  ) {
    return "timeout";
  }
  if (input.binary === true) return "binary";
  if (input.submodule === true) return "submodule";
  if (input.mergeDriver !== undefined && input.mergeDriver !== null) return "merge-driver";
  if (input.mergeBases !== undefined && input.mergeBases !== 1) return "multiple-merge-bases";
  if (!isBytes(input.base) || !isBytes(input.left) || !isBytes(input.right)) return "observation-unavailable";
  if (containsNul(input.base) || containsNul(input.left) || containsNul(input.right)) return "binary";
  if (
    decodeUtf8(toBuffer(input.base)) === null ||
    decodeUtf8(toBuffer(input.left)) === null ||
    decodeUtf8(toBuffer(input.right)) === null
  ) {
    return "binary";
  }
  return null;
}

function writePrivateFile(filePath: string, content: MergeBytes): void {
  fs.writeFileSync(filePath, toBuffer(content), { mode: 0o600, flag: "wx" });
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const blockedExact = new Set([
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_OBJECT_DIRECTORY_RELATIVE",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_QUARANTINE_PATH",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_DIFF_PATH_COUNTER",
    "GIT_DIFF_PATH_TOTAL",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_MERGE_VERBOSITY",
    "GIT_ATTR_SOURCE",
    "GIT_INDEX_VERSION",
  ]);
  for (const key of Object.keys(environment)) {
    const upper = key.toUpperCase();
    if (blockedExact.has(upper) || upper.startsWith("GIT_CONFIG_")) delete environment[key];
  }
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function findConflictRanges(preview: string): readonly ConflictRange[] {
  const lines = preview.split("\n");
  const ranges: ConflictRange[] = [];
  let startLine: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (startLine === null && line.startsWith("<<<<<<<")) {
      startLine = index + 1;
    } else if (startLine !== null && line.startsWith(">>>>>>>")) {
      ranges.push(Object.freeze({ startLine, endLine: index + 1 }));
      startLine = null;
    }
  }
  if (startLine !== null) ranges.push(Object.freeze({ startLine, endLine: lines.length }));
  return ranges;
}

function unknownResult(reason: string, exitCode: number | null, previewBytes: number): TextMergeResult {
  return Object.freeze({
    operation: MERGE_PREVIEW_OPERATION,
    schemaVersion: MERGE_PREVIEW_SCHEMA_VERSION,
    outcome: "unknown",
    conflictCount: null,
    preview: null,
    previewBytes,
    conflictRanges: [],
    exitCode,
    reason,
  });
}

function unknownExit(reason: MergeUnknownReason): MergeExitResult {
  return { outcome: "unknown", conflictCount: null, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBytes(value: unknown): value is MergeBytes {
  return typeof value === "string" || value instanceof Uint8Array;
}

function toBuffer(value: MergeBytes): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function containsNul(value: MergeBytes): boolean {
  return toBuffer(value).includes(0);
}

function decodeUtf8(value: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

function hasOutputLimitError(error: Error | undefined): boolean {
  const code = errorCode(error);
  return code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || code === "E2BIG";
}

function errorCode(error: Error | undefined): string | undefined {
  return error !== undefined && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
