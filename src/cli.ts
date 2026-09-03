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

export type CliHelpOptionSpec = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly alias_of?: string;
  readonly value?: string;
  readonly required?: boolean;
  readonly default?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly repeatable?: boolean;
  readonly description: string;
};

export type CliCommandDefinition = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly summary: string;
  readonly usage: string;
  readonly options: readonly CliHelpOptionSpec[];
  readonly notes?: readonly string[];
};

const GLOBAL_HELP_OPTIONS: readonly CliHelpOptionSpec[] = [
  { name: "--json", description: "Emit one stable JSON document on stdout" },
  { name: "--help", aliases: ["-h"], description: "Show command-specific help" },
  { name: "--version", description: "Print the installed version" },
];

const option = (
  name: string,
  description: string,
  options: Pick<
    CliHelpOptionSpec,
    "aliases" | "alias_of" | "value" | "required" | "default" | "minimum" | "maximum" | "repeatable"
  > = {},
): CliHelpOptionSpec => ({ name, description, ...options });

/**
 * Canonical public command/discovery registry.
 *
 * Dispatcher implementation deliberately remains below in this module.  This
 * registry only describes the public discovery surface; aliases point at the
 * canonical command so option metadata cannot drift between projections.
 */
export const CLI_COMMAND_REGISTRY: readonly CliCommandDefinition[] = [
  {
    name: "session create",
    summary: "Request a new Nawabari session",
    usage: `${CLI_NAME} session create [options]`,
    options: [
      option("--branch", "Branch to create; omitted uses the generated session branch", {
        value: "<name>",
        default: "nawabari/session/<session_id>",
      }),
      option("--worktree", "Exact managed worktree path override; mutually exclusive with --worktree-root", {
        value: "<path>",
        default: "<managed_worktree_root>/<repository>-<session_id>",
      }),
      option(
        "--worktree-root",
        "Managed root to place the worktree under; Nawabari derives the final path. Mutually exclusive with --worktree",
        { value: "<path>", default: "resolved repository-local root" },
      ),
      option("--base", "Commit-resolving base ref for the new worktree", { value: "<ref>", default: "HEAD" }),
      option("--label", "Optional display label; never used as an identity", { value: "<text>", default: "omitted" }),
    ],
    notes: [
      "All create options are optional. Use status --json to discover managed_worktree_root.",
      "--worktree and --worktree-root cannot be combined.",
    ],
  },
  {
    name: "session id",
    summary: "Resolve the current session identity",
    usage: `${CLI_NAME} session id`,
    options: [],
  },
  {
    name: "session show",
    summary: "Show the current or selected session",
    usage: `${CLI_NAME} session show [<session-id>|--session <id>]`,
    options: [option("--session", "Select a session instead of the current worktree owner", { value: "<id>" })],
    notes: [
      "Target grammar is consistent: an optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session inspect",
    summary: "Report side-effect-free close/cleanup readiness for a session",
    usage: `${CLI_NAME} session inspect [<session-id>|--session <id>] [--integrated-revision <rev>]`,
    options: [
      option("--session", "Select a session instead of the current worktree owner", { value: "<id>" }),
      option(
        "--integrated-revision",
        "Externally evidenced revision to test for non-ancestry (squash/rebase) integration; independently re-verified via exact Git tree-object equivalence, never trusted blindly",
        { value: "<rev>" },
      ),
    ],
    notes: [
      "Read-only: never mutates session, claim, Git, worktree, branch, or registry state. Repeated calls are idempotent.",
      "Derived from the same authoritative close/cleanup Git evidence as session close; does not duplicate or diverge from that logic.",
      "Nawabari never queries GitHub or any remote provider; --integrated-revision only names a local revision for Nawabari to independently verify.",
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session run",
    aliases: ["session exec"],
    summary: "Run one command inside the protected session sandbox",
    usage: `${CLI_NAME} session run [--session <id>] -- <command> [args...]`,
    options: [option("--session", "Select the active owned session", { value: "<id>" })],
    notes: [
      "The -- terminator is mandatory. The command is passed as argv without a shell, and protected execution is fail-closed.",
      "session exec is an alias.",
    ],
  },
  {
    name: "session list",
    summary: "List bounded repository session records",
    usage: `${CLI_NAME} session list [--all|--history] [--limit <n>] [--offset <n>]`,
    options: [
      option("--all", "Include closed history in the bounded result"),
      option("--history", "Alias for --all", { alias_of: "--all" }),
      option("--limit", `Maximum records per page; must be between 1 and ${MAX_SESSION_LIST_LIMIT}`, {
        value: "<n>",
        default: String(DEFAULT_SESSION_LIST_LIMIT),
        minimum: 1,
        maximum: MAX_SESSION_LIST_LIMIT,
      }),
      option("--offset", "Number of visible records to skip; must be a non-negative integer", {
        value: "<n>",
        default: "0",
        minimum: 0,
      }),
    ],
    notes: [
      `Default output excludes closed records; --all and --history include closed history. Both views are bounded by --limit (default ${DEFAULT_SESSION_LIST_LIMIT}, maximum ${MAX_SESSION_LIST_LIMIT}) and --offset (default 0).`,
    ],
  },
  {
    name: "session claim",
    aliases: ["resource claim"],
    summary: "Add a canonical resource claim",
    usage: `${CLI_NAME} session claim [<session-id>|--session <id>] [--repository <id>] --resource <path-or-glob> --mode <read|write|exclusive-write>`,
    options: [
      option("--resource", "Repository-relative resource", { value: "<path-or-glob>", required: true }),
      option("--mode", "Granted claim mode", { value: "<read|write|exclusive-write>", required: true }),
      option("--session", "Target active session; omitted resolves the current owner", { value: "<id>" }),
      option("--repository", "Expected repository identity", { value: "<id>" }),
    ],
    notes: [
      "Exactly one --resource/--mode pair is required; --mode must immediately follow its own --resource.",
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session update",
    aliases: ["resource update"],
    summary: "Atomically replace a session's complete resource claim set",
    usage: `${CLI_NAME} session update [<session-id>|--session <id>] [--repository <id>] --resource <path-or-glob> --mode <read|write|exclusive-write> [--resource <path-or-glob> --mode <read|write|exclusive-write> ...]`,
    options: [
      option(
        "--resource",
        "Repository-relative resource; repeatable, each paired with the --mode immediately after it",
        {
          value: "<path-or-glob>",
          required: true,
          repeatable: true,
        },
      ),
      option("--mode", "Mode for the --resource immediately before it; repeatable", {
        value: "<read|write|exclusive-write>",
        required: true,
        repeatable: true,
      }),
      option("--if-generation", "Expected claim-set generation for CAS; mutually exclusive with --force", {
        value: "<non-negative-integer>",
      }),
      option(
        "--force",
        "Explicitly permit unconditional complete replacement; mutually exclusive with --if-generation",
      ),
      option("--session", "Target active session; omitted resolves the current owner", { value: "<id>" }),
      option("--repository", "Expected repository identity", { value: "<id>" }),
    ],
    notes: [
      "The desired claim set is a full replacement performed atomically in one updateClaims() transaction; " +
        "use exactly one concurrency intent: --if-generation <non-negative-integer> for claim-set generation CAS, " +
        "or explicit --force for unconditional replacement. On any invalid, conflicting, or stale claim the prior set is left unchanged.",
      "Each --resource must be immediately followed by its own --mode; pairing is positional adjacency, not flag order.",
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session mutate",
    aliases: ["resource mutate"],
    summary: "Atomically apply exact-resource claim additions, changes, and releases",
    usage:
      `${CLI_NAME} session mutate [<session>|--session <id>] [--repository <id>] ` +
      `(--upsert-resource <path-or-glob> --mode <read|write|exclusive-write> | --release-resource <path-or-glob>)+ ` +
      `(--if-generation <non-negative-safe-int> | --force)`,
    options: [
      option(
        "--upsert-resource",
        "Exact repository-relative resource to add or change; each occurrence must be immediately followed by --mode",
        { value: "<path-or-glob>", repeatable: true },
      ),
      option("--mode", "Mode for the immediately preceding --upsert-resource", {
        value: "<read|write|exclusive-write>",
        repeatable: true,
      }),
      option("--release-resource", "Exact repository-relative resource to release; repeatable", {
        value: "<path-or-glob>",
        repeatable: true,
      }),
      option("--if-generation", "Expected claim-set generation for CAS; mutually exclusive with --force", {
        value: "<non-negative-safe-int>",
      }),
      option("--force", "Explicitly permit unconditional atomic mutation; mutually exclusive with --if-generation"),
      option("--session", "Target active session; omitted resolves the current owner", { value: "<id>" }),
      option("--repository", "Expected repository identity", { value: "<id>" }),
    ],
    notes: [
      "Apply one or more ordered upsert/release deltas in one backend transaction; exactly one concurrency intent is required.",
      "Every --upsert-resource must be immediately followed by its own --mode; --release-resource takes exactly one value.",
      "Target grammar: optional first positional <session> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session transition",
    aliases: ["resource transition"],
    summary: "Atomically transition one exact resource claim mode",
    usage:
      `${CLI_NAME} session transition [<session>|--session <id>] [--repository <id>] ` +
      `--resource <path-or-glob> --mode <read|write|exclusive-write> ` +
      `(--if-generation <non-negative-safe-int> | --force)`,
    options: [
      option("--resource", "Exact repository-relative resource to acquire or change", {
        value: "<path-or-glob>",
        required: true,
      }),
      option("--mode", "Target mode for the immediately preceding --resource", {
        value: "<read|write|exclusive-write>",
        required: true,
      }),
      option("--if-generation", "Expected claim-set generation for CAS; mutually exclusive with --force", {
        value: "<non-negative-safe-int>",
      }),
      option("--force", "Explicitly permit unconditional atomic mutation; mutually exclusive with --if-generation"),
      option("--session", "Target active session; omitted resolves the current owner", { value: "<id>" }),
      option("--repository", "Expected repository identity", { value: "<id>" }),
    ],
    notes: [
      "Exactly one resource/mode pair is projected as one atomic upsert delta; same mode is an idempotent no-op.",
      "Use exactly one concurrency intent: --if-generation <non-negative-safe-int> or explicit --force.",
      "The target grammar accepts an optional first positional <session> or --session <id>, but not both.",
    ],
  },
  {
    name: "session claims",
    aliases: ["resource list", "resource claims"],
    summary: "List canonical resource claims",
    usage: `${CLI_NAME} session claims [<session-id>|--session <id>]`,
    options: [option("--session", "Select a session; omitted lists all claims", { value: "<id>" })],
    notes: [
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session release",
    aliases: ["resource release"],
    summary: "Release resource claims",
    usage: `${CLI_NAME} session release [<session-id>|--session <id>] (--resource <path-or-glob> ... | --claim-id <id> ... | --all) (--if-generation <n> | --force)`,
    options: [
      option("--session", "Target session; omitted resolves the current owner", { value: "<id>" }),
      option("--resource", "Release one exact canonical resource; repeatable", {
        value: "<path-or-glob>",
        repeatable: true,
      }),
      option("--claim-id", "Release one owned claim ID; repeatable", { value: "<id>", repeatable: true }),
      option("--all", "Explicitly release all claims owned by the target session"),
      option("--if-generation", "Require the expected claim-set generation; mutually exclusive with --force", {
        value: "<non-negative-safe-int>",
      }),
      option("--force", "Explicitly allow unconditional release; mutually exclusive with --if-generation"),
    ],
    notes: [
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
      "Exactly one selector family is required: repeated --resource, repeated --claim-id, or explicit --all.",
      "Exactly one destructive concurrency intent is required: --if-generation <non-negative-safe-int> or --force.",
    ],
  },
  {
    name: "session close",
    summary: "Close the current or selected session",
    usage: `${CLI_NAME} session close [<session-id>|--session <id>] [--integrated-revision <rev>] [--fetch-remote <name> --fetch-branch <branch>]`,
    options: [
      option("--session", "Select a session instead of the current worktree owner", { value: "<id>" }),
      option(
        "--integrated-revision",
        "Externally evidenced revision proving non-ancestry (squash/rebase) integration; independently re-verified via exact Git tree-object equivalence, never trusted blindly",
        { value: "<rev>" },
      ),
      option("--fetch-remote", "Explicitly fetch one remote integration branch into a disposable proof ref", {
        value: "<name>",
      }),
      option("--fetch-branch", "Integration branch to fetch; requires --fetch-remote", { value: "<branch>" }),
    ],
    notes: [
      "Ordinary ancestry-based close remains the cheap/default path and requires no flags.",
      "Network access is never implicit; --fetch-remote and --fetch-branch are accepted only with a full lowercase --integrated-revision SHA.",
      "Fetch updates only a disposable internal proof ref with no tags, FETCH_HEAD, tracking-ref, or local integration-branch changes; remote tip races fail closed.",
      "Nawabari never calls provider APIs such as GitHub; only explicit --fetch-remote/--fetch-branch options connect to the configured Git remote.",
      "Target grammar: optional first positional <session-id> is an alias for --session <id>; do not supply both.",
    ],
  },
  {
    name: "session discard",
    summary: "Explicitly discard one selected session and its owned resources",
    usage: `${CLI_NAME} session discard <session-id>|--session <id>`,
    options: [
      option("--session", "Required explicit target; the current session is never inferred", {
        value: "<id>",
        required: true,
      }),
    ],
    notes: [
      "Destructive and explicit: unintegrated commits and uncommitted work in the selected owned worktree may be destroyed.",
      "Discard never changes close, gc, doctor, reconciliation, or integration-lineage proof behavior.",
      "Use exactly one target form: positional <session-id> or --session <id>; do not supply both.",
      "Machine JSON mode is non-interactive and deterministic.",
    ],
  },
  {
    name: "authorize",
    summary: "Authorize an operation against concrete claims",
    usage: `${CLI_NAME} authorize --operation <name> --resource <path> [--resource <path>] [--session <id>]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--operation", "Operation vocabulary entry", { value: "<name>", required: true }),
      option("--resource", "Concrete repository-relative path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
      }),
    ],
  },
  {
    name: "checkpoint",
    summary: "Capture bounded Git execution evidence",
    usage: `${CLI_NAME} checkpoint [--session <id>]`,
    options: [option("--session", "Assert the current session identity", { value: "<id>" })],
  },
  {
    name: "evidence snapshot",
    summary: "Capture bounded read-only evidence for one owned session",
    usage: `${CLI_NAME} evidence snapshot --session <id>`,
    options: [option("--session", "Explicit owned session to observe", { value: "<id>", required: true })],
    notes: ["The result is Git-observable physical evidence only; it contains no task or semantic interpretation."],
  },
  {
    name: "diff",
    summary: "Inspect bounded Git evidence for explicit paths",
    usage: `${CLI_NAME} diff --session <id> --path <path> [options]`,
    options: [
      option("--session", "Explicit owned session to observe", { value: "<id>", required: true }),
      option("--path", "Concrete repository-relative path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
      }),
      option("--from", "Commit/ref at the start of the range", { value: "<ref>", default: "HEAD" }),
      option("--to", "Commit/ref at the end of the range; omitted means worktree", { value: "<ref>" }),
      option("--patch", "Include patch text; requires the bounded byte/hunk limits"),
      option("--max-bytes", "Maximum UTF-8 patch bytes", {
        value: "<n>",
        default: String(EVIDENCE_MAX_DIFF_BYTES),
        minimum: 1,
        maximum: EVIDENCE_MAX_DIFF_BYTES,
      }),
      option("--max-hunks", "Maximum patch hunks", {
        value: "<n>",
        default: String(EVIDENCE_MAX_DIFF_HUNKS),
        minimum: 1,
        maximum: EVIDENCE_MAX_DIFF_HUNKS,
      }),
    ],
  },
  {
    name: "commit",
    summary: "Commit explicit claim-authorized resources",
    usage: `${CLI_NAME} commit --message <final-message> --resource <path> [--resource <path>] [--session <id>] [--message-pattern <regex>]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--message", "Caller-decided final commit message", { value: "<final-message>", required: true }),
      option("--resource", "Claim-covered concrete path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
      }),
      option("--message-pattern", "Caller-declared commit-message rule; validated only when supplied", {
        value: "<regex>",
      }),
    ],
  },
  {
    name: "push",
    summary: "Push the owned branch to an explicit target",
    usage: `${CLI_NAME} push --remote <name> --branch <name> --resource <path> [options]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--resource", "Claim-covered concrete path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
      }),
      option("--remote", "Explicit Git remote", { value: "<name>", required: true }),
      option("--branch", "Explicit target branch", {
        value: "<name>",
        required: true,
        aliases: ["--remote-branch"],
      }),
      option("--remote-branch", "Explicit remote branch alias for --branch", {
        value: "<name>",
        alias_of: "--branch",
      }),
      option("--force", "Allow force-with-lease when relation requires it"),
      option("--create-upstream", "Allow creation of a missing upstream"),
    ],
  },
  {
    name: "status",
    summary: "Show repository context and bounded session status",
    usage: `${CLI_NAME} status [--all|--history] [--limit <n>] [--offset <n>]`,
    options: [
      option("--all", "Include closed history in the bounded result"),
      option("--history", "Alias for --all", { alias_of: "--all" }),
      option("--limit", `Maximum records per page; must be between 1 and ${MAX_SESSION_LIST_LIMIT}`, {
        value: "<n>",
        default: String(DEFAULT_SESSION_LIST_LIMIT),
        minimum: 1,
        maximum: MAX_SESSION_LIST_LIMIT,
      }),
      option("--offset", "Number of visible records to skip; must be a non-negative integer", {
        value: "<n>",
        default: "0",
        minimum: 0,
      }),
    ],
    notes: [
      `The default machine result exposes managed_worktree_root for session-create path discovery. Session rows are bounded by --limit (default ${DEFAULT_SESSION_LIST_LIMIT}, maximum ${MAX_SESSION_LIST_LIMIT}) and --offset (default 0); --all and --history include closed history.`,
    ],
  },
  {
    name: "guard",
    summary: "Authorize the current worktree or operation",
    usage: `${CLI_NAME} guard [--session <id>] [--operation <name> --resource <path>]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--operation", "Authorize an operation when resources are supplied", { value: "<name>" }),
      option("--resource", "Concrete resource; repeatable with --operation", { value: "<path>" }),
    ],
  },
  {
    name: "gc",
    summary: "Detect or clean eligible stale sessions",
    usage: `${CLI_NAME} gc [--dry-run|--apply]`,
    options: [
      option("--apply", "Apply only cleanup that passes safety checks"),
      option("--dry-run", "Preflight eligible stale cleanup without mutation"),
    ],
    notes: [
      "Default stale threshold is 24 hours (86,400,000 ms). Elapsed age is diagnostic suspicion only; destructive eligibility requires explicit stale/closing state or a safely prunable missing worktree. Closed history is not a candidate.",
    ],
  },
  {
    name: "doctor",
    summary: "Check local Nawabari prerequisites and reconciliation",
    usage: `${CLI_NAME} doctor`,
    options: [],
  },
  {
    name: "migrate",
    summary: "Migrate legacy resource-claim registry state",
    usage: `${CLI_NAME} migrate`,
    options: [],
    notes: [
      "Explicitly upgrades claim-schema-v1 (and pre-claim registries) to the current schema under the registry lock.",
      "Migration is atomic, idempotent, and fail-closed; do not edit or delete the registry manually.",
    ],
  },
  {
    name: "capabilities",
    summary: "Describe the standalone CLI/JSON contract",
    usage: `${CLI_NAME} capabilities`,
    options: [],
  },
];

const ROOT_HELP_SPEC: CliCommandDefinition = {
  name: "root",
  summary: "Standalone local Git/session ownership CLI",
  usage: `${CLI_NAME} <command> [options]`,
  options: GLOBAL_HELP_OPTIONS,
};

/** Resolve a public name through the one canonical registry. */
function canonicalCommandForName(name: string): CliCommandDefinition | undefined {
  return CLI_COMMAND_REGISTRY.find((definition) => definition.name === name || definition.aliases?.includes(name));
}

/**
 * Materialize public names for projections without copying option metadata.
 * Alias entries are generated from their canonical definition, including the
 * usage, options, and parser notes.
 */
export function publicCliCommandDefinitions(): readonly CliCommandDefinition[] {
  return CLI_COMMAND_REGISTRY.flatMap((definition) => [
    definition,
    ...(definition.aliases ?? []).map((alias): CliCommandDefinition => ({
      name: alias,
      summary: `${definition.summary} (alias)`,
      usage: definition.usage.replace(definition.name, alias),
      options: definition.options,
      ...(definition.notes === undefined ? {} : { notes: definition.notes }),
    })),
  ]);
}

/** Stable alias for consumers such as the future dispatcher parity layer. */
export const COMMAND_REGISTRY = CLI_COMMAND_REGISTRY;

/** Resolve either a canonical command or one of its public aliases. */
export function resolveCliCommandDefinition(name: string): CliCommandDefinition | undefined {
  const canonical = canonicalCommandForName(name);
  if (canonical === undefined) return undefined;
  if (canonical.name === name) return canonical;
  return publicCliCommandDefinitions().find((definition) => definition.name === name);
}

/** Return the complete public discovery name list in registry order. */
export function publicCliCommandNames(): readonly string[] {
  return publicCliCommandDefinitions().map((definition) => definition.name);
}

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
  const recognized = new Set(["--session", "--resource", "--claim-id", "--all", ...CLAIM_CONCURRENCY_OPTION_NAMES]);

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
  const recognized = new Set([
    "--session",
    "--repository",
    "--upsert-resource",
    "--mode",
    "--release-resource",
    ...CLAIM_CONCURRENCY_OPTION_NAMES,
  ]);

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
  const parsed = parseClaimReplacementPairs(arguments_);
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
  for (let index = 0; index < targetArguments.length; index += 1) {
    const { name, inlineValue } = optionParts(targetArguments[index]);
    const isConcurrencyOption = isClaimConcurrencyOption(name);
    if (
      name !== "--session" &&
      name !== "--repository" &&
      name !== "--resource" &&
      name !== "--mode" &&
      !(requireConcurrencyIntent && isConcurrencyOption)
    ) {
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
  const parsed = parseClaimReplacementPairs(arguments_, false);
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
      const parsed = parseTargetedOptions(rest, new Set(["--session"]));
      if (!parsed.ok) return parsed;
      if (dependencies.backend.listClaims === undefined) return claimCapabilityUnavailable("claims");
      const result = await dependencies.backend.listClaims(context, parsed.value.session_id);
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "release") {
      return executeRelease(rest, dependencies.backend, context, "session release");
    }
    if (subcommand === "create") {
      const parsed = parseOptions(rest, new Set(["--branch", "--worktree", "--worktree-root", "--base", "--label"]));
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
    if (subcommand === "run" || subcommand === "exec") {
      const delimiter = rest.indexOf("--");
      if (delimiter === -1) {
        return failure(usageError("MISSING_ARGUMENT", "session run requires a -- terminator before the command."));
      }
      const parsed = parseOptions(rest.slice(0, delimiter), new Set(["--session"]));
      if (!parsed.ok) return parsed;
      const command = rest[delimiter + 1];
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
      const runner = dependencies.sandboxRunner ?? runSandboxedCommand;
      const result = await runner(request.value, {
        command,
        args: rest.slice(delimiter + 2),
      });
      return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
    }
    if (subcommand === "inspect") {
      const parsed = parseTargetedOptions(rest, new Set(["--session", "--integrated-revision"]));
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
      const parsed = parseTargetedOptions(rest, new Set(["--session"]), true);
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
        new Set(
          subcommand === "close"
            ? ["--session", "--integrated-revision", "--fetch-remote", "--fetch-branch"]
            : ["--session"],
        ),
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
      const parsed = parseOptions(rest, new Set(["--all", "--history", "--limit", "--offset"]));
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
      const parsed = parseTargetedOptions(rest, new Set(["--session"]));
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
      new Set(["--session", "--operation", "--resource"]),
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
      new Set(["--session"]),
    );
    if (!parsed.ok) return parsed;
    if (dependencies.backend.checkpoint === undefined) return checkpointCapabilityUnavailable();
    const options: CheckpointOptions = { session_id: parsed.value.session_id };
    const result = await dependencies.backend.checkpoint(context, options);
    return result.ok ? { ok: true, value: result.value as unknown as JsonObject } : result;
  }

  if (command === "evidence" && subcommand === "snapshot") {
    const parsed = parseOptions(rest, new Set(["--session"]));
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
      new Set(["--session", "--path", "--from", "--to", "--patch", "--max-bytes", "--max-hunks"]),
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
      new Set(["--session", "--message", "--resource", "--message-pattern"]),
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
      new Set(["--session", "--resource", "--remote", "--branch", "--remote-branch", "--force", "--create-upstream"]),
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
      new Set(["--all", "--history", "--limit", "--offset"]),
    );
    if (!parsed.ok) return parsed;
    const options = sessionListingOptions(parsed.value);
    if (!options.ok) return options;
    const result = await dependencies.backend.status(context, options.value);
    return result.ok ? { ok: true, value: result.value } : result;
  }

  if (command === "guard") {
    const parsed = parseOptions(
      [subcommand, ...rest].filter((argument): argument is string => argument !== undefined),
      new Set(["--session", "--operation", "--resource"]),
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
      new Set(["--apply", "--dry-run"]),
    );
    if (!parsed.ok) return parsed;
    const options: GarbageCollectOptions = { apply: parsed.value.apply };
    const result = await dependencies.backend.garbageCollect(context, options);
    return result.ok ? { ok: true, value: result.value } : result;
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
  if (commandArguments[0] === "resource") return commandArguments.slice(0, 2).join(" ");
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
