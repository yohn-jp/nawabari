import fs from "node:fs";

import {
  FILE_OPERATION_STATE_UNCERTAIN,
  WORKTREE_FILE_OPERATION_CONTRACT_ID,
  WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES,
  WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
  WORKTREE_FILE_OPERATIONS,
  validateWorktreeFileOperation,
  type WorktreeFileIdentity,
  type WorktreeFileOperation,
  type WorktreeFileOperationClaim,
  type WorktreeFileOperationName,
  type WorktreeFileOperationPayload,
  type WorktreeFileOperationResult,
  type WorktreeFileOperationScope,
} from "./domain/worktree-file-operation.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./domain/errors.js";

/** Versioned public transport identity for the file-operation CLI adapter. */
export const WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION = 1 as const;
export const WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID = "nawabari.worktree-file-operation-cli.v1" as const;

export const WORKTREE_FILE_OPERATION_CLI_COMMANDS = Object.freeze([
  "session file create",
  "session file delete",
  "session file rename",
] as const);

/** Stable failures and operation evidence reachable through this surface. */
export const WORKTREE_FILE_OPERATION_CLI_ERROR_VOCABULARY = Object.freeze([
  "INVALID_ARGUMENT",
  "MISSING_ARGUMENT",
  "OPERATION_REJECTED",
  "SANDBOX_CAPABILITY_UNAVAILABLE",
  FILE_OPERATION_STATE_UNCERTAIN,
] as const);

const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SAFE_DIGEST = /^[0-9a-f]{64}$/iu;
const MAX_TEXT_LENGTH = 4_096;

export type WorktreeFileOperationCliInput = Readonly<{
  readonly contract_id: typeof WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION;
  readonly session_id: string;
  readonly operation_id: string;
  readonly operation: WorktreeFileOperationName;
  readonly path: string;
  readonly to_path?: string;
  /** null is the explicit absent expectation required for CREATE. */
  readonly expected_digest: string | null;
  readonly expected_identity?: WorktreeFileIdentity;
  readonly requested_generation: number;
  readonly payload_ref?: WorktreeFileOperationPayload;
}>;

export type WorktreeFileOperationCliAuthority = Readonly<{
  readonly worktree_root: string;
  readonly scope: WorktreeFileOperationScope;
  readonly claims: readonly WorktreeFileOperationClaim[];
}>;

export type WorktreeFileOperationCliOutcome = Readonly<{
  readonly contract_id: typeof WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION;
  readonly state: "applied" | "rejected" | "uncertain";
  readonly operation_id?: string;
  readonly operation?: WorktreeFileOperationName;
  readonly previous_generation?: number;
  readonly next_generation?: number;
  readonly identity?: WorktreeFileIdentity;
  readonly postcondition?: WorktreeFileOperationResult["postcondition"];
  readonly code?: string;
  readonly message?: string;
  readonly operation_code?: string;
  readonly details?: JsonObject;
}>;

export type WorktreeFileOperationCliSerialization = Readonly<{
  readonly cli: WorktreeFileOperationCliOutcome;
  readonly contract: Readonly<{
    readonly id: typeof WORKTREE_FILE_OPERATION_CONTRACT_ID;
    readonly schema_version: typeof WORKTREE_FILE_OPERATION_SCHEMA_VERSION;
    readonly cli_contract_id: typeof WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID;
    readonly cli_schema_version: typeof WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION;
  }>;
  readonly "error-vocabulary": readonly string[];
}>;

export type WorktreeFileOperationCliReadOptions = Readonly<{
  /** Test seam; production defaults to a bounded file read. */
  readonly read_file?: (file: string) => Uint8Array;
  /** Test seam; production defaults to a bounded fd 0 read. */
  readonly read_stdin?: () => Uint8Array;
}>;

function invalid(message: string, details: JsonObject | null = null): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function missing(option: string): DomainResult<never> {
  return failure(new DomainError("MISSING_ARGUMENT", `The file-operation CLI requires ${option}.`, { option }));
}

function boundedText(value: string, option: string): DomainResult<string> {
  if (value.length === 0 || value.length > MAX_TEXT_LENGTH || !SAFE_TEXT.test(value)) {
    return invalid(`The value for ${option} must be non-empty bounded text.`, { option });
  }
  return success(value.normalize("NFC"));
}

function exactPath(value: string, option: string): DomainResult<string> {
  const text = boundedText(value, option);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.includes("*") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return invalid(`The value for ${option} must be an exact repository-relative path.`, { option });
  }
  return success(normalized);
}

function operationValue(value: string): DomainResult<WorktreeFileOperationName> {
  if (!(WORKTREE_FILE_OPERATIONS as readonly string[]).includes(value)) {
    return invalid("The file operation must be CREATE, DELETE, or RENAME.", { operation: value });
  }
  return success(value as WorktreeFileOperationName);
}

function positiveInteger(value: string, option: string): DomainResult<number> {
  if (!/^[0-9]+$/u.test(value)) return invalid(`The value for ${option} must be a positive safe integer.`, { option });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return invalid(`The value for ${option} must be a positive safe integer.`, { option });
  }
  return success(parsed);
}

function parseExpectedDigest(value: string): DomainResult<string> {
  if (!SAFE_DIGEST.test(value))
    return invalid("--expected-digest must be a SHA-256 digest.", { option: "--expected-digest" });
  return success(value.toLowerCase());
}

function expectedIdentity(value: string): DomainResult<WorktreeFileIdentity> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return invalid("--expected-identity must contain one JSON identity object.", { option: "--expected-identity" });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("--expected-identity must contain one JSON identity object.", { option: "--expected-identity" });
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.dev !== "string" ||
    typeof record.ino !== "string" ||
    !/^[0-9]+$/u.test(record.dev) ||
    !/^[0-9]+$/u.test(record.ino) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0 ||
    typeof record.digest !== "string" ||
    !SAFE_DIGEST.test(record.digest)
  ) {
    return invalid("--expected-identity must contain dev, ino, size, and digest evidence.", {
      option: "--expected-identity",
    });
  }
  return success(
    Object.freeze({
      dev: record.dev,
      ino: record.ino,
      size: record.size as number,
      digest: (record.digest as string).toLowerCase(),
    }),
  );
}

function boundedInput(input: Uint8Array, source: string): DomainResult<WorktreeFileOperationPayload> {
  if (input.byteLength > WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES) {
    return invalid(`The ${source} payload exceeds the bounded file-operation limit.`, {
      option: source,
      limit: WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES,
    });
  }
  return success(
    Object.freeze({
      encoding: "base64",
      data: Buffer.from(input).toString("base64"),
    }),
  );
}

function readBoundedFile(file: string): Uint8Array {
  const descriptor = fs.openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES + 1));
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES) {
        return Buffer.alloc(WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES + 1);
      }
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
    return Buffer.concat(chunks, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readBoundedStdin(): Uint8Array {
  return readBoundedFile("/dev/stdin");
}

function optionValue(argv: readonly string[], index: number, option: string): DomainResult<string> {
  const candidate = argv[index + 1];
  if (candidate === undefined || candidate.startsWith("--")) return missing(option);
  return success(candidate);
}

function commandAndOperation(argv: readonly string[]): DomainResult<{
  readonly operation: WorktreeFileOperationName | null;
  readonly arguments: readonly string[];
}> {
  if (argv[0] === "session" || argv[0] === "file") {
    if (argv[0] !== "session" || argv[1] !== "file") return invalid("Expected the session file command.");
    const candidate = argv[2];
    if (candidate === undefined) return missing("one of session file create, delete, or rename");
    const parsed = operationValue(candidate.toUpperCase());
    if (!parsed.ok) return parsed;
    return success({ operation: parsed.value, arguments: argv.slice(3) });
  }
  return success({ operation: null, arguments: argv });
}

/** Parse one exact file-operation command without touching the worktree. */
export function parseWorktreeFileOperationCli(
  argv: readonly string[],
  options: WorktreeFileOperationCliReadOptions = {},
): DomainResult<WorktreeFileOperationCliInput> {
  const command = commandAndOperation(argv);
  if (!command.ok) return command;

  let operation: WorktreeFileOperationName | null = command.value.operation;
  let sessionId: string | null = null;
  let operationId: string | null = null;
  let targetPath: string | null = null;
  let destinationPath: string | null = null;
  let generation: number | null = null;
  let digest: string | null = null;
  let absent = false;
  let identity: WorktreeFileIdentity | undefined;
  let payloadFile: string | null = null;
  let payloadStdin = false;

  const args = command.value.arguments;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) return invalid("Positional arguments are not accepted by file operations.");
    if (argument === "--operation") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      const parsed = operationValue(value.value.toUpperCase());
      if (!parsed.ok) return parsed;
      if (operation !== null && operation !== parsed.value) {
        return invalid("The command operation and --operation disagree.", { option: "--operation" });
      }
      operation = parsed.value;
      index += 1;
    } else if (argument === "--session") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (sessionId !== null) return invalid("--session may be supplied only once.", { option: argument });
      sessionId = value.value;
      index += 1;
    } else if (argument === "--operation-id") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (operationId !== null) return invalid("--operation-id may be supplied only once.", { option: argument });
      operationId = value.value;
      index += 1;
    } else if (argument === "--path") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (targetPath !== null) return invalid("--path may be supplied only once.", { option: argument });
      targetPath = value.value;
      index += 1;
    } else if (argument === "--to-path") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (destinationPath !== null) return invalid("--to-path may be supplied only once.", { option: argument });
      destinationPath = value.value;
      index += 1;
    } else if (argument === "--if-generation") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (generation !== null) return invalid("--if-generation may be supplied only once.", { option: argument });
      const parsed = positiveInteger(value.value, argument);
      if (!parsed.ok) return parsed;
      generation = parsed.value;
      index += 1;
    } else if (argument === "--expected-digest") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (digest !== null || absent) return invalid("Expected target evidence may be supplied only once.");
      const parsed = parseExpectedDigest(value.value);
      if (!parsed.ok) return parsed;
      digest = parsed.value;
      index += 1;
    } else if (argument === "--expect-absent") {
      if (digest !== null || absent) return invalid("Expected target evidence may be supplied only once.");
      absent = true;
    } else if (argument === "--expected-identity") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (identity !== undefined)
        return invalid("--expected-identity may be supplied only once.", { option: argument });
      const parsed = expectedIdentity(value.value);
      if (!parsed.ok) return parsed;
      identity = parsed.value;
      index += 1;
    } else if (argument === "--payload-file") {
      const value = optionValue(args, index, argument);
      if (!value.ok) return value;
      if (payloadFile !== null || payloadStdin) return invalid("Payload input may be supplied only once.");
      payloadFile = value.value;
      index += 1;
    } else if (argument === "--payload-stdin") {
      if (payloadFile !== null || payloadStdin) return invalid("Payload input may be supplied only once.");
      payloadStdin = true;
    } else {
      return invalid(`Unknown file-operation option '${argument}'.`, { option: argument });
    }
  }

  if (operation === null) return missing("--operation");
  if (sessionId === null) return missing("--session <id>");
  if (operationId === null) return missing("--operation-id <id>");
  if (targetPath === null) return missing("--path <exact-path>");
  if (generation === null) return missing("--if-generation <generation>");

  const session = boundedText(sessionId, "--session");
  if (!session.ok) return session;
  const operationIdResult = boundedText(operationId, "--operation-id");
  if (!operationIdResult.ok) return operationIdResult;
  const pathResult = exactPath(targetPath, "--path");
  if (!pathResult.ok) return pathResult;
  const toPathResult = destinationPath === null ? null : exactPath(destinationPath, "--to-path");
  if (toPathResult !== null && !toPathResult.ok) return toPathResult;
  if (toPathResult !== null && toPathResult.value === pathResult.value) {
    return invalid("--to-path must differ from --path.", { option: "--to-path" });
  }

  const expectedDigest = digest ?? (absent ? null : undefined);
  if (operation === "CREATE") {
    if (expectedDigest !== null) return invalid("CREATE requires explicit --expect-absent target evidence.");
    if (destinationPath !== null || identity !== undefined) {
      return invalid("CREATE accepts neither --to-path nor --expected-identity.");
    }
    if (!payloadFile && !payloadStdin) return missing("--payload-file <path> or --payload-stdin");
  } else {
    if (expectedDigest === undefined) return missing("--expected-digest <sha256>");
    if (absent) return invalid("DELETE and RENAME require expected existing-target digest evidence.");
    if (payloadFile !== null || payloadStdin) return invalid("Payload input is valid only for CREATE.");
    if (operation === "RENAME" && destinationPath === null) return missing("--to-path <exact-path>");
    if (operation === "DELETE" && destinationPath !== null) return invalid("DELETE does not accept --to-path.");
  }

  let payload: WorktreeFileOperationPayload | undefined;
  if (operation === "CREATE") {
    const bytes =
      payloadFile !== null
        ? (() => {
            try {
              return success((options.read_file ?? readBoundedFile)(payloadFile));
            } catch {
              return invalid("The --payload-file input could not be read.", { option: "--payload-file" });
            }
          })()
        : (() => {
            try {
              return success((options.read_stdin ?? readBoundedStdin)());
            } catch {
              return invalid("The --payload-stdin input could not be read.", { option: "--payload-stdin" });
            }
          })();
    if (!bytes.ok) return bytes;
    const bounded = boundedInput(bytes.value, payloadFile === null ? "--payload-stdin" : "--payload-file");
    if (!bounded.ok) return bounded;
    payload = bounded.value;
  }

  return success(
    Object.freeze({
      contract_id: WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION,
      session_id: session.value,
      operation_id: operationIdResult.value,
      operation,
      path: pathResult.value,
      ...(toPathResult === null ? {} : { to_path: toPathResult.value }),
      expected_digest: expectedDigest as string | null,
      ...(identity === undefined ? {} : { expected_identity: identity }),
      requested_generation: generation,
      ...(payload === undefined ? {} : { payload_ref: payload }),
    }),
  );
}

/** Add only authority already selected by the session/registry owner. */
export function materializeWorktreeFileOperationCliRequest(
  input: WorktreeFileOperationCliInput,
  authority: WorktreeFileOperationCliAuthority,
): DomainResult<WorktreeFileOperation> {
  return validateWorktreeFileOperation({
    contract_id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
    schema_version: WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
    session_id: input.session_id,
    operation_id: input.operation_id,
    operation: input.operation,
    worktree_root: authority.worktree_root,
    path: input.path,
    ...(input.to_path === undefined ? {} : { to_path: input.to_path }),
    expected_digest: input.expected_digest,
    ...(input.expected_identity === undefined ? {} : { expected_identity: input.expected_identity }),
    requested_generation: input.requested_generation,
    scope: authority.scope,
    claims: authority.claims,
    ...(input.payload_ref === undefined ? {} : { payload_ref: input.payload_ref }),
  });
}

export type WorktreeFileOperationCliExecutor = (
  request: WorktreeFileOperation,
) => DomainResult<WorktreeFileOperationResult> | Promise<DomainResult<WorktreeFileOperationResult>>;

/** Parse, authority-bind, and execute one operation through an injected owner. */
export async function runWorktreeFileOperationCli(
  argv: readonly string[],
  authority: WorktreeFileOperationCliAuthority,
  execute: WorktreeFileOperationCliExecutor,
  options: WorktreeFileOperationCliReadOptions = {},
): Promise<DomainResult<WorktreeFileOperationCliOutcome>> {
  const parsed = parseWorktreeFileOperationCli(argv, options);
  if (!parsed.ok) return parsed;
  const request = materializeWorktreeFileOperationCliRequest(parsed.value, authority);
  if (!request.ok) return request;
  let result: DomainResult<WorktreeFileOperationResult>;
  try {
    result = await execute(request.value);
  } catch {
    return failure(new DomainError("OPERATION_REJECTED", "The file operation could not be completed."));
  }
  return success(projectWorktreeFileOperationCliOutcome(result, request.value.operation_id, request.value.operation));
}

function redactDetails(details: JsonObject): JsonObject {
  const redacted: JsonObject = {};
  const allowed = new Set(["operation_id", "operation_code", "state_uncertain"]);
  for (const [key, value] of Object.entries(details)) {
    if (!allowed.has(key)) continue;
    if (typeof value === "string" || typeof value === "boolean") redacted[key] = value;
  }
  return redacted;
}

function uncertainError(error: DomainError): boolean {
  const details = error.details;
  if (details === null) return false;
  return details.state_uncertain === true || details.operation_code === FILE_OPERATION_STATE_UNCERTAIN;
}

/** Project a domain result into the bounded public outcome without file data. */
export function projectWorktreeFileOperationCliOutcome(
  result: DomainResult<WorktreeFileOperationResult>,
  operationId?: string,
  operation?: WorktreeFileOperationName,
): WorktreeFileOperationCliOutcome {
  if (result.ok) {
    return Object.freeze({
      contract_id: WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION,
      state: "applied",
      operation_id: result.value.operation_id,
      operation: result.value.operation,
      previous_generation: result.value.previous_generation,
      next_generation: result.value.next_generation,
      identity: result.value.identity,
      postcondition: result.value.postcondition,
    });
  }
  const uncertain = uncertainError(result.error);
  const details = result.error.details === null ? undefined : redactDetails(result.error.details);
  const operationCode = details?.operation_code;
  return Object.freeze({
    contract_id: WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID,
    schema_version: WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION,
    state: uncertain ? "uncertain" : "rejected",
    ...(operationId === undefined ? {} : { operation_id: operationId }),
    ...(operation === undefined ? {} : { operation }),
    code: result.error.code,
    message: uncertain
      ? "The file operation state is uncertain; re-read operation evidence before retrying."
      : "The file operation was rejected.",
    ...(typeof operationCode === "string" ? { operation_code: operationCode } : {}),
    ...(details === undefined || Object.keys(details).length === 0 ? {} : { details }),
  });
}

export function serializeWorktreeFileOperationCliOutcome(
  outcome: WorktreeFileOperationCliOutcome,
): WorktreeFileOperationCliSerialization {
  return Object.freeze({
    cli: outcome,
    contract: Object.freeze({
      id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
      cli_contract_id: WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID,
      cli_schema_version: WORKTREE_FILE_OPERATION_CLI_SCHEMA_VERSION,
    }),
    "error-vocabulary": WORKTREE_FILE_OPERATION_CLI_ERROR_VOCABULARY,
  });
}
