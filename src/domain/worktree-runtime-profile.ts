import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import { validateRuntimePolicy, type RuntimeExecutableProvider, type RuntimePolicy } from "./runtime-projection.js";
import type { RuntimeProfileRequirementOperation, RuntimeProfileSelection } from "./runtime-profile.js";

/** Versioned contract for the local runtime configuration of a managed worktree. */
export const WORKTREE_RUNTIME_PROFILE_CONTRACT_ID = "nawabari.worktree-runtime-profile.v1" as const;
export const WORKTREE_RUNTIME_PROFILE_SCHEMA_VERSION = 1 as const;
export const WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY = "worktree-profile" as const;

export const WORKTREE_RUNTIME_FILESYSTEM_OPERATIONS = Object.freeze([
  "READONLY",
  "WRITE",
  "CREATE",
  "DELETE",
  "DENY",
] as const);

export const WORKTREE_RUNTIME_PROCESS_TRACKING_MODES = Object.freeze(["required", "optional"] as const);
export const WORKTREE_RUNTIME_ENVIRONMENT_SCOPES = Object.freeze(["session", "shared-read-only", "execution"] as const);
export const WORKTREE_RUNTIME_GIT_HOOK_MODES = Object.freeze(["disabled", "governed"] as const);

export type WorktreeRuntimeFilesystemOperation = (typeof WORKTREE_RUNTIME_FILESYSTEM_OPERATIONS)[number];
export type WorktreeRuntimeProcessTrackingMode = (typeof WORKTREE_RUNTIME_PROCESS_TRACKING_MODES)[number];
export type WorktreeRuntimeEnvironmentScope = (typeof WORKTREE_RUNTIME_ENVIRONMENT_SCOPES)[number];
export type WorktreeRuntimeGitHookMode = (typeof WORKTREE_RUNTIME_GIT_HOOK_MODES)[number];

/** Repository-relative selectors are a profile ceiling, not host paths or claims. */
export type WorktreeRuntimeFilesystemCeiling = Readonly<{
  readonly readOnly: readonly string[];
  readonly write: readonly string[];
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
  /** Mutation is forbidden in these areas even when an operation list matches. */
  readonly immutable: readonly string[];
}>;

/** A tool exposes an entrypoint, provider requirement, and optional declared material identity. */
export type WorktreeRuntimeToolReference = Readonly<{
  readonly entrypoint: string;
  readonly provider: RuntimeExecutableProvider;
  /** Host-declared material selected explicitly for this tool, when present. */
  readonly material_id?: string;
}>;

export type WorktreeRuntimeShellReference = Readonly<{
  /** Must name one of the declared tool entrypoints. */
  readonly entrypoint: string;
}>;

/** Environment roots are symbolic scopes; host HOME/XDG/TMP paths are never profile data. */
export type WorktreeRuntimeEnvironment = Readonly<{
  readonly home: "session";
  readonly xdg: Readonly<{
    readonly config: "session";
    readonly cache: "session" | "shared-read-only";
    readonly data: "session";
    readonly state: "session";
  }>;
  readonly tmp: "execution";
}>;

/** Git behavior is an explicit bounded policy, never inherited from the host. */
export type WorktreeRuntimeGitPolicy = Readonly<{
  readonly config: "session-private";
  readonly globalConfig: "excluded";
  readonly credentialHelpers: "disabled";
  readonly hooks: WorktreeRuntimeGitHookMode;
}>;

/** Protected execution policy is explicit and composes with SessionRuntimeProjection. */
export type WorktreeRuntimeExecutionPolicy = Readonly<{
  readonly policy: RuntimePolicy;
  readonly processTracking: WorktreeRuntimeProcessTrackingMode;
}>;

/** Declarative profile data. It contains no agent, task, orchestration, or host-runtime state. */
export type WorktreeRuntimeProfile = Readonly<{
  readonly id: string;
  readonly version: string;
  readonly materialSelection: RuntimeProfileSelection;
  readonly filesystem: WorktreeRuntimeFilesystemCeiling;
  readonly tools: readonly WorktreeRuntimeToolReference[];
  readonly shell: WorktreeRuntimeShellReference;
  readonly environment: WorktreeRuntimeEnvironment;
  readonly git: WorktreeRuntimeGitPolicy;
  readonly execution: WorktreeRuntimeExecutionPolicy;
}>;

/** Canonical validated form consumed by later resolution and pinning authorities. */
export type ResolvedWorktreeRuntimeProfile = WorktreeRuntimeProfile &
  Readonly<{
    readonly contract_id: typeof WORKTREE_RUNTIME_PROFILE_CONTRACT_ID;
    readonly schema_version: typeof WORKTREE_RUNTIME_PROFILE_SCHEMA_VERSION;
  }>;

export type WorktreeRuntimeProfileErrorCode = Extract<
  ErrorCode,
  "RUNTIME_PROFILE_INVALID" | "RUNTIME_PROFILE_AMBIGUOUS"
>;

type UnknownRecord = Record<string, unknown>;
type RequirementOperation = RuntimeProfileRequirementOperation;

const MAX_SELECTOR_COUNT = 2_048;
const MAX_OPERATION_COUNT = 2_048;
const MAX_TOOL_COUNT = 2_048;
const MAX_TEXT_LENGTH = 1_024;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;
const SELECTOR = /^(?!\/)(?![A-Za-z]:)(?!\.\.?\/)(?!.*(?:\\|\/\/))[A-Za-z0-9_.*?/@+:-]+$/u;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_INVALID", `Worktree runtime profile field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_AMBIGUOUS", `Worktree runtime profile field '${field}' is ambiguous: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function assertKeys(value: UnknownRecord, allowed: readonly string[], field: string): DomainResult<null> {
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

function stableIdentifier(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !STABLE_IDENTIFIER.test(value)) {
    return invalid(field, "expected a stable identifier");
  }
  return success(value);
}

function entrypoint(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !ENTRYPOINT.test(value)) {
    return invalid(field, "expected a projected executable entrypoint name");
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
    return invalid(field, "expected a canonical repository-relative selector", text.value);
  }
  return success(text.value);
}

function uniqueSortedSelectors(value: unknown, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_SELECTOR_COUNT) {
    return invalid(field, "expected a bounded selector array");
  }
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = selector(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    if (values.includes(parsed.value)) return ambiguous(field, "duplicate selector", parsed.value);
    values.push(parsed.value);
  }
  return success(Object.freeze(values.sort(compareText)));
}

function requirement(
  value: unknown,
  field: string,
): DomainResult<Readonly<{ id: string; kind: "runtime" | "package"; name: string; version: string }>> {
  if (!isRecord(value)) return invalid(field, "expected a requirement object");
  const keys = assertKeys(value, ["id", "kind", "name", "version"], field);
  if (!keys.ok) return keys;
  const id = stableIdentifier(value.id, `${field}.id`);
  if (!id.ok) return id;
  if (value.kind !== "runtime" && value.kind !== "package") {
    return invalid(`${field}.kind`, "expected 'runtime' or 'package'");
  }
  const name = boundedText(value.name, `${field}.name`);
  if (!name.ok) return name;
  const version = boundedText(value.version, `${field}.version`);
  if (!version.ok) return version;
  if (
    name.value.startsWith("/") ||
    name.value.startsWith("~") ||
    name.value.startsWith("$") ||
    version.value.startsWith("/") ||
    version.value.startsWith("~") ||
    version.value.startsWith("$")
  ) {
    return invalid(field, "host paths and environment expressions are not logical requirements");
  }
  return success(Object.freeze({ id: id.value, kind: value.kind, name: name.value, version: version.value }));
}

function materialSelection(value: unknown): DomainResult<RuntimeProfileSelection> {
  if (!isRecord(value)) return invalid("materialSelection", "expected an object");
  const keys = assertKeys(value, ["profiles", "operations"], "materialSelection");
  if (!keys.ok) return keys;
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    return invalid("materialSelection.profiles", "expected a non-empty array");
  }
  const profiles: string[] = [];
  for (const [index, item] of value.profiles.entries()) {
    const profile = stableIdentifier(item, `materialSelection.profiles[${index}]`);
    if (!profile.ok) return profile;
    if (profiles.includes(profile.value))
      return ambiguous("materialSelection.profiles", "duplicate profile", profile.value);
    profiles.push(profile.value);
  }

  if (
    value.operations !== undefined &&
    (!Array.isArray(value.operations) || value.operations.length > MAX_OPERATION_COUNT)
  ) {
    return invalid("materialSelection.operations", "expected an array");
  }
  const operations: RequirementOperation[] = [];
  for (const [index, item] of (value.operations ?? []).entries()) {
    const field = `materialSelection.operations[${index}]`;
    if (!isRecord(item)) return invalid(field, "expected an operation object");
    const operationKeys = assertKeys(item, ["operation", "requirement", "requirement_id"], field);
    if (!operationKeys.ok) return operationKeys;
    if (item.operation !== "add" && item.operation !== "remove" && item.operation !== "override") {
      return invalid(`${field}.operation`, "expected add, remove, or override");
    }
    if (item.operation === "remove") {
      const requirementId = stableIdentifier(item.requirement_id, `${field}.requirement_id`);
      if (!requirementId.ok) return requirementId;
      if (item.requirement !== undefined) return invalid(field, "remove cannot contain a requirement");
      operations.push(Object.freeze({ operation: "remove", requirement_id: requirementId.value }));
      continue;
    }
    if (item.requirement_id !== undefined) return invalid(field, "add and override require a requirement object");
    const parsed = requirement(item.requirement, `${field}.requirement`);
    if (!parsed.ok) return parsed;
    operations.push(Object.freeze({ operation: item.operation, requirement: parsed.value }));
  }

  return success(
    Object.freeze({
      profiles: Object.freeze(profiles.sort(compareText)),
      operations: Object.freeze(operations),
    }),
  );
}

function filesystem(value: unknown): DomainResult<WorktreeRuntimeFilesystemCeiling> {
  if (!isRecord(value)) return invalid("filesystem", "expected an object");
  const keys = assertKeys(value, ["readOnly", "write", "create", "delete", "deny", "immutable"], "filesystem");
  if (!keys.ok) return keys;
  const readOnly = uniqueSortedSelectors(value.readOnly, "filesystem.readOnly");
  if (!readOnly.ok) return readOnly;
  const write = uniqueSortedSelectors(value.write, "filesystem.write");
  if (!write.ok) return write;
  const create = uniqueSortedSelectors(value.create, "filesystem.create");
  if (!create.ok) return create;
  const remove = uniqueSortedSelectors(value.delete, "filesystem.delete");
  if (!remove.ok) return remove;
  const deny = uniqueSortedSelectors(value.deny, "filesystem.deny");
  if (!deny.ok) return deny;
  const immutable = uniqueSortedSelectors(value.immutable, "filesystem.immutable");
  if (!immutable.ok) return immutable;
  return success(
    Object.freeze({
      readOnly: readOnly.value,
      write: write.value,
      create: create.value,
      delete: remove.value,
      deny: deny.value,
      immutable: immutable.value,
    }),
  );
}

function tool(value: unknown, index: number): DomainResult<WorktreeRuntimeToolReference> {
  const field = `tools[${index}]`;
  if (!isRecord(value)) return invalid(field, "expected an object");
  const keys = assertKeys(value, ["entrypoint", "provider", "material_id"], field);
  if (!keys.ok) return keys;
  const name = entrypoint(value.entrypoint, `${field}.entrypoint`);
  if (!name.ok) return name;
  if (!isRecord(value.provider)) return invalid(`${field}.provider`, "expected a provider requirement reference");
  const providerKeys = assertKeys(value.provider, ["id", "requirement_id"], `${field}.provider`);
  if (!providerKeys.ok) return providerKeys;
  const providerId = stableIdentifier(value.provider.id, `${field}.provider.id`);
  if (!providerId.ok) return providerId;
  const requirementId = stableIdentifier(value.provider.requirement_id, `${field}.provider.requirement_id`);
  if (!requirementId.ok) return requirementId;
  let materialId: string | undefined;
  if (value.material_id !== undefined) {
    const checked = stableIdentifier(value.material_id, `${field}.material_id`);
    if (!checked.ok) return checked;
    materialId = checked.value;
  }
  return success(
    Object.freeze({
      entrypoint: name.value,
      provider: Object.freeze({ id: providerId.value, requirement_id: requirementId.value }),
      ...(materialId === undefined ? {} : { material_id: materialId }),
    }),
  );
}

function tools(value: unknown): DomainResult<readonly WorktreeRuntimeToolReference[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TOOL_COUNT) {
    return invalid("tools", "expected a bounded non-empty array");
  }
  const result: WorktreeRuntimeToolReference[] = [];
  const entrypoints = new Set<string>();
  for (const [index, item] of value.entries()) {
    const parsed = tool(item, index);
    if (!parsed.ok) return parsed;
    if (entrypoints.has(parsed.value.entrypoint))
      return ambiguous("tools", "duplicate entrypoint", parsed.value.entrypoint);
    entrypoints.add(parsed.value.entrypoint);
    result.push(parsed.value);
  }
  return success(
    Object.freeze(
      result.sort((left, right) =>
        compareText(
          `${left.entrypoint}\u0000${left.provider.id}\u0000${left.provider.requirement_id}`,
          `${right.entrypoint}\u0000${right.provider.id}\u0000${right.provider.requirement_id}`,
        ),
      ),
    ),
  );
}

function shell(
  value: unknown,
  declaredTools: readonly WorktreeRuntimeToolReference[],
): DomainResult<WorktreeRuntimeShellReference> {
  if (!isRecord(value)) return invalid("shell", "expected an explicit entrypoint reference");
  const keys = assertKeys(value, ["entrypoint"], "shell");
  if (!keys.ok) return keys;
  const name = entrypoint(value.entrypoint, "shell.entrypoint");
  if (!name.ok) return name;
  if (!declaredTools.some((toolReference) => toolReference.entrypoint === name.value)) {
    return invalid("shell.entrypoint", "must reference a declared tool entrypoint", name.value);
  }
  return success(Object.freeze({ entrypoint: name.value }));
}

function environment(value: unknown): DomainResult<WorktreeRuntimeEnvironment> {
  if (!isRecord(value)) return invalid("environment", "expected explicit session-local roots");
  const keys = assertKeys(value, ["home", "xdg", "tmp"], "environment");
  if (!keys.ok) return keys;
  if (value.home !== "session") return invalid("environment.home", "must be the session-local root");
  if (value.tmp !== "execution") return invalid("environment.tmp", "must be the execution-local root");
  if (!isRecord(value.xdg)) return invalid("environment.xdg", "expected explicit XDG roots");
  const xdgKeys = assertKeys(value.xdg, ["config", "cache", "data", "state"], "environment.xdg");
  if (!xdgKeys.ok) return xdgKeys;
  if (value.xdg.config !== "session") return invalid("environment.xdg.config", "must be the session-local root");
  if (value.xdg.cache !== "session" && value.xdg.cache !== "shared-read-only") {
    return invalid("environment.xdg.cache", "must be session or explicit shared-read-only");
  }
  if (value.xdg.data !== "session") return invalid("environment.xdg.data", "must be the session-local root");
  if (value.xdg.state !== "session") return invalid("environment.xdg.state", "must be the session-local root");
  return success(
    Object.freeze({
      home: "session",
      xdg: Object.freeze({
        config: "session",
        cache: value.xdg.cache,
        data: "session",
        state: "session",
      }),
      tmp: "execution",
    }),
  );
}

function git(value: unknown): DomainResult<WorktreeRuntimeGitPolicy> {
  if (!isRecord(value)) return invalid("git", "expected an explicit governed Git policy");
  const keys = assertKeys(value, ["config", "globalConfig", "credentialHelpers", "hooks"], "git");
  if (!keys.ok) return keys;
  if (value.config !== "session-private") return invalid("git.config", "must be session-private");
  if (value.globalConfig !== "excluded") return invalid("git.globalConfig", "host/global Git config is excluded");
  if (value.credentialHelpers !== "disabled") {
    return invalid("git.credentialHelpers", "ambient credential helpers are disabled");
  }
  if (!WORKTREE_RUNTIME_GIT_HOOK_MODES.includes(value.hooks as WorktreeRuntimeGitHookMode)) {
    return invalid("git.hooks", "expected disabled or governed hooks");
  }
  return success(
    Object.freeze({
      config: "session-private",
      globalConfig: "excluded",
      credentialHelpers: "disabled",
      hooks: value.hooks as WorktreeRuntimeGitHookMode,
    }),
  );
}

function execution(value: unknown): DomainResult<WorktreeRuntimeExecutionPolicy> {
  if (!isRecord(value)) return invalid("execution", "expected an explicit protected-execution policy");
  const keys = assertKeys(value, ["policy", "processTracking"], "execution");
  if (!keys.ok) return keys;
  if (!WORKTREE_RUNTIME_PROCESS_TRACKING_MODES.includes(value.processTracking as WorktreeRuntimeProcessTrackingMode)) {
    return invalid("execution.processTracking", "expected required or optional process tracking");
  }
  if (!isRecord(value.policy)) return invalid("execution.policy", "expected an explicit runtime policy");
  const policyKeys = assertKeys(
    value.policy,
    ["mode", "host_visibility", "compatibility", "unrestricted_host_fallback"],
    "execution.policy",
  );
  if (!policyKeys.ok) return policyKeys;
  const policy = validateRuntimePolicy(value.policy);
  if (!policy.ok) return failure(policy.error);
  return success(
    Object.freeze({
      policy: policy.value,
      processTracking: value.processTracking as WorktreeRuntimeProcessTrackingMode,
    }),
  );
}

/**
 * Validate and canonicalize a Worktree Runtime Profile without consulting the
 * host, filesystem, Git, material catalog, or execution backend.
 *
 * The returned value is the boundary object for later catalog resolution,
 * filesystem-policy compilation, and session pinning. It intentionally does
 * not resolve material requirements or grant external scope.
 */
export function validateWorktreeRuntimeProfile(input: unknown): DomainResult<ResolvedWorktreeRuntimeProfile> {
  if (!isRecord(input)) return invalid("profile", "expected an object");
  const keys = assertKeys(
    input,
    [
      "contract_id",
      "schema_version",
      "id",
      "version",
      "materialSelection",
      "filesystem",
      "tools",
      "shell",
      "environment",
      "git",
      "execution",
    ],
    "profile",
  );
  if (!keys.ok) return keys;
  if ("contract_id" in input && input.contract_id !== WORKTREE_RUNTIME_PROFILE_CONTRACT_ID) {
    return invalid("contract_id", "does not match the canonical worktree runtime profile contract");
  }
  if ("schema_version" in input && input.schema_version !== WORKTREE_RUNTIME_PROFILE_SCHEMA_VERSION) {
    return invalid("schema_version", "does not match the canonical worktree runtime profile schema");
  }

  const id = stableIdentifier(input.id, "id");
  if (!id.ok) return id;
  const version = boundedText(input.version, "version");
  if (!version.ok) return version;
  const selectedMaterial = materialSelection(input.materialSelection);
  if (!selectedMaterial.ok) return selectedMaterial;
  const selectedFilesystem = filesystem(input.filesystem);
  if (!selectedFilesystem.ok) return selectedFilesystem;
  const selectedTools = tools(input.tools);
  if (!selectedTools.ok) return selectedTools;
  const selectedShell = shell(input.shell, selectedTools.value);
  if (!selectedShell.ok) return selectedShell;
  const selectedEnvironment = environment(input.environment);
  if (!selectedEnvironment.ok) return selectedEnvironment;
  const selectedGit = git(input.git);
  if (!selectedGit.ok) return selectedGit;
  const selectedExecution = execution(input.execution);
  if (!selectedExecution.ok) return selectedExecution;

  return success(
    Object.freeze({
      contract_id: WORKTREE_RUNTIME_PROFILE_CONTRACT_ID,
      schema_version: WORKTREE_RUNTIME_PROFILE_SCHEMA_VERSION,
      id: id.value,
      version: version.value,
      materialSelection: selectedMaterial.value,
      filesystem: selectedFilesystem.value,
      tools: selectedTools.value,
      shell: selectedShell.value,
      environment: selectedEnvironment.value,
      git: selectedGit.value,
      execution: selectedExecution.value,
    }),
  );
}

export const projectWorktreeRuntimeProfile = validateWorktreeRuntimeProfile;
export const validateResolvedWorktreeRuntimeProfile = validateWorktreeRuntimeProfile;

/** Serialize only the validated canonical profile under its governed document key. */
export function serializeWorktreeRuntimeProfile(input: unknown): DomainResult<string> {
  const profile = validateWorktreeRuntimeProfile(input);
  return profile.ok
    ? success(JSON.stringify({ [WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY]: profile.value }))
    : failure(profile.error);
}

export function isWorktreeRuntimeProfileError(
  error: DomainError,
): error is DomainError & { readonly code: WorktreeRuntimeProfileErrorCode } {
  return error.code === "RUNTIME_PROFILE_INVALID" || error.code === "RUNTIME_PROFILE_AMBIGUOUS";
}

/** JSON-safe descriptor for the schema and its authority boundaries. */
export const WORKTREE_RUNTIME_PROFILE_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: WORKTREE_RUNTIME_PROFILE_CONTRACT_ID,
  schema_version: WORKTREE_RUNTIME_PROFILE_SCHEMA_VERSION,
  serialization_key: WORKTREE_RUNTIME_PROFILE_SERIALIZATION_KEY,
  fields: ["id", "version", "materialSelection", "filesystem", "tools", "shell", "environment", "git", "execution"],
  filesystem_operations: [...WORKTREE_RUNTIME_FILESYSTEM_OPERATIONS],
  filesystem_precedence: ["DENY", "immutable", "operation-specific allow"],
  authorities: {
    material: "existing RuntimeProfile resolver and requirement authority",
    filesystem: "profile baseline only; external Inari/EWS/claim scope may narrow it",
    execution: "SessionRuntimeProjection and its protected-execution backend",
  },
  excludes: ["agent", "task", "issue", "orchestration", "host paths", "shell command strings", "ambient host fallback"],
});
