import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import type { RuntimeExecutableProvider } from "./runtime-projection.js";
import { validateWorktreeRuntimeProfile, type ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

/** Versioned identity of the session-private Git configuration producer. */
export const SESSION_GIT_CONFIG_CONTRACT_ID = "nawabari.session-git-config.v1" as const;
export const SESSION_GIT_CONFIG_SCHEMA_VERSION = 1 as const;

/** Versioned identity of the immutable hook material and hook-set producer. */
export const SESSION_HOOK_SET_CONTRACT_ID = "nawabari.session-hook-set.v1" as const;
export const SESSION_HOOK_SET_SCHEMA_VERSION = 1 as const;
export const SESSION_HOOK_MATERIAL_CONTRACT_ID = "nawabari.session-hook-material.v1" as const;
export const SESSION_HOOK_MATERIAL_SCHEMA_VERSION = 1 as const;

/** The serialization key belongs to the sandbox document, not to host Git. */
export const SANDBOX_SERIALIZATION_KEY = "sandbox" as const;
export const SESSION_GIT_HOOKS_PATH = "/nawabari/git/hooks" as const;
export const SESSION_GIT_DISABLED_HOOKS_PATH = "/dev/null" as const;
export const SESSION_GIT_HOOK_ENTRYPOINT = "nawabari-hook" as const;

export const GOVERNED_HOOK_EVENTS = Object.freeze([
  "pre-commit",
  "pre-push",
  "reference-transaction",
  "post-checkout",
] as const);

export type GovernedHookEvent = (typeof GOVERNED_HOOK_EVENTS)[number];
export type SessionGitIdentity = Readonly<{
  /** Repository-local identity observed from the authoritative worktree. */
  readonly repository_local_name?: string | null;
  readonly repository_local_email?: string | null;
  /** The two explicitly projected host-global identity values. */
  readonly host_global_name?: string | null;
  readonly host_global_email?: string | null;
}>;

export type SessionGitConfigValues = Readonly<{
  readonly "core.hooksPath": typeof SESSION_GIT_HOOKS_PATH | typeof SESSION_GIT_DISABLED_HOOKS_PATH;
  readonly "user.name"?: string;
  readonly "user.email"?: string;
}>;

export type SessionGitConfig = Readonly<{
  readonly contract_id: typeof SESSION_GIT_CONFIG_CONTRACT_ID;
  readonly schema_version: typeof SESSION_GIT_CONFIG_SCHEMA_VERSION;
  /** Only these keys are written to the private config file. */
  readonly config: SessionGitConfigValues;
  readonly global_config: "excluded";
  readonly system_config: "excluded";
  readonly credential_helpers: "disabled";
  readonly identity_source: Readonly<{
    readonly name: "repository-local" | "host-global" | "unset";
    readonly email: "repository-local" | "host-global" | "unset";
  }>;
}>;

/** A provider-backed immutable executable supplied by a selected runtime. */
export type SessionHookProviderMaterial = Readonly<{
  readonly kind: "provider";
  readonly provider: RuntimeExecutableProvider;
  /** Exact non-symlinked host source of the pinned provider executable. */
  readonly source: string;
  /** Exact namespace path used by protected execution. */
  readonly target: string;
  /** SHA-256 of source bytes, lower-case hexadecimal. */
  readonly digest: string;
}>;

/** A repository-tracked hook blob whose digest was separately approved. */
export type SessionHookTrackedBlobMaterial = Readonly<{
  readonly kind: "tracked-blob";
  /** Canonical repository-relative path represented by source. */
  readonly path: string;
  readonly source: string;
  /** Exact namespace path where the approved blob is visible. */
  readonly target: string;
  readonly digest: string;
}>;

export type SessionHookMaterial = SessionHookProviderMaterial | SessionHookTrackedBlobMaterial;

export type SessionHook = Readonly<{
  readonly event: GovernedHookEvent;
  /** The command is always an exact material target; it is never shell text. */
  readonly command: string;
  /** Event is the first fixed argv item; caller data is appended at execution. */
  readonly argv: readonly [GovernedHookEvent];
  readonly material: Readonly<{
    readonly kind: SessionHookMaterial["kind"];
    readonly source: string;
    readonly target: string;
    readonly digest: string;
    readonly provider?: RuntimeExecutableProvider;
    readonly path?: string;
  }>;
}>;

export type SessionHookSet = Readonly<{
  readonly contract_id: typeof SESSION_HOOK_SET_CONTRACT_ID;
  readonly schema_version: typeof SESSION_HOOK_SET_SCHEMA_VERSION;
  readonly mode: "disabled" | "governed";
  readonly hooks_path: typeof SESSION_GIT_HOOKS_PATH | typeof SESSION_GIT_DISABLED_HOOKS_PATH;
  readonly hooks: readonly SessionHook[];
}>;

export type GovernedHookRunnerOptions = Readonly<{
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout: number;
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "pipe"];
}>;

export type GovernedHookRunner = (
  command: string,
  argv: readonly string[],
  options: GovernedHookRunnerOptions,
) => SpawnSyncReturns<string>;

export type GovernedHookContext = Readonly<{
  readonly hook_set: SessionHookSet;
  readonly session_id: string;
  readonly cwd: string;
  /** Hook input is passed through stdin and is never interpolated into argv. */
  readonly stdin?: string;
  readonly argv?: readonly string[];
  /** Only explicitly supplied environment entries are passed to the hook. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly timeout_ms?: number;
  /** A hook is not allowed to run while the registry mutation lock is held. */
  readonly registry_lock_held?: boolean;
  /** Nested governed-hook invocation fails closed before spawning. */
  readonly hook_depth?: number;
  readonly runner?: GovernedHookRunner;
}>;

export type GovernedHookResult = Readonly<{
  readonly event: GovernedHookEvent;
  readonly executed: boolean;
  readonly exit_code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  /** post-checkout is observation-only; it never transfers session ownership. */
  readonly ownership_action: "none";
}>;

const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const HOOK_ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;
const TRACKED_SELECTOR = /^[A-Za-z0-9_.*?/@+:-]+$/u;
const MAX_IDENTITY_LENGTH = 1_024;
const MAX_HOOK_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_TIMEOUT_MS = 120_000;
const MAX_ARGUMENTS = 128;
const PROTECTED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "NAWABARI_GOVERNED_HOOK",
  "NAWABARI_HOOK_EVENT",
  "NAWABARI_HOOK_DEPTH",
  "NAWABARI_SESSION_ID",
]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_INVALID", `Session Git field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_AMBIGUOUS", `Session Git field '${field}' is ambiguous: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function executionFailure(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("GIT_OPERATION_FAILED", message, details));
}

function assertKeys(value: UnknownRecord, allowed: readonly string[], field: string): DomainResult<null> {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) return invalid(`${field}.${key}`, "unknown fields are not supported");
  }
  return success(null);
}

function boundedText(value: unknown, field: string, maxLength = MAX_IDENTITY_LENGTH): DomainResult<string> {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.includes("\u0000") ||
    [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
  ) {
    return invalid(field, "expected bounded text without control characters");
  }
  return success(value.normalize("NFC"));
}

function optionalIdentity(value: unknown, field: string): DomainResult<string | null | undefined> {
  if (value === undefined || value === null) return success(value);
  return boundedText(value, field);
}

function validateIdentity(input: unknown): DomainResult<SessionGitIdentity> {
  if (!isRecord(input)) return invalid("identity", "expected an identity object");
  const keys = assertKeys(
    input,
    ["repository_local_name", "repository_local_email", "host_global_name", "host_global_email"],
    "identity",
  );
  if (!keys.ok) return keys;
  const localName = optionalIdentity(input.repository_local_name, "identity.repository_local_name");
  if (!localName.ok) return localName;
  const localEmail = optionalIdentity(input.repository_local_email, "identity.repository_local_email");
  if (!localEmail.ok) return localEmail;
  const globalName = optionalIdentity(input.host_global_name, "identity.host_global_name");
  if (!globalName.ok) return globalName;
  const globalEmail = optionalIdentity(input.host_global_email, "identity.host_global_email");
  if (!globalEmail.ok) return globalEmail;
  return success(
    Object.freeze({
      ...(localName.value === undefined ? {} : { repository_local_name: localName.value }),
      ...(localEmail.value === undefined ? {} : { repository_local_email: localEmail.value }),
      ...(globalName.value === undefined ? {} : { host_global_name: globalName.value }),
      ...(globalEmail.value === undefined ? {} : { host_global_email: globalEmail.value }),
    }),
  );
}

function identityValue(
  local: string | null | undefined,
  global: string | null | undefined,
): Readonly<{ value: string | undefined; source: "repository-local" | "host-global" | "unset" }> {
  if (local !== undefined && local !== null && local.length > 0) {
    return { value: local, source: "repository-local" };
  }
  if (global !== undefined && global !== null && global.length > 0) {
    return { value: global, source: "host-global" };
  }
  return { value: undefined, source: "unset" };
}

function canonicalAbsolute(value: unknown, field: string, allowRoot = false): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000") || !path.posix.isAbsolute(value)) {
    return invalid(field, "expected an absolute POSIX path", typeof value === "string" ? value : undefined);
  }
  if (path.posix.normalize(value) !== value || (!allowRoot && value === "/")) {
    return invalid(field, "path must be canonical and normalized", value);
  }
  return success(value);
}

function canonicalTarget(value: unknown, field: string): DomainResult<string> {
  const target = canonicalAbsolute(value, field);
  if (!target.ok) return target;
  if (!target.value.startsWith("/nawabari/")) {
    return invalid(field, "hook targets must remain inside the Nawabari namespace", target.value);
  }
  return target;
}

function canonicalTrackedPath(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return invalid(field, "expected a repository-relative path");
  }
  if (
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value.startsWith("../") ||
    value.includes("\\") ||
    value.split("/").some((part) => part === "." || part === ".." || part.length === 0) ||
    !TRACKED_SELECTOR.test(value)
  ) {
    return invalid(field, "expected a normalized repository-relative tracked path", value);
  }
  return success(value);
}

function digest(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !SHA256.test(value)) return invalid(field, "expected a lower-case SHA-256 digest");
  return success(value);
}

function provider(value: unknown, field: string): DomainResult<RuntimeExecutableProvider> {
  if (!isRecord(value)) return invalid(field, "expected a provider identity");
  const keys = assertKeys(value, ["id", "requirement_id"], field);
  if (!keys.ok) return keys;
  if (typeof value.id !== "string" || !STABLE_IDENTIFIER.test(value.id)) {
    return invalid(`${field}.id`, "expected a stable provider id");
  }
  if (typeof value.requirement_id !== "string" || !STABLE_IDENTIFIER.test(value.requirement_id)) {
    return invalid(`${field}.requirement_id`, "expected a stable requirement id");
  }
  return success(Object.freeze({ id: value.id, requirement_id: value.requirement_id }));
}

function currentDigest(source: string, field: string, requireExecutable: boolean): DomainResult<string> {
  try {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) return invalid(field, "material must not be a symbolic link", source);
    if (!stat.isFile()) return invalid(field, "material must be a regular file", source);
    if (stat.size > MAX_HOOK_BYTES) return invalid(field, "material exceeds the bounded hook size", source);
    if (requireExecutable && (stat.mode & 0o111) === 0) {
      return invalid(field, "material must be executable", source);
    }
    if (fs.realpathSync.native(source) !== source) return invalid(field, "material resolves through a symlink", source);
    return success(createHash("sha256").update(fs.readFileSync(source)).digest("hex"));
  } catch {
    return invalid(field, "material is missing or unreadable", source);
  }
}

function validateHookMaterial(input: unknown): DomainResult<SessionHookMaterial> {
  if (!isRecord(input)) return invalid("material", "expected an immutable hook material object");
  if (input.kind === "provider") {
    const keys = assertKeys(input, ["kind", "provider", "source", "target", "digest", "events"], "material");
    if (!keys.ok) return keys;
    const identity = provider(input.provider, "material.provider");
    if (!identity.ok) return identity;
    const source = canonicalAbsolute(input.source, "material.source");
    if (!source.ok) return source;
    const target = canonicalTarget(input.target, "material.target");
    if (!target.ok) return target;
    const expected = digest(input.digest, "material.digest");
    if (!expected.ok) return expected;
    const actual = currentDigest(source.value, "material.source", true);
    if (!actual.ok) return actual;
    if (actual.value !== expected.value) {
      return ambiguous("material.digest", "provider bytes do not match the approved digest", source.value);
    }
    return success(
      Object.freeze({
        kind: "provider",
        provider: identity.value,
        source: source.value,
        target: target.value,
        digest: expected.value,
      }),
    );
  }
  if (input.kind === "tracked-blob") {
    const keys = assertKeys(input, ["kind", "path", "source", "target", "digest", "events"], "material");
    if (!keys.ok) return keys;
    const trackedPath = canonicalTrackedPath(input.path, "material.path");
    if (!trackedPath.ok) return trackedPath;
    const source = canonicalAbsolute(input.source, "material.source");
    if (!source.ok) return source;
    const target = canonicalTarget(input.target, "material.target");
    if (!target.ok) return target;
    const expected = digest(input.digest, "material.digest");
    if (!expected.ok) return expected;
    const actual = currentDigest(source.value, "material.source", true);
    if (!actual.ok) return actual;
    if (actual.value !== expected.value) {
      return ambiguous("material.digest", "tracked blob bytes do not match the approved digest", source.value);
    }
    return success(
      Object.freeze({
        kind: "tracked-blob",
        path: trackedPath.value,
        source: source.value,
        target: target.value,
        digest: expected.value,
      }),
    );
  }
  return invalid("material.kind", "expected provider or tracked-blob");
}

function validateEventList(input: unknown): DomainResult<readonly GovernedHookEvent[]> {
  if (input === undefined) return success(GOVERNED_HOOK_EVENTS);
  if (!Array.isArray(input) || input.length === 0 || input.length > GOVERNED_HOOK_EVENTS.length) {
    return invalid("material.events", "expected a bounded non-empty event list");
  }
  const events: GovernedHookEvent[] = [];
  for (const [index, value] of input.entries()) {
    if (!GOVERNED_HOOK_EVENTS.includes(value as GovernedHookEvent)) {
      return invalid(`material.events[${index}]`, "expected a supported Git hook event");
    }
    const event = value as GovernedHookEvent;
    if (events.includes(event)) return ambiguous("material.events", "duplicate hook event", event);
    events.push(event);
  }
  return success(Object.freeze([...events].sort()));
}

function validateProfile(input: unknown): DomainResult<ResolvedWorktreeRuntimeProfile> {
  const profile = validateWorktreeRuntimeProfile(input);
  return profile.ok ? profile : failure(profile.error);
}

/**
 * Materialize only the bounded Git configuration owned by a Nawabari session.
 * Local identity wins independently for each key; no other Git configuration
 * source is read or copied.
 */
export function materializeSessionGitConfig(
  profileInput: unknown,
  identityInput: unknown,
): DomainResult<SessionGitConfig> {
  const profile = validateProfile(profileInput);
  if (!profile.ok) return profile;
  const identity = validateIdentity(identityInput);
  if (!identity.ok) return identity;
  const name = identityValue(identity.value.repository_local_name, identity.value.host_global_name);
  const email = identityValue(identity.value.repository_local_email, identity.value.host_global_email);
  const config: Record<string, string> = {
    "core.hooksPath": profile.value.git.hooks === "governed" ? SESSION_GIT_HOOKS_PATH : SESSION_GIT_DISABLED_HOOKS_PATH,
  };
  if (name.value !== undefined) config["user.name"] = name.value;
  if (email.value !== undefined) config["user.email"] = email.value;
  return success(
    Object.freeze({
      contract_id: SESSION_GIT_CONFIG_CONTRACT_ID,
      schema_version: SESSION_GIT_CONFIG_SCHEMA_VERSION,
      config: Object.freeze(config) as SessionGitConfigValues,
      global_config: "excluded",
      system_config: "excluded",
      credential_helpers: "disabled",
      identity_source: Object.freeze({ name: name.source, email: email.source }),
    }),
  );
}

/**
 * Resolve a deterministic set of event-specific argv bindings. The material
 * must be immutable and digest-pinned before a command can be admitted.
 */
export function resolveSessionHookSet(profileInput: unknown, materialInput: unknown): DomainResult<SessionHookSet> {
  const profile = validateProfile(profileInput);
  if (!profile.ok) return profile;
  if (profile.value.git.hooks === "disabled") {
    return success(
      Object.freeze({
        contract_id: SESSION_HOOK_SET_CONTRACT_ID,
        schema_version: SESSION_HOOK_SET_SCHEMA_VERSION,
        mode: "disabled",
        hooks_path: SESSION_GIT_DISABLED_HOOKS_PATH,
        hooks: Object.freeze([]),
      }),
    );
  }
  if (!isRecord(materialInput)) return invalid("material", "governed hooks require approved immutable material");
  const material = validateHookMaterial(materialInput);
  if (!material.ok) return material;
  const events = validateEventList(materialInput.events);
  if (!events.ok) return events;
  const hooks = events.value.map((event) =>
    Object.freeze({
      event,
      command: material.value.target,
      argv: Object.freeze([event]) as readonly [GovernedHookEvent],
      material: Object.freeze({
        kind: material.value.kind,
        source: material.value.source,
        target: material.value.target,
        digest: material.value.digest,
        ...(material.value.kind === "provider" ? { provider: material.value.provider } : { path: material.value.path }),
      }),
    }),
  );
  return success(
    Object.freeze({
      contract_id: SESSION_HOOK_SET_CONTRACT_ID,
      schema_version: SESSION_HOOK_SET_SCHEMA_VERSION,
      mode: "governed",
      hooks_path: SESSION_GIT_HOOKS_PATH,
      hooks: Object.freeze(hooks),
    }),
  );
}

function validateHookSet(input: unknown): DomainResult<SessionHookSet> {
  if (!isRecord(input)) return invalid("hook_set", "expected a canonical hook set");
  const keys = assertKeys(input, ["contract_id", "schema_version", "mode", "hooks_path", "hooks"], "hook_set");
  if (!keys.ok) return keys;
  if (input.contract_id !== SESSION_HOOK_SET_CONTRACT_ID || input.schema_version !== SESSION_HOOK_SET_SCHEMA_VERSION) {
    return invalid("hook_set", "contract identity is not canonical");
  }
  if (input.mode !== "disabled" && input.mode !== "governed") {
    return invalid("hook_set.mode", "expected disabled or governed");
  }
  if (!Array.isArray(input.hooks)) return invalid("hook_set.hooks", "expected an array");
  if (input.mode === "disabled") {
    if (input.hooks.length !== 0 || input.hooks_path !== SESSION_GIT_DISABLED_HOOKS_PATH) {
      return ambiguous("hook_set", "disabled sets cannot carry executable hooks");
    }
    return success(
      Object.freeze({
        contract_id: SESSION_HOOK_SET_CONTRACT_ID,
        schema_version: SESSION_HOOK_SET_SCHEMA_VERSION,
        mode: "disabled",
        hooks_path: SESSION_GIT_DISABLED_HOOKS_PATH,
        hooks: Object.freeze([]),
      }),
    );
  }
  if (input.hooks_path !== SESSION_GIT_HOOKS_PATH || input.hooks.length === 0) {
    return invalid("hook_set", "governed sets require the Nawabari hooks path and at least one hook");
  }
  const events = new Set<GovernedHookEvent>();
  const hooks: SessionHook[] = [];
  for (const hook of input.hooks) {
    if (!isRecord(hook) || !GOVERNED_HOOK_EVENTS.includes(hook.event as GovernedHookEvent)) {
      return invalid("hook_set.hooks", "expected supported hook entries");
    }
    const hookKeys = assertKeys(hook, ["event", "command", "argv", "material"], "hook_set.hooks");
    if (!hookKeys.ok) return hookKeys;
    const event = hook.event as GovernedHookEvent;
    if (events.has(event)) return ambiguous("hook_set.hooks", "duplicate hook event", event);
    const command = canonicalTarget(hook.command, "hook_set.hooks.command");
    if (!command.ok) return command;
    if (!Array.isArray(hook.argv) || hook.argv.length !== 1 || hook.argv[0] !== event) {
      return invalid("hook_set.hooks.argv", "must contain exactly the fixed event argument", event);
    }
    const material = validateHookMaterial(hook.material);
    if (!material.ok) return material;
    if (material.value.target !== command.value) {
      return ambiguous("hook_set.hooks.command", "command does not match the approved material target", command.value);
    }
    events.add(event);
    hooks.push(
      Object.freeze({
        event,
        command: command.value,
        argv: Object.freeze([event]) as readonly [GovernedHookEvent],
        material: Object.freeze({
          kind: material.value.kind,
          source: material.value.source,
          target: material.value.target,
          digest: material.value.digest,
          ...(material.value.kind === "provider"
            ? { provider: material.value.provider }
            : { path: material.value.path }),
        }),
      }),
    );
  }
  return success(
    Object.freeze({
      contract_id: SESSION_HOOK_SET_CONTRACT_ID,
      schema_version: SESSION_HOOK_SET_SCHEMA_VERSION,
      mode: "governed",
      hooks_path: SESSION_GIT_HOOKS_PATH,
      hooks: Object.freeze(hooks),
    }),
  );
}

function safeOutput(value: string | Buffer | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : value.toString("utf8");
  return Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES
    ? text
    : `${Buffer.from(text, "utf8").subarray(0, MAX_OUTPUT_BYTES).toString("utf8")}\n[output truncated]`;
}

function defaultRunner(
  command: string,
  argv: readonly string[],
  options: GovernedHookRunnerOptions,
): SpawnSyncReturns<string> {
  return spawnSync(command, [...argv], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    timeout: options.timeout,
    shell: false,
    stdio: options.stdio,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
  });
}

function validHookArgument(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.includes("\u0000") || value.length > 8 * 1024) {
    return invalid(field, "expected bounded text without NUL bytes");
  }
  return success(value);
}

function validateHookContext(input: GovernedHookContext): DomainResult<GovernedHookContext> {
  if (!isRecord(input)) return invalid("context", "expected an execution context");
  const hookSet = validateHookSet(input.hook_set);
  if (!hookSet.ok) return hookSet;
  const sessionId = boundedText(input.session_id, "context.session_id", 256);
  if (!sessionId.ok) return sessionId;
  const cwd = canonicalAbsolute(input.cwd, "context.cwd");
  if (!cwd.ok) return cwd;
  if (input.stdin !== undefined) {
    const stdin = validHookArgument(input.stdin, "context.stdin");
    if (!stdin.ok) return stdin;
  }
  if (input.argv !== undefined) {
    if (!Array.isArray(input.argv) || input.argv.length > MAX_ARGUMENTS) {
      return invalid("context.argv", "expected a bounded argument list");
    }
    for (const [index, argument] of input.argv.entries()) {
      const parsed = validHookArgument(argument, `context.argv[${index}]`);
      if (!parsed.ok) return parsed;
    }
  }
  if (input.timeout_ms !== undefined && (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms <= 0)) {
    return invalid("context.timeout_ms", "expected a positive safe integer");
  }
  if (input.hook_depth !== undefined && (!Number.isSafeInteger(input.hook_depth) || input.hook_depth < 0)) {
    return invalid("context.hook_depth", "expected a non-negative safe integer");
  }
  if (input.environment !== undefined) {
    if (!isRecord(input.environment)) return invalid("context.environment", "expected explicit environment entries");
    for (const [key, value] of Object.entries(input.environment)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key))
        return invalid("context.environment", "environment key is invalid", key);
      if (PROTECTED_ENVIRONMENT_KEYS.has(key)) {
        return invalid("context.environment", "protected environment keys cannot be overridden", key);
      }
      const parsed = validHookArgument(value, `context.environment.${key}`);
      if (!parsed.ok) return parsed;
    }
  }
  return success(input);
}

function revalidateMaterial(hook: SessionHook): DomainResult<null> {
  const current = currentDigest(hook.material.source, "hook.material.source", true);
  if (!current.ok) return current;
  if (current.value !== hook.material.digest) {
    return ambiguous("hook.material.digest", "hook material changed after resolution", hook.material.source);
  }
  return success(null);
}

/**
 * Execute one already-resolved hook with a direct command and argv. No Git or
 * registry lock is acquired here. A caller holding that lock is rejected so
 * a hook failure cannot turn into a nested-lock deadlock or second authority
 * decision. post-checkout is deliberately observation-only.
 */
export function runGovernedHook(
  event: GovernedHookEvent,
  contextInput: GovernedHookContext,
): DomainResult<GovernedHookResult> {
  if (!GOVERNED_HOOK_EVENTS.includes(event)) return invalid("event", "expected a supported Git hook event", event);
  const context = validateHookContext(contextInput);
  if (!context.ok) return context;
  if (context.value.registry_lock_held === true || (context.value.hook_depth ?? 0) > 0) {
    return failure(
      new DomainError("LOCK_CONTENTION", "Governed hooks cannot run while a registry mutation is locked or nested.", {
        event,
        session_id: context.value.session_id,
        registry_lock_held: context.value.registry_lock_held === true,
        hook_depth: context.value.hook_depth ?? 0,
      }),
    );
  }
  if (context.value.hook_set.mode === "disabled") {
    return success({
      event,
      executed: false,
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      ownership_action: "none",
    });
  }
  const hook = context.value.hook_set.hooks.find((candidate) => candidate.event === event);
  if (hook === undefined) {
    return success({
      event,
      executed: false,
      exit_code: null,
      signal: null,
      stdout: "",
      stderr: "",
      ownership_action: "none",
    });
  }
  const material = revalidateMaterial(hook);
  if (!material.ok) return material;
  const suppliedArguments = context.value.argv ?? [];
  const env: NodeJS.ProcessEnv = {
    ...(context.value.environment ?? {}),
    PATH: "/nawabari/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    NAWABARI_GOVERNED_HOOK: "1",
    NAWABARI_HOOK_EVENT: event,
    NAWABARI_HOOK_DEPTH: "1",
    NAWABARI_SESSION_ID: context.value.session_id,
  };
  const timeout = Math.min(context.value.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS);
  let result: SpawnSyncReturns<string>;
  try {
    result = (context.value.runner ?? defaultRunner)(hook.command, [...hook.argv, ...suppliedArguments], {
      cwd: context.value.cwd,
      env,
      input: context.value.stdin,
      timeout,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    return executionFailure("Governed hook execution failed before the process completed.", {
      event,
      session_id: context.value.session_id,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  if (result.error !== undefined) {
    return executionFailure("Governed hook execution failed.", {
      event,
      session_id: context.value.session_id,
      reason: result.error.message.slice(0, 200),
    });
  }
  const stdout = safeOutput(result.stdout);
  const stderr = safeOutput(result.stderr);
  const exitCode = result.status ?? null;
  const signal = result.signal ?? null;
  const response = Object.freeze({
    event,
    executed: true,
    exit_code: exitCode,
    signal,
    stdout,
    stderr,
    ownership_action: "none" as const,
  });
  if (exitCode !== 0 || signal !== null) {
    return failure(
      new DomainError("GIT_OPERATION_FAILED", `Governed ${event} hook rejected the Git operation.`, {
        event,
        session_id: context.value.session_id,
        exit_code: exitCode,
        signal,
        stderr,
      }),
    );
  }
  return success(response);
}

function validateSessionGitConfig(input: unknown): DomainResult<SessionGitConfig> {
  if (!isRecord(input)) return invalid("config", "expected a materialized session Git config");
  const keys = assertKeys(
    input,
    [
      "contract_id",
      "schema_version",
      "config",
      "global_config",
      "system_config",
      "credential_helpers",
      "identity_source",
    ],
    "config",
  );
  if (!keys.ok) return keys;
  if (
    input.contract_id !== SESSION_GIT_CONFIG_CONTRACT_ID ||
    input.schema_version !== SESSION_GIT_CONFIG_SCHEMA_VERSION
  ) {
    return invalid("config", "contract identity is not canonical");
  }
  if (input.global_config !== "excluded" || input.system_config !== "excluded") {
    return invalid("config", "host and system Git configuration must remain excluded");
  }
  if (input.credential_helpers !== "disabled") {
    return invalid("config", "credential helpers must remain disabled");
  }
  if (!isRecord(input.config)) return invalid("config.config", "expected an explicit Git key allowlist");
  const configKeys = assertKeys(input.config, ["core.hooksPath", "user.name", "user.email"], "config.config");
  if (!configKeys.ok) return configKeys;
  if (
    input.config["core.hooksPath"] !== SESSION_GIT_HOOKS_PATH &&
    input.config["core.hooksPath"] !== SESSION_GIT_DISABLED_HOOKS_PATH
  ) {
    return invalid("config.config.core.hooksPath", "expected the canonical session or disabled hooks path");
  }
  const name =
    input.config["user.name"] === undefined
      ? success<string | undefined>(undefined)
      : boundedText(input.config["user.name"], "config.config.user.name");
  if (!name.ok) return name;
  const email =
    input.config["user.email"] === undefined
      ? success<string | undefined>(undefined)
      : boundedText(input.config["user.email"], "config.config.user.email");
  if (!email.ok) return email;
  if (!isRecord(input.identity_source))
    return invalid("config.identity_source", "expected per-key identity provenance");
  const identityKeys = assertKeys(input.identity_source, ["name", "email"], "config.identity_source");
  if (!identityKeys.ok) return identityKeys;
  const identitySources = ["repository-local", "host-global", "unset"] as const;
  if (!identitySources.includes(input.identity_source.name as (typeof identitySources)[number])) {
    return invalid("config.identity_source.name", "expected a canonical identity source");
  }
  if (!identitySources.includes(input.identity_source.email as (typeof identitySources)[number])) {
    return invalid("config.identity_source.email", "expected a canonical identity source");
  }
  const canonicalConfig: Record<string, string> = { "core.hooksPath": input.config["core.hooksPath"] as string };
  if (name.value !== undefined) canonicalConfig["user.name"] = name.value;
  if (email.value !== undefined) canonicalConfig["user.email"] = email.value;
  return success(
    Object.freeze({
      contract_id: SESSION_GIT_CONFIG_CONTRACT_ID,
      schema_version: SESSION_GIT_CONFIG_SCHEMA_VERSION,
      config: Object.freeze(canonicalConfig) as SessionGitConfigValues,
      global_config: "excluded",
      system_config: "excluded",
      credential_helpers: "disabled",
      identity_source: Object.freeze({
        name: input.identity_source.name as "repository-local" | "host-global" | "unset",
        email: input.identity_source.email as "repository-local" | "host-global" | "unset",
      }),
    }),
  );
}

/** Serialize the canonical session-private Git projection under `sandbox`. */
export function serializeSessionGitConfig(input: unknown): DomainResult<string> {
  const config = validateSessionGitConfig(input);
  return config.ok ? success(JSON.stringify({ [SANDBOX_SERIALIZATION_KEY]: config.value })) : config;
}

/** JSON-safe contract descriptor for architecture and public-state consumers. */
export const SESSION_GIT_HOOKS_DESCRIPTOR: JsonObject = Object.freeze({
  config_contract_id: SESSION_GIT_CONFIG_CONTRACT_ID,
  config_schema_version: SESSION_GIT_CONFIG_SCHEMA_VERSION,
  hook_set_contract_id: SESSION_HOOK_SET_CONTRACT_ID,
  hook_set_schema_version: SESSION_HOOK_SET_SCHEMA_VERSION,
  serialization_key: SANDBOX_SERIALIZATION_KEY,
  hooks_path: SESSION_GIT_HOOKS_PATH,
  disabled_hooks_path: SESSION_GIT_DISABLED_HOOKS_PATH,
  events: [...GOVERNED_HOOK_EVENTS],
  config_keys: ["core.hooksPath", "user.name", "user.email"],
  exclusions: ["host/global Git config", "system Git config", "credential helpers", "aliases", "ambient hooks"],
  execution: {
    command_resolution: "immutable material target",
    argv: "event plus explicit caller arguments",
    shell: false,
    registry_authority: "existing guard/authorize path",
    post_checkout_ownership: "observation-only",
  },
});
