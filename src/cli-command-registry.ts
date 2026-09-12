import { DEFAULT_SESSION_LIST_LIMIT, MAX_SESSION_LIST_LIMIT } from "./domain/session.js";
import { OPERATION_VOCABULARY } from "./operation-authorization.js";
import { EVIDENCE_MAX_DIFF_BYTES, EVIDENCE_MAX_DIFF_HUNKS } from "./repository-evidence.js";

const CLI_NAME = "nawabari";

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
  /** Closed values projected from the authority that validates this option. */
  readonly values?: readonly string[];
  /** This option remains required unless one of these additive selectors is present. */
  readonly required_unless?: readonly string[];
  /** Selectors that cannot be combined with this option. */
  readonly mutually_exclusive_with?: readonly string[];
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

export const GLOBAL_HELP_OPTIONS: readonly CliHelpOptionSpec[] = [
  { name: "--json", description: "Emit one stable JSON document on stdout" },
  { name: "--help", aliases: ["-h"], description: "Show command-specific help" },
  { name: "--version", description: "Print the installed version" },
];

const option = (
  name: string,
  description: string,
  options: Pick<
    CliHelpOptionSpec,
    | "aliases"
    | "alias_of"
    | "value"
    | "required"
    | "default"
    | "minimum"
    | "maximum"
    | "repeatable"
    | "values"
    | "required_unless"
    | "mutually_exclusive_with"
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
    usage: `${CLI_NAME} session run [--session <id>] [--runtime-policy <strict|compatibility>] -- <command> [args...]`,
    options: [
      option("--session", "Select the active owned session", { value: "<id>" }),
      option("--runtime-policy", "Select strict default-deny or explicit compatibility runtime visibility", {
        value: "<strict|compatibility>",
        default: "strict",
        values: ["strict", "compatibility"],
      }),
    ],
    notes: [
      "The -- terminator is mandatory. The command is passed as argv without a shell, and protected execution is fail-closed.",
      "session exec is an alias.",
    ],
  },
  {
    name: "session shell",
    summary: "Run an explicitly projected shell inside the protected session sandbox",
    usage: `${CLI_NAME} session shell [--session <id>] [--runtime-policy <strict|compatibility>] -- <projected-shell> [args...]`,
    options: [
      option("--session", "Select the active owned session", { value: "<id>" }),
      option("--runtime-policy", "Select strict default-deny or explicit compatibility runtime visibility", {
        value: "<strict|compatibility>",
        default: "strict",
        values: ["strict", "compatibility"],
      }),
    ],
    notes: [
      "The -- terminator is mandatory. The projected shell is resolved only through /nawabari/bin and receives inherited stdio.",
      "Nawabari does not parse shell syntax or select a host/default shell.",
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
    usage: `${CLI_NAME} session discard <session-id>|--session <id> [--preview]`,
    options: [
      option("--session", "Required explicit target; the current session is never inferred", {
        value: "<id>",
        required: true,
      }),
      option("--preview", "Read-only bounded summary of the destructive discard scope"),
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
      option("--operation", "Operation vocabulary entry", {
        value: "<name>",
        required: true,
        values: OPERATION_VOCABULARY,
      }),
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
    usage: `${CLI_NAME} commit --message <final-message> (--resource <path> [--resource <path>] | --all-claimed) [--session <id>] [--message-pattern <regex>]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--message", "Caller-decided final commit message", { value: "<final-message>", required: true }),
      option("--resource", "Claim-covered concrete path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
        required_unless: ["--all-claimed"],
      }),
      option("--all-claimed", "Select all safely resolved session resources covered by qualifying commit claims", {
        mutually_exclusive_with: ["--resource"],
      }),
      option("--message-pattern", "Caller-declared commit-message rule; validated only when supplied", {
        value: "<regex>",
      }),
    ],
    notes: [
      "Use repeated --resource by default, or explicitly use --all-claimed; the selectors cannot be combined.",
      "--all-claimed resolves only concrete Git-changed resources and retains unexpected changed-path protection.",
    ],
  },
  {
    name: "push",
    summary: "Push the owned branch to an explicit target",
    usage: `${CLI_NAME} push --remote <name> --branch <name> (--resource <path> [--resource <path>] | --all-claimed) [options]`,
    options: [
      option("--session", "Assert the current session identity", { value: "<id>" }),
      option("--resource", "Claim-covered concrete path; repeatable", {
        value: "<path>",
        required: true,
        repeatable: true,
        required_unless: ["--all-claimed"],
      }),
      option("--all-claimed", "Select all safely resolved session resources covered by qualifying push claims", {
        mutually_exclusive_with: ["--resource"],
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
      option("--operation", "Authorize an operation when resources are supplied", {
        value: "<name>",
        values: OPERATION_VOCABULARY,
      }),
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

export const ROOT_HELP_SPEC: CliCommandDefinition = {
  name: "root",
  summary: "Standalone local Git/session ownership CLI",
  usage: `${CLI_NAME} <command> [options]`,
  options: GLOBAL_HELP_OPTIONS,
};

/** Resolve a public name through the one canonical registry. */
export function canonicalCommandForName(name: string): CliCommandDefinition | undefined {
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
