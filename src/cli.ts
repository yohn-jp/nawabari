import { createRequire } from "node:module";
import { runDoctor } from "./domain/doctor.js";
import { DomainError, EXIT_CODES, failure, type DomainResult, type JsonObject } from "./domain/errors.js";
import {
  createUnavailableSessionBackend,
  type GarbageCollectOptions,
  type SessionBackend,
  type SessionCloseOptions,
  type SessionContext,
  type SessionCreateOptions,
} from "./domain/session.js";
import { defaultCliIO, renderFailure, renderSuccess, type CliIO, type CliMode } from "./presentation.js";

const CLI_NAME = "git-paw";
const packageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };
const VERSION = packageMetadata.version;

const HELP_TEXT = [
  `Usage: ${CLI_NAME} <command> [options]`,
  "",
  "Commands:",
  "  session create       Request a new GitPaw session",
  "  session id           Resolve the current session identity",
  "  session show         Show the current or selected session",
  "  session list         List repository sessions",
  "  session close        Close the current or selected session",
  "  status               Show GitPaw session status",
  "  gc                   Detect or clean eligible stale sessions",
  "  doctor               Check local GitPaw prerequisites",
  "  --help               Show this help",
  "  --version            Print the installed version",
  "",
  "Global options:",
  "  --json               Emit one stable JSON document on stdout",
  "  -h, --help           Show this help",
  "",
  "Session options:",
  "  session create --branch <name> --worktree <path> --label <text>",
  "  session show|close --session <id>",
  "  gc [--dry-run|--apply]",
].join("\n");

const HELP_DATA: JsonObject = {
  usage: `Usage: ${CLI_NAME} <command> [options]`,
  commands: ["session create", "session id", "session show", "session list", "session close", "status", "gc", "doctor"],
  options: ["--json", "--help", "--version"],
};

export type CliDependencies = {
  backend?: SessionBackend;
  cwd?: string;
  io?: CliIO;
  version?: string;
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
  label: string | null;
  apply: boolean;
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

  for (const argument of argv) {
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
    label: null,
    apply: false,
  };
  let dryRun = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const { name, inlineValue } = optionParts(arguments_[index]);
    if (!allowed.has(name)) {
      return failure(usageError("INVALID_ARGUMENT", `Unknown option: ${name}.`, { option: name }));
    }

    if (name === "--apply" || name === "--dry-run") {
      if (inlineValue !== null) {
        return failure(usageError("INVALID_ARGUMENT", `${name} does not accept a value.`, { option: name }));
      }
      if (name === "--apply") options.apply = true;
      else dryRun = true;
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
    else if (name === "--label") options.label = value;
  }

  if (options.apply && dryRun) {
    return failure(usageError("INVALID_ARGUMENT", "--apply and --dry-run cannot be used together."));
  }

  return { ok: true, value: options };
}

function noOptions(arguments_: string[]): DomainResult<ParsedOptions> {
  return parseOptions(arguments_, new Set());
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

async function executeCommand(
  commandArguments: string[],
  dependencies: Required<Pick<CliDependencies, "backend" | "cwd">>,
): Promise<DomainResult<JsonObject>> {
  const [command, subcommand, ...rest] = commandArguments;
  const context = sessionContext(dependencies.cwd);

  if (command === "session") {
    if (subcommand === undefined) {
      return failure(usageError("MISSING_ARGUMENT", "session requires a subcommand."));
    }
    if (subcommand === "create") {
      const parsed = parseOptions(rest, new Set(["--branch", "--worktree", "--label"]));
      if (!parsed.ok) return parsed;
      const options: SessionCreateOptions = {
        branch: parsed.value.branch,
        worktree: parsed.value.worktree,
        label: parsed.value.label,
      };
      const result = await dependencies.backend.createSession(context, options);
      return result.ok ? { ok: true, value: result.value } : result;
    }
    if (subcommand === "id" || subcommand === "show" || subcommand === "close") {
      if (subcommand === "id") {
        const parsed = noOptions(rest);
        if (!parsed.ok) return parsed;
        const selected = await dependencies.backend.resolveCurrentSession(context);
        if (!selected.ok) return selected;
        return { ok: true, value: { session_id: selected.value.session_id } };
      }

      const parsed = parseOptions(rest, new Set(["--session"]));
      if (!parsed.ok) return parsed;
      if (subcommand === "close") {
        const closeOptions: SessionCloseOptions = { session_id: parsed.value.session_id };
        const selected = await dependencies.backend.closeSession(context, closeOptions);
        return selected.ok ? { ok: true, value: selected.value } : selected;
      }
      const selected = await resolveSelectedSession(dependencies.backend, context, parsed.value.session_id);
      return selected.ok ? { ok: true, value: selected.value } : selected;
    }
    if (subcommand === "list") {
      const parsed = noOptions(rest);
      if (!parsed.ok) return parsed;
      const result = await dependencies.backend.listSessions(context);
      return result.ok ? { ok: true, value: result.value } : result;
    }
    return failure(new DomainError("UNKNOWN_COMMAND", `Unknown session subcommand: ${subcommand}.`, { subcommand }));
  }

  if (command === "status") {
    const parsed = noOptions([subcommand, ...rest].filter((argument): argument is string => argument !== undefined));
    if (!parsed.ok) return parsed;
    const result = await dependencies.backend.status(context);
    return result.ok ? { ok: true, value: result.value } : result;
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
    const report = await runDoctor(dependencies.cwd);
    if (!report.ok) return report;
    if (report.value.ok) return { ok: true, value: report.value as JsonObject };
    return failure(
      new DomainError("DOCTOR_FAILED", "One or more local GitPaw checks failed.", {
        checks: report.value.checks,
        repository: report.value.repository,
      }),
    );
  }

  if (command === undefined) return failure(new DomainError("NO_COMMAND", "A command is required."));
  return failure(new DomainError("UNKNOWN_COMMAND", `Unknown command: ${command}.`, { command }));
}

function commandName(commandArguments: string[]): string {
  if (commandArguments[0] === "session") return commandArguments.slice(0, 2).join(" ");
  return commandArguments[0] ?? "cli";
}

function emitFailure(mode: CliMode, command: string, error: DomainError, io: CliIO): number {
  io[mode === "json" ? "stdout" : "stderr"](renderFailure(mode, command, error));
  return error.exitCode;
}

export async function runCli(argv: string[], dependencies: CliDependencies = {}): Promise<number> {
  const io = dependencies.io ?? defaultCliIO();
  const mode: CliMode = argv.includes("--json") ? "json" : "human";
  const parsed = parseGlobalArguments(argv);
  if (!parsed.ok) return emitFailure(mode, "cli", parsed.error, io);

  if (parsed.value.help) {
    if (mode === "json") io.stdout(renderSuccess(mode, "help", HELP_DATA));
    else io.stdout(HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (parsed.value.version) {
    const payload: JsonObject = { version: dependencies.version ?? VERSION };
    if (mode === "json") io.stdout(renderSuccess(mode, "version", payload));
    else io.stdout(String(payload.version));
    return EXIT_CODES.success;
  }
  if (parsed.value.commandArguments.length === 0) {
    if (mode === "json") return emitFailure(mode, "cli", new DomainError("NO_COMMAND", "A command is required."), io);
    io.stdout(HELP_TEXT);
    return EXIT_CODES.usage;
  }

  const command = commandName(parsed.value.commandArguments);
  const backend = dependencies.backend ?? createUnavailableSessionBackend();
  const cwd = dependencies.cwd ?? process.cwd();
  try {
    const result = await executeCommand(parsed.value.commandArguments, { backend, cwd });
    if (!result.ok) return emitFailure(mode, command, result.error, io);
    io.stdout(renderSuccess(mode, command, result.value));
    return EXIT_CODES.success;
  } catch {
    return emitFailure(mode, command, new DomainError("INTERNAL_ERROR", "An unexpected internal error occurred."), io);
  }
}
