import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  pinWorktreeProfile,
  parsePinnedProfileRecord,
  type PinnedWorktreeProfile,
} from "./worktree-profile-pinning.js";
import { substituteProfileParameters, type WorktreeProfileParameterValues } from "./worktree-profile-catalog.js";
import { validateRuntimePolicy, type RuntimePolicy } from "./runtime-projection.js";
import type { RuntimeProfileRequirement } from "./runtime-profile.js";
import {
  WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY,
  validateWorktreeRuntimeProfile,
  type ResolvedWorktreeRuntimeProfile,
  type WorktreeRuntimeProcessTrackingMode,
} from "./worktree-runtime-profile.js";

/** The override document uses the same governed serialization key as a profile. */
export const WORKTREE_PROFILE_OVERRIDE_SERIALIZATION_KEY = WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY;
export const WORKTREE_PROFILE_OVERRIDE_SCHEMA_VERSION = 1 as const;
export const WORKTREE_PROFILE_OVERRIDE_PROVENANCE_KEY = "worktree-profile.override" as const;

type RecordValue = Record<string, unknown>;
type FilesystemOperation = "readOnly" | "write" | "create" | "delete";
type RestrictableFilesystemOperation = FilesystemOperation | "deny" | "immutable";
const FILESYSTEM_OPERATIONS = ["readOnly", "write", "create", "delete", "deny", "immutable"] as const;
const ALLOW_OPERATIONS = ["readOnly", "write", "create", "delete"] as const;
const MAX_ITEMS = 2_048;
const MAX_TEXT_LENGTH = 1_024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;
const SELECTOR = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_.*?/@+:-]+$/u;
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Only these profile sections can be changed by an override. */
export type WorktreeProfileOverrideRestrictions = Readonly<{
  readonly filesystem?: Readonly<Partial<Record<RestrictableFilesystemOperation, readonly string[]>>>;
  readonly execution?: Readonly<{
    readonly policy?: RuntimePolicy;
    readonly processTracking?: WorktreeRuntimeProcessTrackingMode;
  }>;
  readonly environment?: Readonly<{
    readonly xdg?: Readonly<{ readonly cache?: "session" }>;
  }>;
  readonly git?: Readonly<{ readonly hooks?: "disabled" }>;
}>;

/**
 * A bounded session-create override.  It is deliberately not a generic patch:
 * parameters are validated by the existing catalog authority, tools can only
 * be removed, restrictions can only become tighter, and material requirements
 * can only be explicitly added.
 */
export type WorktreeProfileOverride = Readonly<{
  readonly parameters?: WorktreeProfileParameterValues;
  readonly removeTools?: readonly string[];
  readonly restrictions?: WorktreeProfileOverrideRestrictions;
  readonly baselineRequirements?: readonly RuntimeProfileRequirement[];
}>;

/**
 * External authority is a narrowing boundary for additions.  It never grants
 * a capability absent from the pinned profile and is not consulted to remove
 * DENY or immutable selectors.
 */
export type WorktreeProfileOverrideAuthorization = Readonly<{
  readonly externalScope?: Readonly<{
    readonly filesystem?: Readonly<Partial<Record<RestrictableFilesystemOperation, readonly string[]>>>;
    readonly baselineRequirements?: readonly string[];
  }>;
}>;

export type WorktreeProfileOverrideResult = PinnedWorktreeProfile;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(field: string, reason: string, details: JsonObject = {}): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_INVALID", `Worktree profile override field '${field}' is invalid: ${reason}.`, {
      field,
      ...details,
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROFILE_AMBIGUOUS",
      `Worktree profile override field '${field}' is ambiguous: ${reason}.`,
      {
        field,
        ...(value === undefined ? {} : { value }),
      },
    ),
  );
}

function assertKeys(value: RecordValue, allowed: readonly string[], field: string): DomainResult<null> {
  const supported = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) return invalid(`${field}.${key}`, "unknown fields are not supported");
  }
  return success(null);
}

function boundedText(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH || !SAFE_TEXT.test(value)) {
    return invalid(field, "expected bounded non-empty text");
  }
  return success(value.normalize("NFC"));
}

function identifier(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !STABLE_IDENTIFIER.test(value)) {
    return invalid(field, "expected a stable identifier");
  }
  return success(value);
}

function selector(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field);
  if (!text.ok) return text;
  if (
    !SELECTOR.test(text.value) ||
    text.value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return invalid(field, "expected a canonical repository-relative selector");
  }
  return text;
}

function selectors(value: unknown, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return invalid(field, "expected a bounded selector array");
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = selector(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    if (result.includes(parsed.value)) return ambiguous(field, "duplicate selector", parsed.value);
    result.push(parsed.value);
  }
  return success(Object.freeze(result.sort(compareText)));
}

function identifierList(value: unknown, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return invalid(field, "expected a bounded identifier array");
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = identifier(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    if (result.includes(parsed.value)) return ambiguous(field, "duplicate identifier", parsed.value);
    result.push(parsed.value);
  }
  return success(Object.freeze(result.sort(compareText)));
}

function toolList(value: unknown, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return invalid(field, "expected a bounded tool array");
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !ENTRYPOINT.test(item))
      return invalid(`${field}[${index}]`, "expected an entrypoint");
    if (result.includes(item)) return ambiguous(field, "duplicate entrypoint", item);
    result.push(item);
  }
  return success(Object.freeze(result.sort(compareText)));
}

function jsonValue(value: unknown, field: string, depth = 0): DomainResult<unknown> {
  if (depth > 16) return invalid(field, "nested values exceed the maximum depth");
  if (value === null || typeof value === "string" || typeof value === "boolean") return success(value);
  if (typeof value === "number" && Number.isFinite(value)) return success(value);
  if (Array.isArray(value)) {
    const values: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const parsed = jsonValue(item, `${field}[${index}]`, depth + 1);
      if (!parsed.ok) return parsed;
      values.push(parsed.value);
    }
    return success(Object.freeze(values));
  }
  if (!isRecord(value)) return invalid(field, "expected a JSON value");
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareText)) {
    if (PROTOTYPE_KEYS.has(key)) return invalid(`${field}.${key}`, "prototype-pollution keys are not supported");
    const parsedKey = boundedText(key, `${field}.<key>`);
    if (!parsedKey.ok) return parsedKey;
    const parsed = jsonValue(value[key], `${field}.${key}`, depth + 1);
    if (!parsed.ok) return parsed;
    output[key] = parsed.value;
  }
  return success(Object.freeze(output));
}

function requirement(value: unknown, field: string): DomainResult<RuntimeProfileRequirement> {
  if (!isRecord(value)) return invalid(field, "expected a material requirement object");
  const keys = assertKeys(value, ["id", "kind", "name", "version"], field);
  if (!keys.ok) return keys;
  const id = identifier(value.id, `${field}.id`);
  if (!id.ok) return id;
  if (value.kind !== "runtime" && value.kind !== "package")
    return invalid(`${field}.kind`, "expected runtime or package");
  const name = boundedText(value.name, `${field}.name`);
  if (!name.ok) return name;
  const version = boundedText(value.version, `${field}.version`);
  if (!version.ok) return version;
  if (
    [name.value, version.value].some((item) => item.startsWith("/") || item.startsWith("~") || item.startsWith("$"))
  ) {
    return invalid(field, "host paths and environment expressions are not logical requirements");
  }
  return success(Object.freeze({ id: id.value, kind: value.kind, name: name.value, version: version.value }));
}

function filesystemOverride(
  value: unknown,
  field: string,
): DomainResult<WorktreeProfileOverrideRestrictions["filesystem"]> {
  if (!isRecord(value)) return invalid(field, "expected an object");
  const keys = assertKeys(value, FILESYSTEM_OPERATIONS, field);
  if (!keys.ok) return keys;
  const output: Record<string, readonly string[]> = {};
  for (const operation of FILESYSTEM_OPERATIONS) {
    if (!(operation in value)) continue;
    const parsed = selectors(value[operation], `${field}.${operation}`);
    if (!parsed.ok) return parsed;
    output[operation] = parsed.value;
  }
  return success(Object.freeze(output as WorktreeProfileOverrideRestrictions["filesystem"]));
}

function restrictions(value: unknown): DomainResult<WorktreeProfileOverrideRestrictions> {
  if (!isRecord(value)) return invalid("restrictions", "expected an object");
  const keys = assertKeys(value, ["filesystem", "execution", "environment", "git"], "restrictions");
  if (!keys.ok) return keys;
  const output: Record<string, unknown> = {};
  if ("filesystem" in value) {
    const parsed = filesystemOverride(value.filesystem, "restrictions.filesystem");
    if (!parsed.ok) return parsed;
    output.filesystem = parsed.value;
  }
  if ("execution" in value) {
    if (!isRecord(value.execution)) return invalid("restrictions.execution", "expected an object");
    const executionKeys = assertKeys(value.execution, ["policy", "processTracking"], "restrictions.execution");
    if (!executionKeys.ok) return executionKeys;
    const execution: Record<string, unknown> = {};
    if ("policy" in value.execution) {
      const policy = validateRuntimePolicy(value.execution.policy);
      if (!policy.ok) return failure(policy.error);
      execution.policy = policy.value;
    }
    if ("processTracking" in value.execution) {
      if (value.execution.processTracking !== "required" && value.execution.processTracking !== "optional") {
        return invalid("restrictions.execution.processTracking", "expected required or optional");
      }
      execution.processTracking = value.execution.processTracking;
    }
    output.execution = Object.freeze(execution);
  }
  if ("environment" in value) {
    if (!isRecord(value.environment)) return invalid("restrictions.environment", "expected an object");
    const environmentKeys = assertKeys(value.environment, ["xdg"], "restrictions.environment");
    if (!environmentKeys.ok) return environmentKeys;
    const environment: Record<string, unknown> = {};
    if ("xdg" in value.environment) {
      if (!isRecord(value.environment.xdg)) return invalid("restrictions.environment.xdg", "expected an object");
      const xdgKeys = assertKeys(value.environment.xdg, ["cache"], "restrictions.environment.xdg");
      if (!xdgKeys.ok) return xdgKeys;
      if ("cache" in value.environment.xdg && value.environment.xdg.cache !== "session") {
        return invalid("restrictions.environment.xdg.cache", "only session is a stricter cache scope");
      }
      environment.xdg = Object.freeze({ ...("cache" in value.environment.xdg ? { cache: "session" } : {}) });
    }
    output.environment = Object.freeze(environment);
  }
  if ("git" in value) {
    if (!isRecord(value.git)) return invalid("restrictions.git", "expected an object");
    const gitKeys = assertKeys(value.git, ["hooks"], "restrictions.git");
    if (!gitKeys.ok) return gitKeys;
    if ("hooks" in value.git && value.git.hooks !== "disabled") {
      return invalid("restrictions.git.hooks", "only disabled is a stricter hook policy");
    }
    output.git = Object.freeze({ ...("hooks" in value.git ? { hooks: "disabled" } : {}) });
  }
  return success(Object.freeze(output as WorktreeProfileOverrideRestrictions));
}

/** Validate and canonicalize an override without consulting host state. */
export function validateWorktreeProfileOverride(input: unknown): DomainResult<WorktreeProfileOverride> {
  const serialized = isRecord(input) && isRecord(input[WORKTREE_PROFILE_OVERRIDE_SERIALIZATION_KEY]);
  const value = serialized ? input[WORKTREE_PROFILE_OVERRIDE_SERIALIZATION_KEY] : input;
  if (!isRecord(value)) return invalid("override", "expected an object");
  if (serialized && value.schema_version !== WORKTREE_PROFILE_OVERRIDE_SCHEMA_VERSION) {
    return invalid("override.schema_version", "does not match the canonical override schema");
  }
  const normalized = serialized
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "schema_version"))
    : value;
  const keys = assertKeys(
    normalized,
    ["parameters", "removeTools", "restrictions", "baselineRequirements"],
    "override",
  );
  if (!keys.ok) return keys;
  const output: Record<string, unknown> = {};
  if ("parameters" in normalized) {
    if (!isRecord(normalized.parameters)) return invalid("override.parameters", "expected a parameter object");
    const parameters: Record<string, unknown> = {};
    for (const key of Object.keys(normalized.parameters).sort(compareText)) {
      if (PROTOTYPE_KEYS.has(key))
        return invalid(`override.parameters.${key}`, "prototype-pollution keys are not supported");
      const parsed = jsonValue(normalized.parameters[key], `override.parameters.${key}`);
      if (!parsed.ok) return parsed;
      parameters[key] = parsed.value;
    }
    if (Object.keys(parameters).length > 0)
      output.parameters = Object.freeze(parameters) as WorktreeProfileParameterValues;
  }
  if ("removeTools" in normalized) {
    const parsed = toolList(normalized.removeTools, "override.removeTools");
    if (!parsed.ok) return parsed;
    if (parsed.value.length > 0) output.removeTools = parsed.value;
  }
  if ("restrictions" in normalized) {
    const parsed = restrictions(normalized.restrictions);
    if (!parsed.ok) return parsed;
    if (Object.keys(parsed.value).length > 0) output.restrictions = parsed.value;
  }
  if ("baselineRequirements" in normalized) {
    if (!Array.isArray(normalized.baselineRequirements) || normalized.baselineRequirements.length > MAX_ITEMS) {
      return invalid("override.baselineRequirements", "expected a bounded requirement array");
    }
    const requirements: RuntimeProfileRequirement[] = [];
    const ids = new Set<string>();
    for (const [index, item] of normalized.baselineRequirements.entries()) {
      const parsed = requirement(item, `override.baselineRequirements[${index}]`);
      if (!parsed.ok) return parsed;
      if (ids.has(parsed.value.id))
        return ambiguous("override.baselineRequirements", "duplicate requirement", parsed.value.id);
      ids.add(parsed.value.id);
      requirements.push(parsed.value);
    }
    requirements.sort((left, right) => compareText(left.id, right.id));
    if (requirements.length > 0) output.baselineRequirements = Object.freeze(requirements);
  }
  return success(Object.freeze(output as WorktreeProfileOverride));
}

function authorizationFilesystem(
  value: unknown,
  field: string,
): DomainResult<Readonly<Partial<Record<RestrictableFilesystemOperation, readonly string[]>>>> {
  if (!isRecord(value)) return invalid(field, "expected an object");
  const keys = assertKeys(value, FILESYSTEM_OPERATIONS, field);
  if (!keys.ok) return keys;
  const output: Record<string, readonly string[]> = {};
  for (const operation of FILESYSTEM_OPERATIONS) {
    if (!(operation in value)) continue;
    const parsed = selectors(value[operation], `${field}.${operation}`);
    if (!parsed.ok) return parsed;
    output[operation] = parsed.value;
  }
  return success(Object.freeze(output));
}

/** Validate the external scope consumed by the override boundary. */
export function validateWorktreeProfileOverrideAuthorization(
  input: unknown,
): DomainResult<WorktreeProfileOverrideAuthorization> {
  if (!isRecord(input)) return invalid("authorization", "an explicit authorization object is required");
  const keys = assertKeys(input, ["externalScope"], "authorization");
  if (!keys.ok) return keys;
  const output: Record<string, unknown> = {};
  if ("externalScope" in input) {
    if (!isRecord(input.externalScope)) return invalid("authorization.externalScope", "expected an object");
    const scopeKeys = assertKeys(
      input.externalScope,
      ["filesystem", "baselineRequirements"],
      "authorization.externalScope",
    );
    if (!scopeKeys.ok) return scopeKeys;
    const scope: Record<string, unknown> = {};
    if ("filesystem" in input.externalScope) {
      const parsed = authorizationFilesystem(input.externalScope.filesystem, "authorization.externalScope.filesystem");
      if (!parsed.ok) return parsed;
      scope.filesystem = parsed.value;
    }
    if ("baselineRequirements" in input.externalScope) {
      const parsed = identifierList(
        input.externalScope.baselineRequirements,
        "authorization.externalScope.baselineRequirements",
      );
      if (!parsed.ok) return parsed;
      scope.baselineRequirements = parsed.value;
    }
    output.externalScope = Object.freeze(scope);
  }
  return success(Object.freeze(output as WorktreeProfileOverrideAuthorization));
}

function globSegmentMatches(pattern: string, candidate: string): boolean {
  if (pattern === "*") return !candidate.includes("/") && candidate !== "**";
  if (pattern === "?") return candidate.length === 1;
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern === candidate;
  const expression = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*/gu, "[^/]*")
      .replace(/\?/gu, "[^/]")}$`,
  );
  return expression.test(candidate);
}

function globClosure(pattern: string, states: readonly number[]): Set<number> {
  const closure = new Set(states);
  const pending = [...states];
  while (pending.length > 0) {
    const state = pending.pop();
    if (state === undefined || pattern[state] !== "*" || closure.has(state + 1)) continue;
    closure.add(state + 1);
    pending.push(state + 1);
  }
  return closure;
}

function globTransition(pattern: string, states: ReadonlySet<number>, character: string): Set<number> {
  const next: number[] = [];
  for (const state of globClosure(pattern, [...states])) {
    const token = pattern[state];
    if (token === "*") next.push(state);
    else if (token === "?" || token === character) next.push(state + 1);
  }
  return globClosure(pattern, next);
}

/** Prove that a wildcard candidate language is a subset of its ceiling. */
function globSegmentSubset(candidate: string, ceiling: string): boolean {
  if (candidate === ceiling) return true;
  if (!candidate.includes("*") && !candidate.includes("?")) return globSegmentMatches(ceiling, candidate);
  if (!ceiling.includes("*") && !ceiling.includes("?")) return false;

  const alphabet = new Set<string>(
    [...candidate, ...ceiling].filter((character) => character !== "*" && character !== "?"),
  );
  // All non-literal characters are equivalent for these bounded glob tokens.
  alphabet.add("\u0000");
  const startCandidate = globClosure(candidate, [0]);
  const startCeiling = globClosure(ceiling, [0]);
  const queue: Array<readonly [ReadonlySet<number>, ReadonlySet<number>]> = [[startCandidate, startCeiling]];
  const visited = new Set<string>();
  const key = (left: ReadonlySet<number>, right: ReadonlySet<number>): string =>
    `${[...left].sort((a, b) => a - b).join(",")}|${[...right].sort((a, b) => a - b).join(",")}`;
  visited.add(key(startCandidate, startCeiling));

  for (let index = 0; index < queue.length; index += 1) {
    const [candidateStates, ceilingStates] = queue[index];
    if (candidateStates.has(candidate.length) && !ceilingStates.has(ceiling.length)) return false;
    for (const character of alphabet) {
      const nextCandidate = globTransition(candidate, candidateStates, character);
      if (nextCandidate.size === 0) continue;
      const nextCeiling = globTransition(ceiling, ceilingStates, character);
      const nextKey = key(nextCandidate, nextCeiling);
      if (visited.has(nextKey)) continue;
      // An unexpectedly complex relation is not evidence of authorization.
      if (visited.size >= 4_096) return false;
      visited.add(nextKey);
      queue.push([nextCandidate, nextCeiling]);
    }
  }
  return true;
}

/** Conservative selector containment; uncertain glob relations fail closed. */
function selectorWithin(candidate: string, ceiling: string): boolean {
  if (candidate === ceiling) return true;
  const candidateParts = candidate.split("/");
  const ceilingParts = ceiling.split("/");
  const terminalGlobstar = ceilingParts.at(-1) === "**";
  if (ceilingParts.slice(0, terminalGlobstar ? -1 : undefined).includes("**")) return false;
  const fixedCeilingParts = terminalGlobstar ? ceilingParts.slice(0, -1) : ceilingParts;
  if (!terminalGlobstar && candidateParts.length !== ceilingParts.length) return false;
  if (terminalGlobstar && candidateParts.length < fixedCeilingParts.length) return false;
  let candidateIndex = 0;
  for (let ceilingIndex = 0; ceilingIndex < fixedCeilingParts.length; ceilingIndex += 1) {
    const ceilingPart = fixedCeilingParts[ceilingIndex];
    const candidatePart = candidateParts[candidateIndex];
    if (candidatePart === undefined || candidatePart === "**") return false;
    if (!globSegmentSubset(candidatePart, ceilingPart)) return false;
    candidateIndex += 1;
  }
  return terminalGlobstar || candidateIndex === candidateParts.length;
}

function withinAny(candidate: string, ceilings: readonly string[]): boolean {
  return ceilings.some((ceiling) => selectorWithin(candidate, ceiling));
}

function checkExternalScope(
  operation: FilesystemOperation,
  requested: readonly string[],
  externalScope: WorktreeProfileOverrideAuthorization["externalScope"],
): DomainResult<null> {
  if (externalScope?.filesystem === undefined) return success(null);
  const allowed = externalScope.filesystem[operation];
  if (allowed === undefined) {
    return invalid(
      `authorization.externalScope.filesystem.${operation}`,
      "external scope does not prove this operation",
    );
  }
  for (const item of requested) {
    if (!withinAny(item, allowed)) {
      return invalid(`restrictions.filesystem.${operation}`, "requested selector is outside external authority", {
        selector: item,
        operation,
      });
    }
  }
  return success(null);
}

function applyFilesystemRestrictions(
  profile: ResolvedWorktreeRuntimeProfile,
  requested: WorktreeProfileOverrideRestrictions["filesystem"],
  externalScope: WorktreeProfileOverrideAuthorization["externalScope"],
): DomainResult<ResolvedWorktreeRuntimeProfile["filesystem"]> {
  const current = profile.filesystem;
  if (requested === undefined) return success(current);
  const output: Record<string, readonly string[]> = { ...current };
  for (const operation of ALLOW_OPERATIONS) {
    const values = requested[operation];
    if (values === undefined) continue;
    for (const item of values) {
      if (!withinAny(item, current[operation])) {
        return invalid(`restrictions.filesystem.${operation}`, "requested selector exceeds the profile ceiling", {
          selector: item,
          operation,
        });
      }
    }
    const external = checkExternalScope(operation, values, externalScope);
    if (!external.ok) return external;
    output[operation] = values;
  }
  for (const operation of ["deny", "immutable"] as const) {
    const values = requested[operation];
    if (values === undefined) continue;
    output[operation] = Object.freeze([...new Set([...current[operation], ...values])].sort(compareText));
  }
  return success(Object.freeze(output as ResolvedWorktreeRuntimeProfile["filesystem"]));
}

function applyRestrictions(
  profile: ResolvedWorktreeRuntimeProfile,
  requested: WorktreeProfileOverrideRestrictions | undefined,
  externalScope: WorktreeProfileOverrideAuthorization["externalScope"],
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  if (requested === undefined) return success(profile);
  const filesystem = applyFilesystemRestrictions(profile, requested.filesystem, externalScope);
  if (!filesystem.ok) return filesystem;
  const execution = { ...profile.execution };
  if (requested.execution?.policy !== undefined) {
    if (profile.execution.policy.mode === "strict" && requested.execution.policy.mode === "compatibility") {
      return invalid("restrictions.execution.policy", "an override cannot enable compatibility or host fallback");
    }
    execution.policy = requested.execution.policy;
  }
  if (requested.execution?.processTracking !== undefined) {
    if (profile.execution.processTracking === "required" && requested.execution.processTracking === "optional") {
      return invalid("restrictions.execution.processTracking", "an override cannot weaken required process tracking");
    }
    execution.processTracking = requested.execution.processTracking;
  }
  const environment = {
    ...profile.environment,
    xdg: { ...profile.environment.xdg },
  };
  if (requested.environment?.xdg?.cache !== undefined) {
    environment.xdg.cache = "session";
  }
  const git = { ...profile.git };
  if (requested.git?.hooks !== undefined) {
    if (profile.git.hooks === "disabled" && requested.git.hooks !== "disabled") {
      return invalid("restrictions.git.hooks", "an override cannot enable hooks");
    }
    git.hooks = requested.git.hooks;
  }
  const candidate = {
    ...profile,
    filesystem: filesystem.value,
    execution: Object.freeze(execution),
    environment: Object.freeze({ ...environment, xdg: Object.freeze(environment.xdg) }),
    git: Object.freeze(git),
  };
  const checked = validateWorktreeRuntimeProfile(candidate);
  return checked.ok ? checked : failure(checked.error);
}

function applyBaselineRequirements(
  profile: ResolvedWorktreeRuntimeProfile,
  additions: readonly RuntimeProfileRequirement[] | undefined,
  externalScope: WorktreeProfileOverrideAuthorization["externalScope"],
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  if (additions === undefined || additions.length === 0) return success(profile);
  const authorized = externalScope?.baselineRequirements;
  if (authorized === undefined) {
    return invalid(
      "authorization.externalScope.baselineRequirements",
      "explicit authority is required for baseline additions",
    );
  }
  const existing = new Set<string>();
  for (const operation of profile.materialSelection.operations ?? []) {
    const id = operation.operation === "remove" ? operation.requirement_id : operation.requirement.id;
    existing.add(id);
  }
  const operations = [...(profile.materialSelection.operations ?? [])];
  for (const addition of additions) {
    if (!authorized.includes(addition.id)) {
      return invalid("baselineRequirements", "requirement is outside external authority", {
        requirement_id: addition.id,
      });
    }
    if (existing.has(addition.id)) {
      return ambiguous("baselineRequirements", "requirement already has a material operation", addition.id);
    }
    existing.add(addition.id);
    operations.push({ operation: "add", requirement: addition });
  }
  const candidate = {
    ...profile,
    materialSelection: { ...profile.materialSelection, operations: Object.freeze(operations) },
  };
  const checked = validateWorktreeRuntimeProfile(candidate);
  return checked.ok ? checked : failure(checked.error);
}

function applyToolRemoval(
  profile: ResolvedWorktreeRuntimeProfile,
  removeTools: readonly string[] | undefined,
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  if (removeTools === undefined || removeTools.length === 0) return success(profile);
  const known = new Set(profile.tools.map((tool) => tool.entrypoint));
  for (const tool of removeTools) {
    if (!known.has(tool))
      return invalid("removeTools", "tool entrypoint is not declared by the profile", { entrypoint: tool });
  }
  const tools = profile.tools.filter((tool) => !removeTools.includes(tool.entrypoint));
  const candidate = { ...profile, tools: Object.freeze(tools) };
  const checked = validateWorktreeRuntimeProfile(candidate);
  return checked.ok ? checked : failure(checked.error);
}

function canonicalizeProvenanceParameters(original: JsonObject, override: WorktreeProfileOverride): JsonObject {
  const output: Record<string, unknown> = { ...original };
  output[WORKTREE_PROFILE_OVERRIDE_PROVENANCE_KEY] = override;
  return output as JsonObject;
}

function canonicalizeParameterValues(parameters: WorktreeProfileParameterValues): WorktreeProfileParameterValues {
  const output: Record<string, unknown> = { ...parameters };
  const profiles = output["materialSelection.profiles"];
  if (Array.isArray(profiles)) output["materialSelection.profiles"] = [...profiles].sort(compareText);
  return output as WorktreeProfileParameterValues;
}

/** Serialize a validated override under the governed worktree-profile key. */
export function serializeWorktreeProfileOverride(input: unknown): DomainResult<string> {
  const checked = validateWorktreeProfileOverride(input);
  return checked.ok
    ? success(
        JSON.stringify({
          [WORKTREE_PROFILE_OVERRIDE_SERIALIZATION_KEY]: {
            schema_version: WORKTREE_PROFILE_OVERRIDE_SCHEMA_VERSION,
            ...checked.value,
          },
        }),
      )
    : failure(checked.error);
}

/**
 * Apply a bounded create-time override to an already pinned profile.
 *
 * The result is a new immutable pin.  No live session/profile registry is
 * touched, and the override is recorded in the selection provenance so the
 * digest identifies both the resulting profile and the concrete request.
 */
export function applyWorktreeProfileOverrides(
  pinnedInput: unknown,
  overrideInput: unknown,
  authorizationInput: unknown,
): DomainResult<WorktreeProfileOverrideResult> {
  let pinned: PinnedWorktreeProfile;
  try {
    pinned = parsePinnedProfileRecord(pinnedInput);
  } catch (cause) {
    return invalid("pinned", "expected a valid immutable pinned worktree profile", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  const override = validateWorktreeProfileOverride(overrideInput);
  if (!override.ok) return override;
  const authorization = validateWorktreeProfileOverrideAuthorization(authorizationInput);
  if (!authorization.ok) return authorization;

  let profile: ResolvedWorktreeRuntimeProfile = pinned.resolved;
  const removed = applyToolRemoval(profile, override.value.removeTools);
  if (!removed.ok) return removed;
  profile = removed.value;
  const restricted = applyRestrictions(profile, override.value.restrictions, authorization.value.externalScope);
  if (!restricted.ok) return restricted;
  profile = restricted.value;
  const baseline = applyBaselineRequirements(
    profile,
    override.value.baselineRequirements,
    authorization.value.externalScope,
  );
  if (!baseline.ok) return baseline;
  profile = baseline.value;
  if (override.value.parameters !== undefined) {
    const parameterized = substituteProfileParameters(profile, canonicalizeParameterValues(override.value.parameters));
    if (!parameterized.ok) return parameterized;
    profile = parameterized.value;
  }

  try {
    return success(
      pinWorktreeProfile(
        profile,
        {
          ...pinned.provenance,
          selection: {
            ...pinned.provenance.selection,
            parameters: canonicalizeProvenanceParameters(pinned.provenance.selection.parameters, {
              ...override.value,
              ...(override.value.parameters === undefined
                ? {}
                : { parameters: canonicalizeParameterValues(override.value.parameters) }),
            }),
          },
        },
        pinned.pinned_at,
      ),
    );
  } catch (cause) {
    return invalid("result", "the overridden profile could not be pinned", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export type { FilesystemOperation, RestrictableFilesystemOperation };
