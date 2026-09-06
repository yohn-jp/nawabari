import { createRequire } from "node:module";
import { runDoctor } from "./domain/doctor.js";
import { DomainError, EXIT_CODES, failure, type DomainResult, type JsonObject } from "./domain/errors.js";
import {
  type GarbageCollectOptions,
  type CheckpointOptions,
  type RepositoryDiffOptions,
  type RepositoryEvidenceOptions,
  type OperationAuthorizationOptions,
  type SessionBackend,
  type SessionCloseOptions,
  type SessionContext,
  type SessionCreateOptions,
  type SessionDiagnosticOptions,
  type SessionListOptions,
  type ClaimDeltasOptions,
  type ReleaseClaimsOptions,
  type ResourceClaimDelta,
  DEFAULT_SESSION_LIST_LIMIT,
  MAX_SESSION_LIST_LIMIT,
} from "./domain/session.js";
import { EVIDENCE_MAX_DIFF_BYTES, EVIDENCE_MAX_DIFF_HUNKS, EVIDENCE_MAX_DIFF_PATHS } from "./repository-evidence.js";
import { isResourceClaimMode } from "./resource-claims.js";
import { createLocalSessionBackend } from "./domain/session-backend.js";
import { defaultCliIO, renderFailure, renderSuccess, type CliIO, type CliMode } from "./presentation.js";
import { MACHINE_CONTRACT_ID, MACHINE_CONTRACT_SCHEMA_VERSION, machineContract } from "./contract.js";
import {
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  type SandboxCommand,
  type SandboxExecutionResult,
  type SandboxProbe,
  type SandboxRuntimeLayout,
} from "./domain/sandbox.js";

const CLI_NAME = "nawabari";
const packageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = packageMetadata.version;

import {
  CLI_COMMAND_REGISTRY,
  COMMAND_REGISTRY,
  GLOBAL_HELP_OPTIONS,
  ROOT_HELP_SPEC,
  publicCliCommandDefinitions,
  publicCliCommandNames,
  resolveCliCommandDefinition,
  canonicalCommandForName,
  type CliCommandDefinition,
  type CliHelpOptionSpec,
} from "./cli-command-registry.js";

export {
  CLI_COMMAND_REGISTRY,
  COMMAND_REGISTRY,
  publicCliCommandDefinitions,
  publicCliCommandNames,
  resolveCliCommandDefinition,
  canonicalCommandForName,
} from "./cli-command-registry.js";
export type { CliCommandDefinition, CliHelpOptionSpec } from "./cli-command-registry.js";

/**
 * The dispatcher deliberately keeps its command branches specialized, but
 * this inventory makes the executable surface explicit for structural parity
 * checks. Aliases are listed because they are public entry points too.
 */
export const DISPATCHER_COMMAND_INVENTORY = [
  "session create",
  "session id",
  "session show",
  "session inspect",
  "session run",
  "session exec",
  "session list",
  "session claim",
  "resource claim",
  "session update",
  "resource update",
  "session mutate",
  "resource mutate",
  "session transition",
  "resource transition",
  "session claims",
  "resource list",
  "resource claims",
  "session release",
  "resource release",
  "session close",
  "session discard",
  "authorize",
  "checkpoint",
  "evidence snapshot",
  "diff",
  "commit",
  "push",
  "status",
  "guard",
  "gc",
  "doctor",
  "migrate",
  "capabilities",
] as const;

/** Dispatcher option inventory, keyed by canonical registry command identity. */
export const DISPATCHER_OPTION_INVENTORY: Readonly<Record<string, readonly string[]>> = {
  "session create": ["--branch", "--worktree", "--worktree-root", "--base", "--label"],
  "session id": [],
  "session show": ["--session"],
  "session inspect": ["--session", "--integrated-revision"],
  "session run": ["--session"],
  "session list": ["--all", "--history", "--limit", "--offset"],
  "session claim": ["--resource", "--mode", "--session", "--repository"],
  "session update": ["--resource", "--mode", "--if-generation", "--force", "--session", "--repository"],
  "session mutate": [
    "--upsert-resource",
    "--mode",
    "--release-resource",
    "--if-generation",
    "--force",
    "--session",
    "--repository",
  ],
  "session transition": ["--resource", "--mode", "--if-generation", "--force", "--session", "--repository"],
  "session claims": ["--session"],
  "session release": ["--session", "--resource", "--claim-id", "--all", "--if-generation", "--force"],
  "session close": ["--session", "--integrated-revision", "--fetch-remote", "--fetch-branch"],
  "session discard": ["--session"],
  authorize: ["--session", "--operation", "--resource"],
  checkpoint: ["--session"],
  "evidence snapshot": ["--session"],
  diff: ["--session", "--path", "--from", "--to", "--patch", "--max-bytes", "--max-hunks"],
  commit: ["--session", "--message", "--resource", "--message-pattern"],
  push: ["--session", "--resource", "--remote", "--branch", "--remote-branch", "--force", "--create-upstream"],
  status: ["--all", "--history", "--limit", "--offset"],
  guard: ["--session", "--operation", "--resource"],
  gc: ["--apply", "--dry-run"],
  doctor: [],
  migrate: [],
  capabilities: [],
};

function optionNames(definition: CliCommandDefinition): readonly string[] {
  return definition.options.flatMap((candidate) => [candidate.name, ...(candidate.aliases ?? [])]);
}

function canonicalName(name: string): string | undefined {
  return CLI_COMMAND_REGISTRY.find((definition) => definition.name === name || definition.aliases?.includes(name))
    ?.name;
}

/** Return the registry-backed option set used by a specialized dispatcher parser. */
export function dispatcherAllowedOptions(command: string): ReadonlySet<string> {
  const canonical = canonicalName(command);
  if (canonical === undefined) throw new Error(`Dispatcher command is not registered: ${command}`);
  return new Set(DISPATCHER_OPTION_INVENTORY[canonical] ?? []);
}

/**
 * Verify both executable command/option inventory and registry metadata. This
 * is intentionally structural: parser semantics remain in their command
 * handlers, while drift becomes a deterministic failure in tests/startup.
 */
export function validateCliRegistryParity(): void {
  const publicNames = publicCliCommandNames();
  const publicSet = new Set(publicNames);
  const dispatcherSet = new Set<string>(DISPATCHER_COMMAND_INVENTORY);
  const missingFromDispatcher = publicNames.filter((name) => !dispatcherSet.has(name));
  const missingFromRegistry = DISPATCHER_COMMAND_INVENTORY.filter((name) => !publicSet.has(name));
  if (missingFromDispatcher.length > 0 || missingFromRegistry.length > 0) {
    throw new Error(
      `CLI command registry parity failure: missing_from_dispatcher=${missingFromDispatcher.join(",")}; ` +
        `missing_from_registry=${missingFromRegistry.join(",")}`,
    );
  }

  for (const name of publicNames) {
    const canonical = canonicalName(name);
    if (canonical === undefined) throw new Error(`CLI command registry cannot resolve ${name}`);
    const expected = new Set(DISPATCHER_OPTION_INVENTORY[canonical] ?? []);
    const actual = new Set(optionNames(resolveCliCommandDefinition(name) as CliCommandDefinition));
    const missing = [...actual].filter((option) => !expected.has(option));
    const extra = [...expected].filter((option) => !actual.has(option));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `CLI option registry parity failure for ${name}: missing_from_dispatcher=${missing.join(",")}; ` +
          `missing_from_registry=${extra.join(",")}`,
      );
    }
  }
}

validateCliRegistryParity();

function helpSpecFor(commandArguments: readonly string[]): CliCommandDefinition {
  if (commandArguments.length === 0) return ROOT_HELP_SPEC;
  const key =
    commandArguments[0] === "resource"
      ? `resource ${commandArguments[1] ?? "list"}`
      : commandArguments.slice(0, 2).join(" ");
  return resolveCliCommandDefinition(key) ?? resolveCliCommandDefinition(commandArguments[0]) ?? ROOT_HELP_SPEC;
}

function helpPayload(spec: CliCommandDefinition): JsonObject {
  if (spec.name === "root") {
    const publicCommands = publicCliCommandDefinitions();
    const optionNames = (options: readonly CliHelpOptionSpec[]): string[] => options.map((candidate) => candidate.name);
    const sessionOptions = publicCommands
      .filter((command) => command.name.startsWith("session "))
      .flatMap((command) => command.options);
    const unique = (values: string[]): string[] => values.filter((value, index) => values.indexOf(value) === index);
    const sessionListOnlyOptions = new Set(["--all", "--history"]);
    const sessionTargetingCommands = CLI_COMMAND_REGISTRY.filter(
      (command) => command.name.startsWith("session ") && command.usage.includes("<session"),
    ).map((command) => command.name.slice("session ".length));
    const optionsFor = (name: string): string[] =>
      optionNames(publicCommands.find((command) => command.name === name)?.options ?? []);
    return {
      usage: `Usage: ${spec.usage}`,
      commands: publicCommands.map((command) => command.name),
      options: GLOBAL_HELP_OPTIONS.map((candidate) => candidate.name),
      session_options: unique(
        sessionOptions.map((option) => option.name).filter((name) => !sessionListOnlyOptions.has(name)),
      ),
      authorization_options: optionsFor("authorize"),
      checkpoint_options: optionsFor("checkpoint"),
      commit_options: optionsFor("commit"),
      push_options: optionsFor("push"),
      gc_options: optionsFor("gc"),
      session_targeting: {
        canonical: "--session <id>",
        positional_alias: "<session-id> as the first argument after a session-scoped subcommand",
        commands: sessionTargetingCommands,
        ambiguity: "supplying both positional and --session is rejected",
        discard_requires_explicit_target: true,
      },
    };
  }
  const options = spec.options.map((candidate) => ({
    name: candidate.name,
    ...(candidate.aliases === undefined ? {} : { aliases: [...candidate.aliases] }),
    ...(candidate.alias_of === undefined ? {} : { alias_of: candidate.alias_of }),
    ...(candidate.value === undefined ? {} : { value: candidate.value }),
    required: candidate.required === true,
    ...(candidate.repeatable === undefined ? {} : { repeatable: candidate.repeatable }),
    ...(candidate.default === undefined ? {} : { default: candidate.default }),
    ...(candidate.minimum === undefined ? {} : { minimum: candidate.minimum }),
    ...(candidate.maximum === undefined ? {} : { maximum: candidate.maximum }),
    description: candidate.description,
  }));
  const canonical = canonicalCommandForName(spec.name);
  return {
    help_for: spec.name,
    ...(canonical === undefined || canonical.name === spec.name ? {} : { canonical_command: canonical.name }),
    ...(canonical?.aliases === undefined || canonical.name !== spec.name ? {} : { aliases: [...canonical.aliases] }),
    usage: spec.usage,
    summary: spec.summary,
    required_options: spec.options
      .filter((candidate) => candidate.required === true)
      .map((candidate) => candidate.name),
    optional_options: spec.options
      .filter((candidate) => candidate.required !== true)
      .map((candidate) => candidate.name),
    defaults: Object.fromEntries(
      spec.options
        .filter((candidate) => candidate.default !== undefined)
        .map((candidate) => [candidate.name, candidate.default as string]),
    ) as JsonObject,
    options,
    ...(spec.notes === undefined ? {} : { notes: [...spec.notes] }),
  };
}

function helpText(spec: CliCommandDefinition): string {
  const lines = [`Usage: ${spec.usage}`, "", spec.summary];
  if (spec.name === "root") {
    lines.push("", "Commands:");
    for (const command of publicCliCommandDefinitions()) {
      lines.push(`  ${command.name.padEnd(20)} ${command.summary}`);
    }
    lines.push("", "Global options:");
    for (const candidate of GLOBAL_HELP_OPTIONS) {
      const label = candidate.name === "--help" ? "-h, --help" : candidate.name;
      lines.push(`  ${label.padEnd(20)} ${candidate.description}`);
    }
  } else {
    lines.push("", "Options:");
    if (spec.options.length === 0) lines.push("  (none)");
    for (const candidate of spec.options) {
      const label = candidate.value === undefined ? candidate.name : `${candidate.name} ${candidate.value}`;
      const qualifier =
        candidate.required === true
          ? "required"
          : `optional${candidate.default === undefined ? "" : `; default: ${candidate.default}`}`;
      const bounds =
        candidate.minimum === undefined && candidate.maximum === undefined
          ? ""
          : `; bounds: ${candidate.minimum ?? "-∞"}..${candidate.maximum ?? "∞"}`;
      lines.push(`  ${label.padEnd(38)} ${qualifier}${bounds}; ${candidate.description}`);
    }
    if (spec.notes !== undefined) {
      lines.push("", "Notes:");
      for (const note of spec.notes) lines.push(`  ${note}`);
    }
  }
  return lines.join("\n");
}

const HELP_TEXT = helpText(ROOT_HELP_SPEC);

export type CliDependencies = {
  backend?: SessionBackend;
  cwd?: string;
  io?: CliIO;
  version?: string;
  sandboxRunner?: (
    request: import("./domain/sandbox.js").SandboxExecutionRequest,
    command: SandboxCommand,
  ) => Promise<DomainResult<SandboxExecutionResult>>;
  sandboxProbe?: SandboxProbe;
  sandboxRuntimeLayout?: SandboxRuntimeLayout;
};

type GlobalArguments = {
  json: boolean;
  help: boolean;
  version: boolean;
  commandArguments: string[];
};

type ParsedOptions = {
  session_id: string | null;
  branch: string | null;
  worktree: string | null;
  worktree_root: string | null;
  base: string | null;
  label: string | null;
  resource: string | null;
  resources: string[];
  operation: string | null;
  message: string | null;
  message_pattern: string | null;
  remote: string | null;
  remote_branch: string | null;
  mode: string | null;
  claim_id: string | null;
  repository: string | null;
  apply: boolean;
  force: boolean;
  create_upstream: boolean;
  all: boolean;
  history: boolean;
  limit: string | null;
  offset: string | null;
  paths: string[];
  from_revision: string | null;
  to_revision: string | null;
  patch: boolean;
  max_bytes: string | null;
  max_hunks: string | null;
  integrated_revision: string | null;
  fetch_remote: string | null;
  fetch_branch: string | null;
};

function usageError(
  code: "INVALID_ARGUMENT" | "MISSING_ARGUMENT" | "NO_COMMAND",
  message: string,
  details: JsonObject | null = null,
): DomainError {
  return new DomainError(code, message, details);
}

function parseGlobalArguments(argv: string[]): DomainResult<GlobalArguments> {
  let json = false;
  let help = false;
  let version = false;
  const commandArguments: string[] = [];

  let passthrough = false;
  for (const argument of argv) {
    if (passthrough) {
      commandArguments.push(argument);
      continue;
    }
    if (argument === "--") {
      passthrough = true;
      commandArguments.push(argument);
      continue;
    }
    if (argument === "--json") {
      json = true;
    } else if (argument === "-h" || argument === "--help") {
      help = true;
    } else if (argument === "--version") {
      version = true;
    } else {
      commandArguments.push(argument);
    }
  }

  if (help && version) {
    return failure(usageError("INVALID_ARGUMENT", "--help and --version cannot be used together."));
  }
  if (version && commandArguments.length > 0) {
    return failure(usageError("INVALID_ARGUMENT", "--version cannot be combined with a command."));
  }
  return { ok: true, value: { json, help, version, commandArguments } };
}

function optionParts(argument: string): { name: string; inlineValue: string | null } {
  const separator = argument.indexOf("=");
  if (separator === -1) return { name: argument, inlineValue: null };
  return { name: argument.slice(0, separator), inlineValue: argument.slice(separator + 1) };
}

function parseOptions(arguments_: string[], allowed: ReadonlySet<string>): DomainResult<ParsedOptions> {
  const options: ParsedOptions = {
    session_id: null,
    branch: null,
    worktree: null,
    worktree_root: null,
    base: null,
    label: null,
    resource: null,
    resources: [],
    operation: null,
    message: null,
    message_pattern: null,
    remote: null,
    remote_branch: null,
    mode: null,
    claim_id: null,
    repository: null,
    apply: false,
    force: false,
    create_upstream: false,
    all: false,
    history: false,
    limit: null,
    offset: null,
    paths: [],
    from_revision: null,
    to_revision: null,
    patch: false,
    max_bytes: null,
    max_hunks: null,
    integrated_revision: null,
    fetch_remote: null,
    fetch_branch: null,
  };
  let dryRun = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const { name, inlineValue } = optionParts(arguments_[index]);
    if (!allowed.has(name)) {
      return failure(usageError("INVALID_ARGUMENT", `Unknown option: ${name}.`, { option: name }));
    }

    if (
      name === "--apply" ||
      name === "--dry-run" ||
      name === "--force" ||
      name === "--create-upstream" ||
      name === "--all" ||
      name === "--history" ||
      name === "--patch"
    ) {
      if (inlineValue !== null) {
        return failure(usageError("INVALID_ARGUMENT", `${name} does not accept a value.`, { option: name }));
      }
      if (name === "--apply") options.apply = true;
      else if (name === "--dry-run") dryRun = true;
      else if (name === "--force") options.force = true;
      else if (name === "--create-upstream") options.create_upstream = true;
      else if (name === "--all") options.all = true;
      else if (name === "--history") options.history = true;
      else options.patch = true;
      continue;
    }

    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || value === "" || (inlineValue === null && value.startsWith("-"))) {
      return failure(usageError("MISSING_ARGUMENT", `${name} requires a value.`, { option: name }));
    }
    if (inlineValue === null) index += 1;

    if (name === "--session") options.session_id = value;
    else if (name === "--branch") options.branch = value;
    else if (name === "--worktree") options.worktree = value;
    else if (name === "--worktree-root") options.worktree_root = value;
    else if (name === "--base") options.base = value;
    else if (name === "--label") options.label = value;
    else if (name === "--resource") {
      options.resource = value;
      options.resources.push(value);
    } else if (name === "--operation") options.operation = value;
    else if (name === "--message") options.message = value;
    else if (name === "--message-pattern") options.message_pattern = value;
    else if (name === "--remote") options.remote = value;
    else if (name === "--remote-branch") options.remote_branch = value;
    else if (name === "--mode") options.mode = value;
    else if (name === "--claim-id") options.claim_id = value;
    else if (name === "--repository") options.repository = value;
    else if (name === "--limit") options.limit = value;
    else if (name === "--offset") options.offset = value;
    else if (name === "--path") options.paths.push(value);
    else if (name === "--from") options.from_revision = value;
    else if (name === "--to") options.to_revision = value;
    else if (name === "--max-bytes") options.max_bytes = value;
    else if (name === "--max-hunks") options.max_hunks = value;
    else if (name === "--integrated-revision") options.integrated_revision = value;
    else if (name === "--fetch-remote") options.fetch_remote = value;
    else if (name === "--fetch-branch") options.fetch_branch = value;
  }

  if (options.apply && dryRun) {
    return failure(usageError("INVALID_ARGUMENT", "--apply and --dry-run cannot be used together."));
  }

  return { ok: true, value: options };
}

function noOptions(arguments_: string[]): DomainResult<ParsedOptions> {
  return parseOptions(arguments_, new Set());
}

type PositionalSessionTarget = {
  readonly sessionId: string | null;
  readonly arguments: string[];
};

/** One unambiguous positional alias shared by every session-targeted command. */
function splitPositionalSessionTarget(arguments_: string[]): DomainResult<PositionalSessionTarget> {
  const first = arguments_[0];
  if (first === undefined || first.startsWith("-")) {
    return { ok: true, value: { sessionId: null, arguments: arguments_ } };
  }
  return { ok: true, value: { sessionId: first, arguments: arguments_.slice(1) } };
}

function parseTargetedOptions(
  arguments_: string[],
  allowed: ReadonlySet<string>,
  required = false,
): DomainResult<ParsedOptions> {
  const positional = splitPositionalSessionTarget(arguments_);
  if (!positional.ok) return positional;
  const parsed = parseOptions(positional.value.arguments, allowed);
  if (!parsed.ok) return parsed;
  if (positional.value.sessionId !== null && parsed.value.session_id !== null) {
    return failure(
      usageError("INVALID_ARGUMENT", "Specify a session target either positionally or with --session, not both.", {
        option: "--session",
      }),
    );
  }
  parsed.value.session_id = positional.value.sessionId ?? parsed.value.session_id;
  if (required && parsed.value.session_id === null) {
    return failure(
      usageError("MISSING_ARGUMENT", "An explicit session target is required; use <session-id> or --session <id>.", {
        option: "--session",
      }),
    );
  }
  return parsed;
}

type ClaimReplacementPairs = {
  session_id: string | null;
  repository: string | null;
  pairs: Array<{ resource: string; mode: string }>;
  expected_claim_set_generation: number | null;
  force: boolean;
};

type ClaimDeltaMutation = {
  session_id: string | null;
  repository: string | null;
  deltas: ResourceClaimDelta[];
  expected_claim_set_generation: number | null;
  force: boolean;
};

type ClaimTransition = {
  session_id: string | null;
  repository: string | null;
  resource: string;
  mode: "read" | "write" | "exclusive-write";
  expected_claim_set_generation: number | null;
  force: boolean;
};

type ReleaseSelection = {
  session_id: string | null;
  resources: string[];
  claim_ids: string[];
  all: boolean;
  expected_claim_set_generation: number | null;
  force: boolean;
};

type ClaimConcurrencyOption = "--if-generation" | "--force";

type ClaimConcurrencyState = {
  expected_claim_set_generation: number | null;
  force: boolean;
};

type ClaimConcurrencyConsumption = {
  state: ClaimConcurrencyState;
  consumed_next_value: boolean;
};

const CLAIM_CONCURRENCY_OPTION_NAMES: ReadonlySet<ClaimConcurrencyOption> = new Set(["--if-generation", "--force"]);

function isClaimConcurrencyOption(name: string): name is ClaimConcurrencyOption {
  return CLAIM_CONCURRENCY_OPTION_NAMES.has(name as ClaimConcurrencyOption);
}

/** Shared #176 CAS/force option vocabulary and value consumption. */
function consumeClaimConcurrencyOption(
  name: ClaimConcurrencyOption,
  inlineValue: string | null,
  nextValue: string | undefined,
  state: ClaimConcurrencyState,
): DomainResult<ClaimConcurrencyConsumption> {
  if (name === "--force") {
    if (inlineValue !== null) {
      return failure(usageError("INVALID_ARGUMENT", "--force does not accept a value.", { option: name }));
    }
    if (state.force) {
      return failure(usageError("INVALID_ARGUMENT", "--force may be supplied only once.", { option: name }));
    }
    return { ok: true, value: { state: { ...state, force: true }, consumed_next_value: false } };
  }

  const value = inlineValue ?? nextValue;
  const negativeGeneration = /^-\d+$/u.test(value ?? "");
  if (value === undefined || value === "" || (inlineValue === null && value.startsWith("-") && !negativeGeneration)) {
    return failure(usageError("MISSING_ARGUMENT", `${name} requires a value.`, { option: name }));
  }
  if (state.expected_claim_set_generation !== null) {
    return failure(usageError("INVALID_ARGUMENT", "--if-generation may be supplied only once.", { option: name }));
  }
  if (!/^\d+$/u.test(value)) {
    return failure(
      usageError("INVALID_ARGUMENT", "--if-generation requires a non-negative safe integer.", {
        option: name,
        value,
      }),
    );
  }
  const parsedGeneration = Number(value);
  if (!Number.isSafeInteger(parsedGeneration)) {
    return failure(
      usageError("INVALID_ARGUMENT", "--if-generation requires a non-negative safe integer.", {
        option: name,
        value,
      }),
    );
  }
  return {
    ok: true,
    value: {
      state: { ...state, expected_claim_set_generation: parsedGeneration },
      consumed_next_value: inlineValue === null,
    },
  };
}

function finalizeClaimConcurrency(
  state: ClaimConcurrencyState,
  requireConcurrencyIntent: boolean,
): DomainResult<ClaimConcurrencyState> {
  if (!requireConcurrencyIntent && (state.force || state.expected_claim_set_generation !== null)) {
    return failure(
      usageError("INVALID_ARGUMENT", "session claim does not accept --if-generation or --force.", {
        options: ["--if-generation", "--force"],
      }),
    );
  }
  if (requireConcurrencyIntent && state.force && state.expected_claim_set_generation !== null) {
    return failure(
      usageError("INVALID_ARGUMENT", "Specify exactly one of --if-generation or --force, not both.", {
        options: ["--if-generation", "--force"],
      }),
    );
  }
  if (requireConcurrencyIntent && !state.force && state.expected_claim_set_generation === null) {
    return failure(
      usageError("MISSING_ARGUMENT", "Exactly one of --if-generation or --force is required.", {
        options: ["--if-generation", "--force"],
      }),
    );
  }
  return { ok: true, value: state };
}

/**
 * Parse the selected-release grammar. A release has one and only one selector
 * family: exact resources, claim IDs, or explicit --all. Concurrency intent
 * is independently required and remains exactly one CAS/force option.
 */
function parseReleaseSelection(arguments_: string[]): DomainResult<ReleaseSelection> {
  const positional = splitPositionalSessionTarget(arguments_);
  if (!positional.ok) return positional;

  let sessionId = positional.value.sessionId;
  const resources: string[] = [];
  const claimIds: string[] = [];
  let all = false;
  let concurrencyState: ClaimConcurrencyState = {
    expected_claim_set_generation: null,
    force: false,
  };
  const recognized = dispatcherAllowedOptions("session release");

  const targetArguments = positional.value.arguments;
  for (let index = 0; index < targetArguments.length; index += 1) {
    const { name, inlineValue } = optionParts(targetArguments[index]);
    if (!recognized.has(name)) {
      return failure(usageError("INVALID_ARGUMENT", `Unknown option: ${name}.`, { option: name }));
    }

    if (name === "--all") {
      if (inlineValue !== null) {
        return failure(usageError("INVALID_ARGUMENT", "--all does not accept a value.", { option: name }));
      }
      if (all) {
        return failure(usageError("INVALID_ARGUMENT", "--all may be supplied only once.", { option: name }));
      }
      all = true;
      continue;
    }

    if (isClaimConcurrencyOption(name)) {
      const consumed = consumeClaimConcurrencyOption(name, inlineValue, targetArguments[index + 1], concurrencyState);
      if (!consumed.ok) return consumed;
      concurrencyState = consumed.value.state;
      if (consumed.value.consumed_next_value) index += 1;
      continue;
    }

    const value = inlineValue ?? targetArguments[index + 1];
    if (value === undefined || value === "" || (inlineValue === null && value.startsWith("-"))) {
      return failure(usageError("MISSING_ARGUMENT", `${name} requires a value.`, { option: name }));
    }
    if (inlineValue === null) index += 1;

    if (name === "--session") {
      if (sessionId !== null) {
        return failure(
          usageError("INVALID_ARGUMENT", "Specify a session target either positionally or with --session, not both.", {
            option: "--session",
          }),
        );
      }
      sessionId = value;
    } else if (name === "--resource") {
      resources.push(value);
    } else {
      claimIds.push(value);
    }
  }

  const selectorFamilies = Number(resources.length > 0) + Number(claimIds.length > 0) + Number(all);
  if (selectorFamilies === 0) {
    return failure(
      usageError(
        "MISSING_ARGUMENT",
        "Exactly one release selector family is required: --resource, --claim-id, or --all.",
        {
          options: ["--resource", "--claim-id", "--all"],
        },
      ),
    );
  }
  if (selectorFamilies !== 1) {
    return failure(
      usageError(
        "INVALID_ARGUMENT",
        "Release selectors are mutually exclusive: use --resource, --claim-id, or --all.",
        {
          options: ["--resource", "--claim-id", "--all"],
        },
      ),
    );
  }

  const concurrency = finalizeClaimConcurrency(concurrencyState, true);
  if (!concurrency.ok) return concurrency;
  return {
    ok: true,
    value: {
      session_id: sessionId,
      resources,
      claim_ids: claimIds,
      all,
      expected_claim_set_generation: concurrency.value.expected_claim_set_generation,
      force: concurrency.value.force,
    },
  };
}

/**
 * Parse the public atomic delta grammar without interpreting resource identity.
 * Resource canonicalization, duplicate/conflict authority, and all mutation
 * semantics remain in the domain/backend primitive.
 */
function parseClaimDeltaMutation(arguments_: string[]): DomainResult<ClaimDeltaMutation> {
  const positional = splitPositionalSessionTarget(arguments_);
  if (!positional.ok) return positional;

  let sessionId = positional.value.sessionId;
  let repository: string | null = null;
  const deltas: ResourceClaimDelta[] = [];
  let pendingUpsertResource: string | null = null;
  let concurrencyState: ClaimConcurrencyState = {
    expected_claim_set_generation: null,
    force: false,
  };
  const recognized = dispatcherAllowedOptions("session mutate");

  const rejectPending = (name: string): DomainResult<ClaimDeltaMutation> =>
    failure(
      usageError(
        "INVALID_ARGUMENT",
        `${name} cannot appear between --upsert-resource and its --mode; only --mode is permitted immediately after --upsert-resource.`,
        { option: name },
      ),
    );

  const targetArguments = positional.value.arguments;
  for (let index = 0; index < targetArguments.length; index += 1) {
    const { name, inlineValue } = optionParts(targetArguments[index]);
    if (!recognized.has(name)) {
      if (pendingUpsertResource !== null) return rejectPending(name);
      return failure(usageError("INVALID_ARGUMENT", `Unknown option: ${name}.`, { option: name }));
    }
    if (pendingUpsertResource !== null && name !== "--mode") return rejectPending(name);

    if (isClaimConcurrencyOption(name)) {
      const consumed = consumeClaimConcurrencyOption(name, inlineValue, targetArguments[index + 1], concurrencyState);
      if (!consumed.ok) return consumed;
      concurrencyState = consumed.value.state;
      if (consumed.value.consumed_next_value) index += 1;
      continue;
    }

    const value = inlineValue ?? targetArguments[index + 1];
    if (value === undefined || value === "" || (inlineValue === null && value.startsWith("-"))) {
      return failure(usageError("MISSING_ARGUMENT", `${name} requires a value.`, { option: name }));
    }
    if (inlineValue === null) index += 1;

    if (name === "--session") {
      if (sessionId !== null) {
        return failure(
          usageError("INVALID_ARGUMENT", "Specify a session target either positionally or with --session, not both.", {
            option: "--session",
          }),
        );
      }
      sessionId = value;
    } else if (name === "--repository") {
      repository = value;
    } else if (name === "--upsert-resource") {
      pendingUpsertResource = value;
    } else if (name === "--release-resource") {
      deltas.push({ kind: "release", resource: value });
    } else {
      if (pendingUpsertResource === null) {
        return failure(
          usageError("INVALID_ARGUMENT", "--mode must be immediately preceded by its own --upsert-resource.", {
            option: "--mode",
          }),
        );
      }
      if (!isResourceClaimMode(value)) {
        return failure(
          usageError("INVALID_ARGUMENT", "--mode requires read, write, or exclusive-write.", {
            option: "--mode",
            value,
          }),
        );
      }
      deltas.push({
        kind: "upsert",
        resource: pendingUpsertResource,
        mode: value,
      });
      pendingUpsertResource = null;
    }
  }

  if (pendingUpsertResource !== null) {
    return failure(
      usageError("MISSING_ARGUMENT", "--upsert-resource must be immediately followed by --mode.", {
        option: "--mode",
      }),
    );
  }
  if (deltas.length === 0) {
    return failure(
      usageError("MISSING_ARGUMENT", "At least one --upsert-resource or --release-resource is required.", {
        options: ["--upsert-resource", "--release-resource"],
      }),
    );
  }
  const concurrency = finalizeClaimConcurrency(concurrencyState, true);
  if (!concurrency.ok) return concurrency;
  return {
    ok: true,
    value: {
      session_id: sessionId,
      repository,
      deltas,
      expected_claim_set_generation: concurrency.value.expected_claim_set_generation,
      force: concurrency.value.force,
    },
  };
}

/**
 * Parse the one-resource transition convenience grammar. The underlying
 * mutation remains the canonical multi-delta primitive; this parser only
 * constrains its public projection to exactly one upsert pair.
 */
function parseClaimTransition(arguments_: string[]): DomainResult<ClaimTransition> {
  const parsed = parseClaimReplacementPairs(arguments_, true, "session transition");
  if (!parsed.ok) return parsed;
  if (parsed.value.pairs.length !== 1) {
    return failure(
      usageError("INVALID_ARGUMENT", "transition accepts exactly one --resource/--mode pair.", {
        pair_count: parsed.value.pairs.length,
      }),
    );
  }
  const pair = parsed.value.pairs[0];
  if (pair === undefined || !isResourceClaimMode(pair.mode)) {
    return failure(
      usageError("INVALID_ARGUMENT", "--mode requires read, write, or exclusive-write.", {
        option: "--mode",
        value: pair?.mode ?? null,
      }),
    );
  }
  return {
    ok: true,
    value: {
      session_id: parsed.value.session_id,
      repository: parsed.value.repository,
      resource: pair.resource,
      mode: pair.mode,
      expected_claim_set_generation: parsed.value.expected_claim_set_generation,
      force: parsed.value.force,
    },
  };
}

/**
 * `update` accepts a complete desired claim set as repeated
 * `--resource <path> --mode <mode>` pairs. Pairing is by strict local
 * adjacency (each `--resource` must be immediately followed by its own
 * `--mode`, with no other option able to intervene) rather than by
 * parallel-array position, so argv order can never associate a resource
 * with the wrong mode.
 */
function parseClaimReplacementPairs(
  arguments_: string[],
  requireConcurrencyIntent = true,
  command = "session update",
): DomainResult<ClaimReplacementPairs> {
  const positional = splitPositionalSessionTarget(arguments_);
  if (!positional.ok) return positional;
  let sessionId: string | null = null;
  let repository: string | null = null;
  const pairs: Array<{ resource: string; mode: string }> = [];
  let pendingResource: string | null = null;
  let concurrencyState: ClaimConcurrencyState = {
    expected_claim_set_generation: null,
    force: false,
  };

  sessionId = positional.value.sessionId;
  const targetArguments = positional.value.arguments;
  const recognized = dispatcherAllowedOptions(command);
  for (let index = 0; index < targetArguments.length; index += 1) {
    const { name, inlineValue } = optionParts(targetArguments[index]);
    const isConcurrencyOption = isClaimConcurrencyOption(name);
    if (!recognized.has(name) || (!requireConcurrencyIntent && isConcurrencyOption)) {
      return failure(usageError("INVALID_ARGUMENT", `Unknown option: ${name}.`, { option: name }));
    }
    if (pendingResource !== null && name !== "--mode") {
      return failure(
        usageError(
          "INVALID_ARGUMENT",
          `${name} cannot appear between --resource and its --mode; only --mode is permitted immediately after --resource.`,
          { option: name },
        ),
      );
    }

    if (requireConcurrencyIntent && isConcurrencyOption) {
      const consumed = consumeClaimConcurrencyOption(name, inlineValue, targetArguments[index + 1], concurrencyState);
      if (!consumed.ok) return consumed;
      concurrencyState = consumed.value.state;
      if (consumed.value.consumed_next_value) index += 1;
      continue;
    }

    const value = inlineValue ?? targetArguments[index + 1];
    if (value === undefined || value === "" || (inlineValue === null && value.startsWith("-"))) {
      return failure(usageError("MISSING_ARGUMENT", `${name} requires a value.`, { option: name }));
    }
    if (inlineValue === null) index += 1;

    if (name === "--session") {
      if (sessionId !== null) {
        return failure(
          usageError("INVALID_ARGUMENT", "Specify a session target either positionally or with --session, not both."),
        );
      }
      sessionId = value;
    } else if (name === "--repository") repository = value;
    else if (name === "--resource") pendingResource = value;
    else {
      if (pendingResource === null) {
        return failure(
          usageError("INVALID_ARGUMENT", "--mode must be immediately preceded by its own --resource.", {
            option: "--mode",
          }),
        );
      }
      pairs.push({ resource: pendingResource, mode: value });
      pendingResource = null;
    }
  }

  if (pendingResource !== null) {
    return failure(
      usageError("MISSING_ARGUMENT", "--resource must be immediately followed by --mode.", { option: "--mode" }),
    );
  }
  if (pairs.length === 0) {
    return failure(usageError("MISSING_ARGUMENT", "--resource requires a value.", { option: "--resource" }));
  }
  const concurrency = finalizeClaimConcurrency(concurrencyState, requireConcurrencyIntent);
  if (!concurrency.ok) return concurrency;
  return {
    ok: true,
    value: {
      session_id: sessionId,
      repository,
      pairs,
      expected_claim_set_generation: concurrency.value.expected_claim_set_generation,
      force: concurrency.value.force,
    },
  };
}

type SingleClaimPair = {
  session_id: string | null;
  repository: string | null;
  resource: string;
  mode: string;
};

/**
 * `claim` accepts exactly one `--resource`/`--mode` pair. Reuses the same
 * strict-adjacency scan as `update` so a second `--resource`/`--mode` (in
 * any order) is rejected outright instead of silently overwriting the
 * first pair (last-wins).
 */
function parseSingleClaimPair(arguments_: string[]): DomainResult<SingleClaimPair> {
  const parsed = parseClaimReplacementPairs(arguments_, false, "session claim");
  if (!parsed.ok) return parsed;
  if (parsed.value.pairs.length > 1) {
    return failure(
      usageError("INVALID_ARGUMENT", "claim accepts exactly one --resource/--mode pair.", {
        pair_count: parsed.value.pairs.length,
      }),
    );
  }
  const [pair] = parsed.value.pairs;
  return {
    ok: true,
    value: {
      session_id: parsed.value.session_id,
      repository: parsed.value.repository,
      resource: pair.resource,
      mode: pair.mode,
    },
  };
}

function sessionListingOptions(parsed: ParsedOptions): DomainResult<SessionListOptions> {
  const parseInteger = (option: "--limit" | "--offset", value: string | null): DomainResult<number | undefined> => {
    if (value === null) return { ok: true, value: undefined };
    if (!/^\d+$/u.test(value)) {
      return failure(usageError("INVALID_ARGUMENT", `${option} requires a non-negative integer.`, { option, value }));
    }
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue)) {
      return failure(usageError("INVALID_ARGUMENT", `${option} is outside the safe integer range.`, { option }));
    }
    return { ok: true, value: parsedValue };
  };

  const limit = parseInteger("--limit", parsed.limit);
  if (!limit.ok) return limit;
  if (limit.value !== undefined && (limit.value < 1 || limit.value > MAX_SESSION_LIST_LIMIT)) {
    return failure(
      usageError("INVALID_ARGUMENT", `--limit must be between 1 and ${MAX_SESSION_LIST_LIMIT}.`, {
        option: "--limit",
        max: MAX_SESSION_LIST_LIMIT,
      }),
    );
  }
  const offset = parseInteger("--offset", parsed.offset);
  if (!offset.ok) return offset;
  return {
    ok: true,
    value: {
      include_closed: parsed.all || parsed.history,
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(offset.value === undefined ? {} : { offset: offset.value }),
    },
  };
}

function boundedEvidenceInteger(
  option: "--max-bytes" | "--max-hunks",
  value: string | null,
  max: number,
): DomainResult<number | undefined> {
  if (value === null) return { ok: true, value: undefined };
  if (!/^\d+$/u.test(value)) {
    return failure(usageError("INVALID_ARGUMENT", `${option} requires a positive integer.`, { option, value }));
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    return failure(usageError("INVALID_ARGUMENT", `${option} must be between 1 and ${max}.`, { option, max, value }));
  }
  return { ok: true, value: parsed };
}

function sessionContext(cwd: string): SessionContext {
  return { cwd };
}

async function resolveSelectedSession(
  backend: SessionBackend,
  context: SessionContext,
  sessionId: string | null,
): Promise<DomainResult<import("./domain/session.js").SessionRecord>> {
  return sessionId === null ? backend.resolveCurrentSession(context) : backend.getSession(context, sessionId);
}

async function executeClaimDeltaMutation(
  arguments_: string[],
  backend: SessionBackend,
  context: SessionContext,
  operation: "session mutate" | "resource mutate",
): Promise<DomainResult<JsonObject>> {
  const parsed = parseClaimDeltaMutation(arguments_);
  if (!parsed.ok) return parsed;
  if (backend.applyClaimDeltas === undefined) return claimCapabilityUnavailable(operation);
  const concurrency = parsed.value.force
    ? { force: true }
    : { expected_claim_set_generation: parsed.value.expected_claim_set_generation };
  const result = await backend.applyClaimDeltas(context, {
    session_id: parsed.value.session_id,
    repository: parsed.value.repository,
    deltas: parsed.value.deltas,
    ...concurrency,
  });
  return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
}

async function executeClaimTransition(
  arguments_: string[],
  backend: SessionBackend,
  context: SessionContext,
  operation: "session transition" | "resource transition",
): Promise<DomainResult<JsonObject>> {
  const parsed = parseClaimTransition(arguments_);
  if (!parsed.ok) return parsed;
  if (backend.applyClaimDeltas === undefined) return claimCapabilityUnavailable(operation);
  const concurrency = parsed.value.force
    ? { force: true }
    : { expected_claim_set_generation: parsed.value.expected_claim_set_generation };
  const result = await backend.applyClaimDeltas(context, {
    session_id: parsed.value.session_id,
    repository: parsed.value.repository,
    deltas: [{ kind: "upsert", resource: parsed.value.resource, mode: parsed.value.mode }],
    ...concurrency,
  });
  return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
}

async function executeRelease(
  arguments_: string[],
  backend: SessionBackend,
  context: SessionContext,
  operation: "session release" | "resource release",
): Promise<DomainResult<JsonObject>> {
  const parsed = parseReleaseSelection(arguments_);
  if (!parsed.ok) return parsed;
  if (backend.releaseClaims === undefined) return claimCapabilityUnavailable(operation);

  const options: ReleaseClaimsOptions = {
    session_id: parsed.value.session_id,
    resources: parsed.value.resources.length === 0 ? null : parsed.value.resources,
    claim_ids: parsed.value.claim_ids.length === 0 ? null : parsed.value.claim_ids,
    all: parsed.value.all,
    ...(parsed.value.force
      ? { force: true }
      : { expected_claim_set_generation: parsed.value.expected_claim_set_generation }),
  };
  const result = await backend.releaseClaims(context, options);
  return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
}

/**
 * The one dispatcher boundary for protected managed execution.
 *
 * The public registry owns the command identity (including aliases); this
 * function owns only the routing contract.  Resolution is always enforced
 * and the resolved request is handed to the #145 launcher.  In particular,
 * there is no ambient child-process path to select when resolution or launch
 * fails.
 */
async function executeProtectedSessionCommand(
  arguments_: string[],
  dependencies: Required<Pick<CliDependencies, "backend" | "cwd">> &
    Pick<CliDependencies, "sandboxRunner" | "sandboxProbe" | "sandboxRuntimeLayout">,
  context: SessionContext,
): Promise<DomainResult<JsonObject>> {
  const delimiter = arguments_.indexOf("--");
  if (delimiter === -1) {
    return failure(usageError("MISSING_ARGUMENT", "session run requires a -- terminator before the command."));
  }
  const parsed = parseOptions(arguments_.slice(0, delimiter), new Set(["--session"]));
  if (!parsed.ok) return parsed;
  const command = arguments_[delimiter + 1];
  if (command === undefined || command.length === 0) {
    return failure(usageError("MISSING_ARGUMENT", "session run requires a command after --."));
  }

  const request = await resolveSandboxExecutionRequest(
    dependencies.backend,
    context,
    { session_id: parsed.value.session_id, enforce: true },
    dependencies.sandboxProbe,
    dependencies.sandboxRuntimeLayout,
  );
  if (!request.ok) return request;

  // `sandboxRunner` is an injection seam for unit tests. Production always
  // reaches the canonical protected launcher exported by #145.
  const runner = dependencies.sandboxRunner ?? runSandboxedCommand;
  const result = await runner(request.value, {
    command,
    args: arguments_.slice(delimiter + 2),
  });
  return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
}

async function executeCommand(
  commandArguments: string[],
  dependencies: Required<Pick<CliDependencies, "backend" | "cwd">> &
    Pick<CliDependencies, "sandboxRunner" | "sandboxProbe" | "sandboxRuntimeLayout">,
): Promise<DomainResult<JsonObject>> {
  const [command, subcommand, ...rest] = commandArguments;
  const context = sessionContext(dependencies.cwd);

  if (command === "session") {
    if (subcommand === undefined) {
      return failure(usageError("MISSING_ARGUMENT", "session requires a subcommand."));
    }
    // Resolve the subcommand through the canonical registry before dispatch.
    // This keeps `session exec` an alias of the same protected route instead
    // of creating a second launch path.
    if (canonicalCommandForName(`session ${subcommand}`)?.name === "session run") {
      return executeProtectedSessionCommand(rest, dependencies, context);
    }
    if (subcommand === "claim") {
      const parsed = parseSingleClaimPair(rest);
      if (!parsed.ok) return parsed;
      if (dependencies.backend.claimResources === undefined) return claimCapabilityUnavailable(subcommand);
      const result = await dependencies.backend.claimResources(context, {
        session_id: parsed.value.session_id,
        repository: parsed.value.repository,
        claims: [{ resource: parsed.value.resource, mode: parsed.value.mode as "read" | "write" | "exclusive-write" }],
      });
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "update") {
      const parsed = parseClaimReplacementPairs(rest);
      if (!parsed.ok) return parsed;
      if (dependencies.backend.updateClaims === undefined) return claimCapabilityUnavailable(subcommand);
      const concurrency = parsed.value.force
        ? { force: true }
        : { expected_claim_set_generation: parsed.value.expected_claim_set_generation };
      const result = await dependencies.backend.updateClaims(context, {
        session_id: parsed.value.session_id,
        repository: parsed.value.repository,
        claims: parsed.value.pairs.map((pair) => ({
          resource: pair.resource,
          mode: pair.mode as "read" | "write" | "exclusive-write",
        })),
        ...concurrency,
      });
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "mutate") {
      return executeClaimDeltaMutation(rest, dependencies.backend, context, "session mutate");
    }
    if (subcommand === "transition") {
      return executeClaimTransition(rest, dependencies.backend, context, "session transition");
    }
    if (subcommand === "claims") {
      const parsed = parseTargetedOptions(rest, dispatcherAllowedOptions("session claims"));
      if (!parsed.ok) return parsed;
      if (dependencies.backend.listClaims === undefined) return claimCapabilityUnavailable("claims");
      const result = await dependencies.backend.listClaims(context, parsed.value.session_id);
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "release") {
      return executeRelease(rest, dependencies.backend, context, "session release");
    }
    if (subcommand === "create") {
      const parsed = parseOptions(rest, dispatcherAllowedOptions("session create"));
      if (!parsed.ok) return parsed;
      if (parsed.value.worktree !== null && parsed.value.worktree_root !== null) {
        return failure(usageError("INVALID_ARGUMENT", "--worktree and --worktree-root cannot be used together."));
      }
      const options: SessionCreateOptions = {
        branch: parsed.value.branch,
        worktree: parsed.value.worktree,
        worktree_root: parsed.value.worktree_root,
        base: parsed.value.base,
        label: parsed.value.label,
      };
      const result = await dependencies.backend.createSession(context, options);
      return result.ok ? { ok: true, value: result.value } : result;
    }
    if (subcommand === "inspect") {
      const parsed = parseTargetedOptions(rest, dispatcherAllowedOptions("session inspect"));
      if (!parsed.ok) return parsed;
      if (dependencies.backend.sessionDiagnostic === undefined) return sessionDiagnosticCapabilityUnavailable();
      const options: SessionDiagnosticOptions = {
        session_id: parsed.value.session_id,
        integrated_revision: parsed.value.integrated_revision,
      };
      const result = await dependencies.backend.sessionDiagnostic(context, options);
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "discard") {
      const parsed = parseTargetedOptions(rest, dispatcherAllowedOptions("session discard"), true);
      if (!parsed.ok) return parsed;
      if (dependencies.backend.discardSession === undefined) return sessionDiscardCapabilityUnavailable();
      const result = await dependencies.backend.discardSession(context, parsed.value.session_id as string);
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "id" || subcommand === "show" || subcommand === "close") {
      if (subcommand === "id") {
        const parsed = noOptions(rest);
        if (!parsed.ok) return parsed;
        const selected = await dependencies.backend.resolveCurrentSession(context);
        if (!selected.ok) return selected;
        return { ok: true, value: { session_id: selected.value.session_id } };
      }

      const parsed = parseTargetedOptions(
        rest,
        dispatcherAllowedOptions(subcommand === "close" ? "session close" : "session show"),
      );
      if (!parsed.ok) return parsed;
      if (subcommand === "close") {
        const hasFetchRemote = parsed.value.fetch_remote !== null;
        const hasFetchBranch = parsed.value.fetch_branch !== null;
        if (hasFetchRemote !== hasFetchBranch) {
          return failure(
            usageError(
              "INVALID_ARGUMENT",
              "--fetch-remote and --fetch-branch must be supplied together for an explicit integration fetch.",
            ),
          );
        }
        if ((hasFetchRemote || hasFetchBranch) && parsed.value.integrated_revision === null) {
          return failure(
            usageError("MISSING_ARGUMENT", "Explicit integration fetch requires --integrated-revision <full-sha>.", {
              option: "--integrated-revision",
            }),
          );
        }
        const closeOptions: SessionCloseOptions = {
          session_id: parsed.value.session_id,
          integrated_revision: parsed.value.integrated_revision,
          fetch_remote: parsed.value.fetch_remote,
          fetch_branch: parsed.value.fetch_branch,
        };
        const selected = await dependencies.backend.closeSession(context, closeOptions);
        return selected.ok ? { ok: true, value: selected.value } : selected;
      }
      const selected = await resolveSelectedSession(dependencies.backend, context, parsed.value.session_id);
      return selected.ok ? { ok: true, value: selected.value } : selected;
    }
    if (subcommand === "list") {
      const parsed = parseOptions(rest, dispatcherAllowedOptions("session list"));
      if (!parsed.ok) return parsed;
      const options = sessionListingOptions(parsed.value);
      if (!options.ok) return options;
      const result = await dependencies.backend.listSessions(context, options.value);
      return result.ok ? { ok: true, value: result.value } : result;
    }
    return failure(new DomainError("UNKNOWN_COMMAND", `Unknown session subcommand: ${subcommand}.`, { subcommand }));
  }

  if (command === "resource") {
    const resourceSubcommand = subcommand ?? "list";
    if (resourceSubcommand === "claim") {
      const parsed = parseSingleClaimPair(rest);
      if (!parsed.ok) return parsed;
      if (dependencies.backend.claimResources === undefined) return claimCapabilityUnavailable(resourceSubcommand);
      const result = await dependencies.backend.claimResources(context, {
        session_id: parsed.value.session_id,
        repository: parsed.value.repository,
        claims: [{ resource: parsed.value.resource, mode: parsed.value.mode as "read" | "write" | "exclusive-write" }],
      });
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (resourceSubcommand === "update") {
      const parsed = parseClaimReplacementPairs(rest);
      if (!parsed.ok) return parsed;
      if (dependencies.backend.updateClaims === undefined) return claimCapabilityUnavailable(resourceSubcommand);
      const concurrency = parsed.value.force
        ? { force: true }
        : { expected_claim_set_generation: parsed.value.expected_claim_set_generation };
      const result = await dependencies.backend.updateClaims(context, {
        session_id: parsed.value.session_id,
        repository: parsed.value.repository,
        claims: parsed.value.pairs.map((pair) => ({
          resource: pair.resource,
          mode: pair.mode as "read" | "write" | "exclusive-write",
        })),
        ...concurrency,
      });
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (resourceSubcommand === "mutate") {
      return executeClaimDeltaMutation(rest, dependencies.backend, context, "resource mutate");
    }
    if (resourceSubcommand === "transition") {
      return executeClaimTransition(rest, dependencies.backend, context, "resource transition");
    }
    if (resourceSubcommand === "list" || resourceSubcommand === "claims") {
      const parsed = parseTargetedOptions(rest, dispatcherAllowedOptions("session claims"));
      if (!parsed.ok) return parsed;
      if (dependencies.backend.listClaims === undefined) return claimCapabilityUnavailable("list");
      const result = await dependencies.backend.listClaims(context, parsed.value.session_id);
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (resourceSubcommand === "release") {
      return executeRelease(rest, dependencies.backend, context, "resource release");
    }
    return failure(
      new DomainError("UNKNOWN_COMMAND", `Unknown resource subcommand: ${resourceSubcommand}.`, {
        subcommand: resourceSubcommand,
      }),
    );
  }

  if (command === "authorize") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("authorize"),
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.operation === null) {
      return failure(usageError("MISSING_ARGUMENT", "--operation requires a value.", { option: "--operation" }));
    }
    if (parsed.value.resources.length === 0) {
      return failure(usageError("MISSING_ARGUMENT", "--resource requires a value.", { option: "--resource" }));
    }
    if (dependencies.backend.authorizeOperation === undefined) return authorizationCapabilityUnavailable();
    const options: OperationAuthorizationOptions = {
      session_id: parsed.value.session_id,
      operation: parsed.value.operation,
      resources: parsed.value.resources,
    };
    const result = await dependencies.backend.authorizeOperation(context, options);
    if (!result.ok) return result;
    return result.value.allowed
      ? { ok: true, value: result.value as unknown as JsonObject }
      : deniedAuthorization(result.value);
  }

  if (command === "checkpoint") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("checkpoint"),
    );
    if (!parsed.ok) return parsed;
    if (dependencies.backend.checkpoint === undefined) return checkpointCapabilityUnavailable();
    const options: CheckpointOptions = { session_id: parsed.value.session_id };
    const result = await dependencies.backend.checkpoint(context, options);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "evidence" && subcommand === "snapshot") {
    const parsed = parseOptions(rest, dispatcherAllowedOptions("evidence snapshot"));
    if (!parsed.ok) return parsed;
    if (parsed.value.session_id === null) {
      return failure(usageError("MISSING_ARGUMENT", "evidence snapshot requires --session.", { option: "--session" }));
    }
    if (dependencies.backend.repositoryEvidence === undefined) {
      return repositoryEvidenceCapabilityUnavailable("evidence snapshot");
    }
    const options: RepositoryEvidenceOptions = { session_id: parsed.value.session_id };
    const result = await dependencies.backend.repositoryEvidence(context, options);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "diff") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("diff"),
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.session_id === null) {
      return failure(usageError("MISSING_ARGUMENT", "diff requires --session.", { option: "--session" }));
    }
    if (parsed.value.paths.length === 0) {
      return failure(usageError("MISSING_ARGUMENT", "diff requires at least one --path.", { option: "--path" }));
    }
    if (parsed.value.paths.length > EVIDENCE_MAX_DIFF_PATHS) {
      return failure(
        usageError("INVALID_ARGUMENT", `diff accepts at most ${EVIDENCE_MAX_DIFF_PATHS} paths.`, {
          option: "--path",
          max: EVIDENCE_MAX_DIFF_PATHS,
        }),
      );
    }
    const maxBytes = boundedEvidenceInteger("--max-bytes", parsed.value.max_bytes, EVIDENCE_MAX_DIFF_BYTES);
    if (!maxBytes.ok) return maxBytes;
    const maxHunks = boundedEvidenceInteger("--max-hunks", parsed.value.max_hunks, EVIDENCE_MAX_DIFF_HUNKS);
    if (!maxHunks.ok) return maxHunks;
    if (dependencies.backend.repositoryDiff === undefined) {
      return repositoryEvidenceCapabilityUnavailable("diff");
    }
    const options: RepositoryDiffOptions = {
      session_id: parsed.value.session_id,
      paths: parsed.value.paths,
      from: parsed.value.from_revision,
      to: parsed.value.to_revision,
      include_patch: parsed.value.patch,
      max_bytes: maxBytes.value,
      max_hunks: maxHunks.value,
    };
    const result = await dependencies.backend.repositoryDiff(context, options);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "commit") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("commit"),
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.message === null) {
      return failure(usageError("MISSING_ARGUMENT", "--message requires a value.", { option: "--message" }));
    }
    if (parsed.value.resources.length === 0) {
      return failure(usageError("MISSING_ARGUMENT", "--resource requires a value.", { option: "--resource" }));
    }
    if (dependencies.backend.commit === undefined) return mutationCapabilityUnavailable("commit");
    const result = await dependencies.backend.commit(context, {
      session_id: parsed.value.session_id,
      message: parsed.value.message,
      resources: parsed.value.resources,
      message_pattern: parsed.value.message_pattern,
    });
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "push") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("push"),
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.remote === null) {
      return failure(usageError("MISSING_ARGUMENT", "--remote requires a value.", { option: "--remote" }));
    }
    if (parsed.value.branch === null && parsed.value.remote_branch === null) {
      return failure(usageError("MISSING_ARGUMENT", "--branch requires a value.", { option: "--branch" }));
    }
    if (
      parsed.value.branch !== null &&
      parsed.value.remote_branch !== null &&
      parsed.value.branch !== parsed.value.remote_branch
    ) {
      return failure(usageError("INVALID_ARGUMENT", "--branch and --remote-branch must identify the same target."));
    }
    if (parsed.value.resources.length === 0) {
      return failure(usageError("MISSING_ARGUMENT", "--resource requires a value.", { option: "--resource" }));
    }
    if (dependencies.backend.push === undefined) return mutationCapabilityUnavailable("push");
    const result = await dependencies.backend.push(context, {
      session_id: parsed.value.session_id,
      resources: parsed.value.resources,
      remote: parsed.value.remote,
      branch: parsed.value.branch ?? parsed.value.remote_branch,
      force: parsed.value.force,
      create_upstream: parsed.value.create_upstream,
    });
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "status") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("status"),
    );
    if (!parsed.ok) return parsed;
    const options = sessionListingOptions(parsed.value);
    if (!options.ok) return options;
    const result = await dependencies.backend.status(context, options.value);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "guard") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("guard"),
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.resources.length > 0 && parsed.value.operation === null) {
      return failure(
        usageError("MISSING_ARGUMENT", "--operation is required when --resource is provided.", {
          option: "--operation",
        }),
      );
    }
    if (parsed.value.operation !== null) {
      if (parsed.value.resources.length === 0) {
        return failure(usageError("MISSING_ARGUMENT", "--resource requires a value.", { option: "--resource" }));
      }
      if (dependencies.backend.authorizeOperation === undefined) return authorizationCapabilityUnavailable();
      const result = await dependencies.backend.authorizeOperation(context, {
        session_id: parsed.value.session_id,
        operation: parsed.value.operation,
        resources: parsed.value.resources,
      });
      if (!result.ok) return result;
      return result.value.allowed
        ? { ok: true, value: result.value as unknown as JsonObject }
        : deniedAuthorization(result.value);
    }
    const result = await dependencies.backend.guard(context, { session_id: parsed.value.session_id });
    if (!result.ok) return result;
    if (result.value.allowed) return { ok: true, value: result.value as unknown as JsonObject };

    const code = result.value.code === "ALLOWED" ? "OPERATION_REJECTED" : result.value.code;
    return failure(
      new DomainError(code, `Guard denied the current worktree: ${code}.`, {
        allowed: false,
        repository: result.value.repository,
        worktree: result.value.worktree,
        branch: result.value.branch,
        session_id: result.value.session_id,
        owner_session_id: result.value.owner_session_id,
        requested_session_id: result.value.requested_session_id,
        state: result.value.state,
        details: result.value.details,
      }),
    );
  }

  if (command === "gc") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      dispatcherAllowedOptions("gc"),
    );
    if (!parsed.ok) return parsed;
    const options: GarbageCollectOptions = { apply: parsed.value.apply };
    const result = await dependencies.backend.garbageCollect(context, options);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "doctor") {
    const parsed = noOptions([subcommand, ...rest].filter((argument): argument is string => argument !== undefined));
    if (!parsed.ok) return parsed;
    const report = await runDoctor(dependencies.cwd, dependencies.sandboxProbe);
    if (!report.ok) return report;
    if (report.value.ok) return { ok: true, value: report.value as unknown as JsonObject };
    return failure(
      new DomainError("DOCTOR_FAILED", "One or more local Nawabari checks failed.", {
        checks: report.value.checks,
        repository: report.value.repository,
        sandbox: report.value.sandbox as unknown as JsonObject,
      }),
    );
  }

  if (command === "migrate") {
    const parsed = noOptions([subcommand, ...rest].filter((argument): argument is string => argument !== undefined));
    if (!parsed.ok) return parsed;
    if (dependencies.backend.migrate === undefined) return migrationCapabilityUnavailable();
    const result = await dependencies.backend.migrate(context);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === undefined) return failure(new DomainError("NO_COMMAND", "A command is required."));
  return failure(new DomainError("UNKNOWN_COMMAND", `Unknown command: ${command}.`, { command }));
}

function commandName(commandArguments: string[]): string {
  if (commandArguments[0] === "session") return commandArguments.slice(0, 2).join(" ");
  if (commandArguments[0] === "resource") {
    return commandArguments[1] === undefined ? "resource list" : commandArguments.slice(0, 2).join(" ");
  }
  if (commandArguments[0] === "evidence") return commandArguments.slice(0, 2).join(" ");
  return commandArguments[0] ?? "cli";
}

function claimCapabilityUnavailable(operation: string): DomainResult<JsonObject> {
  return failure(new DomainError("BACKEND_UNAVAILABLE", "Resource claim capability is not available.", { operation }));
}

function migrationCapabilityUnavailable(): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Registry migration capability is not available.", {
      operation: "migrate",
    }),
  );
}

function authorizationCapabilityUnavailable(): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Operation authorization capability is not available.", {
      operation: "authorize",
    }),
  );
}

function checkpointCapabilityUnavailable(): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Checkpoint evidence capability is not available.", {
      operation: "checkpoint",
    }),
  );
}

function sessionDiagnosticCapabilityUnavailable(): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Session diagnostic capability is not available.", {
      operation: "session.inspect",
    }),
  );
}

function sessionDiscardCapabilityUnavailable(): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Session discard capability is not available.", {
      operation: "session.discard",
    }),
  );
}

function repositoryEvidenceCapabilityUnavailable(operation: string): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Repository evidence capability is not available.", { operation }),
  );
}

function mutationCapabilityUnavailable(operation: "commit" | "push"): DomainResult<JsonObject> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "Governed Git mutation capability is not available.", { operation }),
  );
}

function deniedAuthorization(
  decision: import("./domain/session.js").OperationAuthorizationDecision,
): DomainResult<JsonObject> {
  const code = decision.code === "ALLOWED" ? "OPERATION_REJECTED" : decision.code;
  const diagnosticDetails =
    code === "INSUFFICIENT_CLAIM_MODE"
      ? {
          resource: decision.details.resource,
          granted_modes: decision.details.grantedModes,
        }
      : {};
  return failure(
    new DomainError(code, `Operation denied: ${code}.`, {
      allowed: false,
      schema_version: decision.schema_version,
      operation: decision.operation,
      required_access: decision.required_access,
      repository: decision.repository,
      worktree: decision.worktree,
      branch: decision.branch,
      session_id: decision.session_id,
      owner_session_id: decision.owner_session_id,
      requested_session_id: decision.requested_session_id,
      state: decision.state,
      resources: decision.resources,
      ...diagnosticDetails,
      details: decision.details,
    } as JsonObject),
  );
}

function emitFailure(mode: CliMode, command: string, error: DomainError, io: CliIO): number {
  io[mode === "json" ? "stdout" : "stderr"](renderFailure(mode, command, error));
  return error.exitCode;
}

/** Extract the raw `--session` value a rejected INVALID_SESSION_ID carried, regardless of which command path threw it. */
function invalidSessionIdQuery(error: DomainError): string | null {
  const details = error.details;
  if (details === null) return null;
  if (typeof details.sessionId === "string") return details.sessionId;
  const nested = details.details;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) return null;
  const nestedSessionId = (nested as JsonObject).sessionId;
  return typeof nestedSessionId === "string" ? nestedSessionId : null;
}

/**
 * `--session` stays machine-ID based: an invalid value is never silently
 * reinterpreted as a label. But when it exactly and unambiguously matches
 * one active session's label, expose that session's canonical ID as a
 * bounded, non-authoritative hint instead of forcing a separate `session
 * list` round trip. Ambiguous or absent matches never guess.
 */
async function enrichInvalidSessionIdError(
  error: DomainError,
  backend: SessionBackend,
  context: SessionContext,
): Promise<DomainError> {
  if (error.code !== "INVALID_SESSION_ID") return error;
  const query = invalidSessionIdQuery(error);
  if (query === null || query.length === 0) return error;

  const listing = await backend.listSessions(context, { include_closed: false, limit: MAX_SESSION_LIST_LIMIT });
  if (!listing.ok) return error;
  const matches = listing.value.sessions.filter((session) => session.state === "active" && session.label === query);

  const hint: JsonObject =
    matches.length === 1
      ? {
          session_label_query: query,
          session_label_match: "unique",
          session_id_hint: matches[0].session_id,
          safe_actions: ["retry-with-session-id-hint"],
        }
      : matches.length > 1
        ? {
            session_label_query: query,
            session_label_match: "ambiguous",
            session_label_match_count: matches.length,
            safe_actions: ["disambiguate-session-label", "list-sessions"],
          }
        : {
            session_label_query: query,
            session_label_match: "none",
            safe_actions: ["list-sessions"],
          };

  return new DomainError(error.code, error.message, { ...error.details, ...hint }, error.exitCode);
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? defaultCliIO();
  const delimiter = argv.indexOf("--");
  const globalArguments = delimiter === -1 ? argv : argv.slice(0, delimiter);
  const mode: CliMode = globalArguments.includes("--json") ? "json" : "human";
  const parsed = parseGlobalArguments(argv);
  if (!parsed.ok) return emitFailure(mode, "cli", parsed.error, io);

  if (parsed.value.help) {
    const spec = helpSpecFor(parsed.value.commandArguments);
    if (mode === "json") io.stdout(renderSuccess(mode, "help", helpPayload(spec)));
    else io.stdout(helpText(spec));
    return EXIT_CODES.success;
  }
  if (parsed.value.version) {
    const payload: JsonObject = {
      version: dependencies.version ?? VERSION,
      contract_id: MACHINE_CONTRACT_ID,
      contract_schema_version: MACHINE_CONTRACT_SCHEMA_VERSION,
    };
    if (mode === "json") io.stdout(renderSuccess(mode, "version", payload));
    else io.stdout(String(payload.version));
    return EXIT_CODES.success;
  }
  if (parsed.value.commandArguments.length === 0) {
    if (mode === "json") return emitFailure(mode, "cli", new DomainError("NO_COMMAND", "A command is required."), io);
    io.stdout(HELP_TEXT);
    return EXIT_CODES.usage;
  }

  if (parsed.value.commandArguments[0] === "capabilities") {
    const capabilityOptions = noOptions(parsed.value.commandArguments.slice(1));
    if (!capabilityOptions.ok) return emitFailure(mode, "capabilities", capabilityOptions.error, io);
    io.stdout(renderSuccess(mode, "capabilities", machineContract(dependencies.version ?? VERSION)));
    return EXIT_CODES.success;
  }

  const command = commandName(parsed.value.commandArguments);
  const cwd = dependencies.cwd ?? process.cwd();
  try {
    const backend = dependencies.backend ?? createLocalSessionBackend();
    const result = await executeCommand(parsed.value.commandArguments, {
      backend,
      cwd,
      sandboxRunner: dependencies.sandboxRunner,
      sandboxProbe: dependencies.sandboxProbe,
      sandboxRuntimeLayout: dependencies.sandboxRuntimeLayout,
    });
    if (!result.ok) {
      const enriched = await enrichInvalidSessionIdError(result.error, backend, sessionContext(cwd));
      return emitFailure(mode, command, enriched, io);
    }
    const childExitCode = result.value.exit_code;
    const childSignal = result.value.signal;
    io.stdout(renderSuccess(mode, command, result.value));
    if (
      (command === "session run" || command === "session exec") &&
      (childSignal !== null || (typeof childExitCode === "number" && childExitCode !== 0))
    ) {
      if (childSignal !== null) return EXIT_CODES.rejected;
      return typeof childExitCode === "number" && childExitCode >= 1 && childExitCode <= 255
        ? childExitCode
        : EXIT_CODES.rejected;
    }
    return EXIT_CODES.success;
  } catch {
    return emitFailure(mode, command, new DomainError("INTERNAL_ERROR", "An unexpected internal error occurred."), io);
  }
}
