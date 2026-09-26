import { DomainError, failure, success, type DomainResult, type JsonObject, type JsonValue } from "./domain/errors.js";
import { inspectLocalManagedExecutionReadiness } from "./domain/session-backend.js";
import { sandboxDoctorReport } from "./domain/sandbox.js";
import {
  BUILTIN_WORKTREE_PROFILE_AVAILABILITY,
  BUILTIN_WORKTREE_PROFILE_CATALOG,
  BUILTIN_WORKTREE_PROFILE_NAMESPACE,
  getBuiltinWorktreeProfile,
  getBuiltinWorktreeProfileStatusForResolution,
  resolveBuiltinWorktreeProfile,
  type BuiltinWorktreeProfileAvailability,
  type BuiltinWorktreeProfileStatus,
} from "./domain/worktree-profile-builtins.js";
import {
  resolveWorktreeProfile,
  substituteProfileParameters,
  validateWorktreeProfileCatalog,
  type CatalogWorktreeProfile,
  type WorktreeProfileCatalog,
  type WorktreeProfileParameterValues,
} from "./domain/worktree-profile-catalog.js";
import {
  validateWorktreeRuntimeProfile,
  type ResolvedWorktreeRuntimeProfile,
} from "./domain/worktree-runtime-profile.js";

/** Versioned public surface for profile CLI requests and projections. */
export const WORKTREE_PROFILE_CLI_CONTRACT_ID = "nawabari.worktree-profile-cli.v1" as const;
export const WORKTREE_PROFILE_CLI_SCHEMA_VERSION = 1 as const;
export const WORKTREE_PROFILE_CLI_SERIALIZATION_KEY = "cli" as const;
export const WORKTREE_PROFILE_CONTRACT_SERIALIZATION_KEY = "contract" as const;
export const WORKTREE_PROFILE_REFERENCE_SEPARATOR = ":" as const;

export type WorktreeProfileNamespace = typeof BUILTIN_WORKTREE_PROFILE_NAMESPACE | "repository";
export type WorktreeProfileAvailability = BuiltinWorktreeProfileAvailability | "unknown";

export type WorktreeProfileCliOptions = Readonly<{
  readonly profile: string | null;
  readonly parameters: JsonObject | null;
}>;

export type WorktreeProfileCliRequest =
  | Readonly<{ readonly command: "profile list" }>
  | Readonly<{ readonly command: "profile show"; readonly profile: string }>
  | Readonly<{
      readonly command: "session create";
      readonly profile: string | null;
      readonly parameters: JsonObject | null;
    }>;

export type WorktreeProfileCliSource = Readonly<{
  readonly namespace: WorktreeProfileNamespace;
  readonly id: string;
  readonly version: string;
  readonly reference: string;
}>;

export type WorktreeProfileCliSummary = WorktreeProfileCliSource &
  Readonly<{
    readonly availability: WorktreeProfileAvailability;
    readonly ready: boolean;
    readonly missing: readonly string[];
    readonly collision: boolean;
    readonly readiness: WorktreeProfileReadiness;
  }>;

export type WorktreeProfileReadiness = Readonly<{
  readonly definition: Readonly<{ ready: true }>;
  readonly resolution: Readonly<{ ready: boolean; blocker_code: string | null }>;
  readonly material: Readonly<{
    availability: WorktreeProfileAvailability;
    ready: boolean;
    missing: readonly string[];
  }>;
  readonly sandbox: Readonly<{ ready: boolean }>;
  readonly managed_execution: Readonly<{ process_tracking: "required" | "not_required"; ready: boolean | null }>;
  readonly bootstrap: Readonly<{
    ready: boolean | null;
    blocker_code: string | null;
  }>;
}>;

export type WorktreeProfileCliList = Readonly<{
  readonly contract_id: typeof WORKTREE_PROFILE_CLI_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_PROFILE_CLI_SCHEMA_VERSION;
  readonly command: "profile list";
  readonly profiles: readonly WorktreeProfileCliSummary[];
}>;

export type WorktreeProfileCliShow = Readonly<{
  readonly contract_id: typeof WORKTREE_PROFILE_CLI_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_PROFILE_CLI_SCHEMA_VERSION;
  readonly command: "profile show";
  readonly source: WorktreeProfileCliSource;
  readonly profile: ResolvedWorktreeRuntimeProfile;
  readonly availability: WorktreeProfileAvailability;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly collision: boolean;
  readonly readiness: WorktreeProfileReadiness;
}>;

export type WorktreeProfileSessionCreateResolution = Readonly<{
  readonly contract_id: typeof WORKTREE_PROFILE_CLI_CONTRACT_ID;
  readonly schema_version: typeof WORKTREE_PROFILE_CLI_SCHEMA_VERSION;
  readonly command: "session create";
  /** Null preserves the pre-profile bootstrap path exactly. */
  readonly profile: Readonly<{
    readonly namespace: WorktreeProfileNamespace;
    readonly reference: string;
    readonly selection: Readonly<{ readonly profile: string }>;
    readonly parameters: JsonObject;
    readonly resolved: ResolvedWorktreeRuntimeProfile;
    readonly availability: WorktreeProfileAvailability;
    readonly ready: boolean;
    readonly missing: readonly string[];
  }> | null;
}>;

export type WorktreeProfileCliResponse = WorktreeProfileCliList | WorktreeProfileCliShow;

export type WorktreeProfileCliSources = Readonly<{
  /** Repository definitions are optional; built-ins are always explicit. */
  readonly repository?: unknown;
  /** Read-only canonical probes may be supplied by a caller that already owns them. */
  readonly sandboxReadiness?: () => boolean;
  readonly managedExecutionReadiness?: () => Readonly<{ ready: boolean }>;
}>;

function readinessFor(
  profile: ResolvedWorktreeRuntimeProfile,
  availability: WorktreeProfileAvailability,
  materialReady: boolean,
  missing: readonly string[],
  input: WorktreeProfileCliSources,
  resolutionBlocker: string | null = null,
): WorktreeProfileReadiness {
  const sandboxReady = (input.sandboxReadiness ?? (() => sandboxDoctorReport().ready))();
  const required = profile.execution.processTracking === "required";
  const managedReady = required
    ? (input.managedExecutionReadiness ?? inspectLocalManagedExecutionReadiness)().ready
    : null;
  const blocker =
    resolutionBlocker !== null
      ? resolutionBlocker
      : availability === "missing"
        ? "RUNTIME_MATERIALIZATION_MISSING"
        : required && !managedReady
          ? "SANDBOX_CAPABILITY_UNAVAILABLE"
          : !materialReady && availability !== "unknown"
            ? "RUNTIME_MATERIALIZATION_MISSING"
            : null;
  return Object.freeze({
    definition: { ready: true },
    resolution: { ready: resolutionBlocker === null, blocker_code: resolutionBlocker },
    material: { availability, ready: materialReady, missing: [...missing] },
    sandbox: { ready: sandboxReady },
    managed_execution: { process_tracking: required ? "required" : "not_required", ready: managedReady },
    bootstrap: { ready: blocker === null ? (availability === "unknown" ? null : true) : false, blocker_code: blocker },
  });
}

type ParsedReference = Readonly<{ readonly namespace: WorktreeProfileNamespace | null; readonly id: string }>;
type ResolvedSource = Readonly<{
  readonly source: WorktreeProfileCliSource;
  readonly profile: ResolvedWorktreeRuntimeProfile;
  readonly availability: WorktreeProfileAvailability;
  readonly ready: boolean;
  readonly missing: readonly string[];
  readonly collision: boolean;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function usage(code: "INVALID_ARGUMENT" | "MISSING_ARGUMENT", message: string, details: JsonObject = {}) {
  return failure(new DomainError(code, message, details));
}

function profileInvalid(message: string, details: JsonObject = {}) {
  return failure(new DomainError("RUNTIME_PROFILE_INVALID", message, details));
}

function profileMissing(id: string) {
  return failure(new DomainError("RUNTIME_PROFILE_MISSING", `Unknown worktree profile '${id}'.`, { profile_id: id }));
}

function profileAmbiguous(id: string) {
  return failure(
    new DomainError(
      "RUNTIME_PROFILE_AMBIGUOUS",
      `Worktree profile '${id}' is declared by both built-in and repository catalogs; use an explicit namespace.`,
      { profile_id: id, namespaces: [BUILTIN_WORKTREE_PROFILE_NAMESPACE, "repository"] },
    ),
  );
}

function parseJsonObject(value: string): DomainResult<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    return usage("INVALID_ARGUMENT", "--profile-parameter requires one valid JSON object.", {
      option: "--profile-parameter",
      reason: error instanceof Error ? error.message : "invalid JSON",
    });
  }
  if (!record(parsed)) {
    return usage("INVALID_ARGUMENT", "--profile-parameter requires one JSON object.", {
      option: "--profile-parameter",
    });
  }
  return success(parsed as JsonObject);
}

function optionParts(argument: string): { readonly name: string; readonly inlineValue: string | null } {
  const separator = argument.indexOf("=");
  return separator < 0
    ? { name: argument, inlineValue: null }
    : { name: argument.slice(0, separator), inlineValue: argument.slice(separator + 1) };
}

function optionValue(
  arguments_: readonly string[],
  index: number,
  name: string,
  inlineValue: string | null,
): DomainResult<{ readonly value: string; readonly consumed: boolean }> {
  const value = inlineValue ?? arguments_[index + 1];
  if (value === undefined || value.length === 0 || (inlineValue === null && value.startsWith("-"))) {
    return usage("MISSING_ARGUMENT", `${name} requires a value.`, { option: name });
  }
  return success({ value, consumed: inlineValue === null });
}

/** Parse only profile-owned options, leaving unrelated session-create options to the central dispatcher. */
export function parseWorktreeProfileOptions(arguments_: readonly string[]): DomainResult<WorktreeProfileCliOptions> {
  let profile: string | null = null;
  let parameters: JsonObject | null = null;
  for (let index = 0; index < arguments_.length; index += 1) {
    const { name, inlineValue } = optionParts(arguments_[index]);
    if (name !== "--profile" && name !== "--profile-parameter") {
      return usage("INVALID_ARGUMENT", `Unknown profile option: ${name}.`, { option: name });
    }
    const parsed = optionValue(arguments_, index, name, inlineValue);
    if (!parsed.ok) return parsed;
    if (parsed.value.consumed) index += 1;
    if (name === "--profile") {
      if (profile !== null) return usage("INVALID_ARGUMENT", "--profile may be supplied only once.", { option: name });
      profile = parsed.value.value;
      continue;
    }
    if (parameters !== null) {
      return usage("INVALID_ARGUMENT", "--profile-parameter may be supplied only once.", { option: name });
    }
    const object = parseJsonObject(parsed.value.value);
    if (!object.ok) return object;
    parameters = object.value;
  }
  if (parameters !== null && profile === null) {
    return usage("INVALID_ARGUMENT", "--profile-parameter requires --profile.", { option: "--profile" });
  }
  return success(Object.freeze({ profile, parameters }));
}

/** Parse the bounded command subset owned by this component. */
export function parseWorktreeProfileCliArguments(
  arguments_: readonly string[],
): DomainResult<WorktreeProfileCliRequest> {
  const [command, subcommand, ...rest] = arguments_;
  if (command === "profile" && subcommand === "list") {
    if (rest.length > 0) return usage("INVALID_ARGUMENT", "profile list does not accept options.");
    return success({ command: "profile list" });
  }
  if (command === "profile" && subcommand === "show") {
    const options = parseWorktreeProfileOptions(rest);
    if (!options.ok) return options;
    if (options.value.parameters !== null) {
      return usage("INVALID_ARGUMENT", "profile show does not accept --profile-parameter.", {
        option: "--profile-parameter",
      });
    }
    if (options.value.profile === null) {
      return usage("MISSING_ARGUMENT", "profile show requires --profile <id>.", { option: "--profile" });
    }
    return success({ command: "profile show", profile: options.value.profile });
  }
  if (command === "session" && subcommand === "create") {
    const options = parseWorktreeProfileOptions(rest);
    if (!options.ok) return options;
    return success({ command: "session create", profile: options.value.profile, parameters: options.value.parameters });
  }
  if (command === "profile") {
    return failure(new DomainError("UNKNOWN_COMMAND", `Unknown profile subcommand: ${subcommand ?? "<missing>"}.`));
  }
  if (command === "session") {
    return failure(new DomainError("UNKNOWN_COMMAND", `Unknown session subcommand: ${subcommand ?? "<missing>"}.`));
  }
  return failure(new DomainError("UNKNOWN_COMMAND", `Unknown command: ${command ?? "<missing>"}.`));
}

/** Alias named after the public command surface. */
export const parseWorktreeProfileCli = parseWorktreeProfileCliArguments;

function parseReference(value: unknown): DomainResult<ParsedReference> {
  if (typeof value !== "string") {
    return profileInvalid("Profile reference must be a string.", { field: "profile" });
  }
  const separator = value.indexOf(WORKTREE_PROFILE_REFERENCE_SEPARATOR);
  if (separator < 0) {
    return stableIdentifier(value)
      ? success({ namespace: null, id: value })
      : profileInvalid("Profile reference must contain a stable profile id.", { field: "profile", value });
  }
  const namespace = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (namespace !== BUILTIN_WORKTREE_PROFILE_NAMESPACE && namespace !== "repository") {
    return profileInvalid("Profile reference has an unknown namespace.", { field: "profile", value, namespace });
  }
  if (!stableIdentifier(id)) {
    return profileInvalid("Profile reference must contain a stable profile id.", { field: "profile", value });
  }
  return success({ namespace, id });
}

function repositoryCatalog(input: unknown): DomainResult<WorktreeProfileCatalog | null> {
  if (input === undefined || input === null) return success(null);
  const parsed = validateWorktreeProfileCatalog(input);
  return parsed.ok ? success(parsed.value) : failure(parsed.error);
}

function profileIds(catalog: WorktreeProfileCatalog | null): ReadonlySet<string> {
  return new Set(catalog?.profiles.map((profile) => profile.id) ?? []);
}

function sourceFor(namespace: WorktreeProfileNamespace, id: string, version: string): WorktreeProfileCliSource {
  return Object.freeze({
    namespace,
    id,
    version,
    reference: `${namespace}${WORKTREE_PROFILE_REFERENCE_SEPARATOR}${id}`,
  });
}

function builtinStatus(id: string): BuiltinWorktreeProfileStatus {
  return BUILTIN_WORKTREE_PROFILE_AVAILABILITY[id as keyof typeof BUILTIN_WORKTREE_PROFILE_AVAILABILITY];
}

function resolveFromCatalog(
  namespace: WorktreeProfileNamespace,
  id: string,
  catalog: WorktreeProfileCatalog,
  parameters: WorktreeProfileParameterValues | undefined,
): DomainResult<ResolvedWorktreeRuntimeProfile> {
  const resolved = resolveWorktreeProfile({ profile: id }, catalog);
  if (!resolved.ok) return resolved;
  if (parameters === undefined) return resolved;
  return substituteProfileParameters(resolved.value, parameters);
}

function resolveSelectedProfile(
  reference: string,
  repository: WorktreeProfileCatalog | null,
  parameters: WorktreeProfileParameterValues | undefined,
): DomainResult<ResolvedSource> {
  const parsedReference = parseReference(reference);
  if (!parsedReference.ok) return parsedReference;
  const { namespace, id } = parsedReference.value;
  const repositoryIds = profileIds(repository);
  const builtinIds = profileIds(BUILTIN_WORKTREE_PROFILE_CATALOG);
  const collision = builtinIds.has(id) && repositoryIds.has(id);
  if (namespace === null && collision) return profileAmbiguous(id);
  const selectedNamespace = namespace ?? (builtinIds.has(id) ? BUILTIN_WORKTREE_PROFILE_NAMESPACE : "repository");
  if (selectedNamespace === BUILTIN_WORKTREE_PROFILE_NAMESPACE) {
    if (!builtinIds.has(id)) return profileMissing(id);
    const builtin = getBuiltinWorktreeProfile(id);
    if (!builtin.ok) return builtin;
    const resolved = resolveBuiltinWorktreeProfile({ profile: id }, parameters);
    if (!resolved.ok) return resolved;
    const status = getBuiltinWorktreeProfileStatusForResolution(id, resolved.value);
    if (!status.ok) return status;
    return success({
      source: sourceFor(selectedNamespace, id, builtin.value.version),
      profile: resolved.value,
      availability: status.value.availability,
      ready: status.value.ready,
      missing: status.value.missing,
      collision,
    });
  }
  if (repository === null || !repositoryIds.has(id)) return profileMissing(id);
  const declaration = repository.profiles.find((profile) => profile.id === id);
  if (declaration === undefined) return profileMissing(id);
  const resolved = resolveFromCatalog("repository", id, repository, parameters);
  if (!resolved.ok) return resolved;
  return success({
    source: sourceFor("repository", id, declaration.version),
    profile: resolved.value,
    // A declaration is not execution materialization evidence. Unknown is
    // intentionally preserved until the runtime resolver reports readiness.
    availability: "unknown",
    ready: false,
    missing: Object.freeze([]),
    collision,
  });
}

function sources(input: WorktreeProfileCliSources = {}): DomainResult<WorktreeProfileCatalog | null> {
  return repositoryCatalog(input.repository);
}

function summary(
  namespace: WorktreeProfileNamespace,
  profile: CatalogWorktreeProfile,
  status: {
    readonly availability: WorktreeProfileAvailability;
    readonly ready: boolean;
    readonly missing: readonly string[];
  },
  collision: boolean,
  input: WorktreeProfileCliSources,
  resolved: ResolvedWorktreeRuntimeProfile,
  resolutionBlocker: string | null = null,
): WorktreeProfileCliSummary {
  return Object.freeze({
    ...sourceFor(namespace, profile.id, profile.version),
    availability: status.availability,
    ready: status.ready,
    missing: Object.freeze([...status.missing]),
    collision,
    readiness: readinessFor(resolved, status.availability, status.ready, status.missing, input, resolutionBlocker),
  });
}

/** List built-ins and repository profiles without allowing either source to overwrite the other. */
export function listWorktreeProfiles(input: WorktreeProfileCliSources = {}): DomainResult<WorktreeProfileCliList> {
  const repositoryResult = sources(input);
  if (!repositoryResult.ok) return repositoryResult;
  const repository = repositoryResult.value;
  const builtinIds = new Set(BUILTIN_WORKTREE_PROFILE_CATALOG.profiles.map((profile) => profile.id));
  const repositoryIds = profileIds(repository);
  const profiles: WorktreeProfileCliSummary[] = [];
  for (const profile of BUILTIN_WORKTREE_PROFILE_CATALOG.profiles) {
    const status = builtinStatus(profile.id);
    const resolved = resolveBuiltinWorktreeProfile({ profile: profile.id }, {});
    if (!resolved.ok) return resolved;
    profiles.push(summary("builtin", profile, status, repositoryIds.has(profile.id), input, resolved.value));
  }
  for (const profile of repository?.profiles ?? []) {
    const resolved = resolveFromCatalog("repository", profile.id, repository!, undefined);
    profiles.push(
      summary(
        "repository",
        profile,
        { availability: "unknown", ready: false, missing: Object.freeze([]) },
        builtinIds.has(profile.id),
        input,
        resolved.ok ? resolved.value : profile,
        resolved.ok ? null : resolved.error.code,
      ),
    );
  }
  profiles.sort((left, right) => left.reference.localeCompare(right.reference));
  return success(
    Object.freeze({
      contract_id: WORKTREE_PROFILE_CLI_CONTRACT_ID,
      schema_version: WORKTREE_PROFILE_CLI_SCHEMA_VERSION,
      command: "profile list",
      profiles: Object.freeze(profiles),
    }),
  );
}

/** Show one explicitly selected profile, resolving parameters through the canonical catalog resolver. */
export function showWorktreeProfile(
  profileReference: string,
  input: WorktreeProfileCliSources = {},
): DomainResult<WorktreeProfileCliShow> {
  const repositoryResult = sources(input);
  if (!repositoryResult.ok) return repositoryResult;
  const resolved = resolveSelectedProfile(profileReference, repositoryResult.value, undefined);
  if (!resolved.ok) return resolved;
  return success(
    Object.freeze({
      contract_id: WORKTREE_PROFILE_CLI_CONTRACT_ID,
      schema_version: WORKTREE_PROFILE_CLI_SCHEMA_VERSION,
      command: "profile show",
      source: resolved.value.source,
      profile: resolved.value.profile,
      availability: resolved.value.availability,
      ready: resolved.value.ready,
      missing: resolved.value.missing,
      collision: resolved.value.collision,
      readiness: readinessFor(
        resolved.value.profile,
        resolved.value.availability,
        resolved.value.ready,
        resolved.value.missing,
        input,
      ),
    }),
  );
}

/**
 * Resolve a parsed request against the supplied repository catalog.  Keeping
 * this boundary shared lets CLI and backend callers report unknown profiles
 * and parameters through one fail-closed resolver.
 */
export function resolveWorktreeProfileCliRequest(
  request: WorktreeProfileCliRequest,
  input: WorktreeProfileCliSources = {},
): DomainResult<WorktreeProfileCliList | WorktreeProfileCliShow | WorktreeProfileSessionCreateResolution> {
  if (request.command === "profile list") return listWorktreeProfiles(input);
  if (request.command === "profile show") return showWorktreeProfile(request.profile, input);
  return resolveWorktreeProfileSessionCreate(request, input);
}

/** Resolve the profile part of session-create while preserving omitted-profile compatibility. */
export function resolveWorktreeProfileSessionCreate(
  request: Extract<WorktreeProfileCliRequest, { readonly command: "session create" }>,
  input: WorktreeProfileCliSources = {},
): DomainResult<WorktreeProfileSessionCreateResolution> {
  if (request.profile === null) {
    if (request.parameters !== null) {
      return usage("INVALID_ARGUMENT", "--profile-parameter requires --profile.", { option: "--profile" });
    }
    return success(
      Object.freeze({
        contract_id: WORKTREE_PROFILE_CLI_CONTRACT_ID,
        schema_version: WORKTREE_PROFILE_CLI_SCHEMA_VERSION,
        command: "session create",
        profile: null,
      }),
    );
  }
  const repositoryResult = sources(input);
  if (!repositoryResult.ok) return repositoryResult;
  const parameters = request.parameters ?? {};
  const resolved = resolveSelectedProfile(request.profile, repositoryResult.value, parameters);
  if (!resolved.ok) return resolved;
  return success(
    Object.freeze({
      contract_id: WORKTREE_PROFILE_CLI_CONTRACT_ID,
      schema_version: WORKTREE_PROFILE_CLI_SCHEMA_VERSION,
      command: "session create",
      profile: Object.freeze({
        namespace: resolved.value.source.namespace,
        reference: resolved.value.source.reference,
        selection: Object.freeze({ profile: resolved.value.source.reference }),
        parameters,
        resolved: resolved.value.profile,
        availability: resolved.value.availability,
        ready: resolved.value.ready,
        missing: resolved.value.missing,
      }),
    }),
  );
}

/** Fail closed when a caller requires a profile that has not materialized. */
export function requireWorktreeProfileReady(
  resolution: WorktreeProfileSessionCreateResolution | WorktreeProfileCliShow,
): DomainResult<true> {
  if (resolution.command === "session create") {
    if (resolution.profile === null || resolution.profile.ready) return success(true);
    return failure(
      new DomainError("RUNTIME_MATERIALIZATION_MISSING", "The selected worktree profile is not ready.", {
        profile_id: resolution.profile.resolved.id,
        availability: resolution.profile.availability,
        missing: [...resolution.profile.missing],
      }),
    );
  }
  if (resolution.ready) return success(true);
  return failure(
    new DomainError("RUNTIME_MATERIALIZATION_MISSING", "The selected worktree profile is not ready.", {
      profile_id: resolution.source.id,
      availability: resolution.availability,
      missing: [...resolution.missing],
    }),
  );
}

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item));
  return record(value) && Object.values(value).every((item) => jsonValue(item));
}

/** Serialize CLI output under the stable `cli` document key. */
export function serializeWorktreeProfileCli(input: unknown): DomainResult<string> {
  if (!record(input) || !jsonValue(input)) {
    return profileInvalid("Worktree profile CLI output must be a JSON object.");
  }
  return success(JSON.stringify({ [WORKTREE_PROFILE_CLI_SERIALIZATION_KEY]: input }));
}

/** Serialize a validated profile declaration under the stable `contract` key. */
export function serializeWorktreeProfileContract(input: unknown): DomainResult<string> {
  const profile = validateWorktreeRuntimeProfile(input);
  if (!profile.ok) return failure(profile.error);
  return success(JSON.stringify({ [WORKTREE_PROFILE_CONTRACT_SERIALIZATION_KEY]: profile.value }));
}

/** JSON-safe descriptor consumed by the central CLI/contract integrator. */
export const WORKTREE_PROFILE_CLI_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: WORKTREE_PROFILE_CLI_CONTRACT_ID,
  schema_version: WORKTREE_PROFILE_CLI_SCHEMA_VERSION,
  serialization_keys: [WORKTREE_PROFILE_CLI_SERIALIZATION_KEY, WORKTREE_PROFILE_CONTRACT_SERIALIZATION_KEY],
  commands: ["session create", "profile list", "profile show"],
  options: ["--profile", "--profile-parameter"],
  namespaces: [BUILTIN_WORKTREE_PROFILE_NAMESPACE, "repository"],
  omitted_profile: "preserve-existing-bootstrap",
  unknown_profile: "RUNTIME_PROFILE_MISSING",
  unknown_parameter: "RUNTIME_PROFILE_INVALID",
  readiness: {
    legacy_ready: "material-resolution-only",
    fields: ["definition", "resolution", "material", "sandbox", "managed_execution", "bootstrap"],
    managed_authority: "LocalSessionBackend",
    sandbox_ready_is_sufficient_for_managed_bootstrap: false,
  },
});
