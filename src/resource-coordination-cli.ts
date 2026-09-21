import { DomainError, failure, type DomainResult, type JsonObject } from "./domain/errors.js";
import type { CoordinationPreviewOptions } from "./coordination-preview.js";
import type { HandoffResourcesOptions } from "./resource-handoff.js";
import {
  isResourceClaimMode,
  RESOURCE_CLAIM_SHARING_KIND,
  type ResourceClaimMode,
  type SharedWriteBinding,
} from "./resource-claims.js";

const PREVIEW_OPTIONS = new Set([
  "--left",
  "--right",
  "--path",
  "--patch",
  "--max-content-bytes",
  "--max-diff-bytes",
  "--max-diff-hunks",
  "--max-retries",
  "--allow-read-path",
]);
const HANDOFF_OPTIONS = new Set(["--from", "--to", "--resource", "--mode", "--if-generation", "--operation-id"]);

export type CoordinationPreviewArguments = CoordinationPreviewOptions;
export type ResourceHandoffArguments = HandoffResourcesOptions;

export function parseCoordinationPreviewArguments(argv: readonly string[]): DomainResult<CoordinationPreviewArguments> {
  let left: string | undefined;
  let right: string | undefined;
  let path: string | undefined;
  let includePatch = false;
  let maxContentBytes: number | undefined;
  let maxDiffBytes: number | undefined;
  let maxDiffHunks: number | undefined;
  let maxRetries: number | undefined;
  const allowedReadPaths: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--patch") {
      includePatch = true;
      continue;
    }
    const [name, inline] = splitOption(argument);
    if (!PREVIEW_OPTIONS.has(name)) return invalid(`Unknown option: ${name}.`, { option: name });
    const value = inline ?? argv[++index];
    if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("-"))) {
      return missing(`${name} requires a value.`, { option: name });
    }
    if (name === "--left") left = value;
    else if (name === "--right") right = value;
    else if (name === "--path") path = value;
    else if (name === "--allow-read-path") allowedReadPaths.push(value);
    else {
      const parsed = positiveInteger(name, value);
      if (!parsed.ok) return parsed;
      if (name === "--max-content-bytes") maxContentBytes = parsed.value;
      else if (name === "--max-diff-bytes") maxDiffBytes = parsed.value;
      else if (name === "--max-diff-hunks") maxDiffHunks = parsed.value;
      else maxRetries = parsed.value;
    }
  }
  if (left === undefined || right === undefined || path === undefined) {
    return missing("coordination preview requires --left, --right, and --path.", {
      options: ["--left", "--right", "--path"],
    });
  }
  if (includePatch && !allowedReadPaths.includes(path)) {
    return invalid("--patch requires explicit bounded read authority for --path.", {
      option: "--allow-read-path",
      path,
    });
  }
  return {
    ok: true,
    value: {
      left_session_id: left,
      right_session_id: right,
      path,
      include_patch: includePatch,
      ...(maxContentBytes === undefined ? {} : { max_content_bytes: maxContentBytes }),
      ...(maxDiffBytes === undefined ? {} : { max_diff_bytes: maxDiffBytes }),
      ...(maxDiffHunks === undefined ? {} : { max_diff_hunks: maxDiffHunks }),
      ...(maxRetries === undefined ? {} : { max_retries: maxRetries }),
      ...(allowedReadPaths.length === 0 ? {} : { allowed_read_paths: allowedReadPaths }),
    },
  };
}

export function parseResourceHandoffArguments(argv: readonly string[]): DomainResult<ResourceHandoffArguments> {
  let fromSessionId: string | undefined;
  let toSessionId: string | undefined;
  let resource: string | undefined;
  let mode: ResourceClaimMode | undefined;
  let ifGeneration: number | undefined;
  let operationId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    const [name, inline] = splitOption(argument);
    if (!HANDOFF_OPTIONS.has(name)) return invalid(`Unknown option: ${name}.`, { option: name });
    const value = inline ?? argv[++index];
    if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("-"))) {
      return missing(`${name} requires a value.`, { option: name });
    }
    if (name === "--from") fromSessionId = value;
    else if (name === "--to") toSessionId = value;
    else if (name === "--resource") resource = value;
    else if (name === "--mode") {
      if (!isResourceClaimMode(value))
        return invalid("--mode requires read, write, or exclusive-write.", { option: name, value });
      mode = value;
    } else if (name === "--operation-id") operationId = value;
    else {
      const parsed = nonNegativeInteger(name, value);
      if (!parsed.ok) return parsed;
      ifGeneration = parsed.value;
    }
  }
  if (
    fromSessionId === undefined ||
    toSessionId === undefined ||
    resource === undefined ||
    mode === undefined ||
    ifGeneration === undefined
  ) {
    return missing("session handoff requires --from, --to, --resource, --mode, and --if-generation.", {
      options: ["--from", "--to", "--resource", "--mode", "--if-generation"],
    });
  }
  return {
    ok: true,
    value: {
      from_session_id: fromSessionId,
      to_session_id: toSessionId,
      resource,
      mode,
      if_generation: ifGeneration,
      ...(operationId === undefined ? {} : { operation_id: operationId }),
    },
  };
}

export function parseCoordinatedSharingGroup(argv: readonly string[]): DomainResult<SharedWriteBinding | undefined> {
  let groupId: string | undefined;
  let mode: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = splitOption(argv[index] as string);
    if (name !== "--sharing-group" && name !== "--mode") return invalid(`Unknown option: ${name}.`, { option: name });
    const value = inline ?? argv[++index];
    if (value === undefined || value.length === 0 || (inline === undefined && value.startsWith("-"))) {
      return missing("--sharing-group requires a value.", { option: name });
    }
    if (name === "--mode") {
      if (mode !== undefined) return invalid("--mode may be supplied only once.", { option: name });
      mode = value;
    } else {
      if (groupId !== undefined) return invalid("--sharing-group may be supplied only once.", { option: name });
      groupId = value;
    }
  }
  if (groupId !== undefined && mode !== "write") {
    return invalid("--sharing-group is valid only with ordinary write.", {
      option: "--sharing-group",
      mode: mode ?? null,
    });
  }
  return { ok: true, value: groupId === undefined ? undefined : { kind: RESOURCE_CLAIM_SHARING_KIND, groupId } };
}

function splitOption(argument: string): [string, string | undefined] {
  const separator = argument.indexOf("=");
  return separator < 0 ? [argument, undefined] : [argument.slice(0, separator), argument.slice(separator + 1)];
}

function positiveInteger(option: string, value: string): DomainResult<number> {
  const parsed = nonNegativeInteger(option, value);
  if (!parsed.ok) return parsed;
  if (parsed.value < 1) return invalid(`${option} requires a positive integer.`, { option, value });
  return parsed;
}

function nonNegativeInteger(option: string, value: string): DomainResult<number> {
  if (!/^\d+$/u.test(value)) return invalid(`${option} requires a non-negative integer.`, { option, value });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return invalid(`${option} is outside the safe integer range.`, { option, value });
  return { ok: true, value: parsed };
}

function invalid(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function missing(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("MISSING_ARGUMENT", message, details));
}
