import type { RuntimePolicy } from "./domain/runtime-projection.js";
import type { SandboxProbe, SandboxRuntimeLayout } from "./domain/sandbox.js";
import type { RuntimeResolutionFhsOptions } from "./domain/runtime-resolution.js";
import type { NixRuntimeClosureOptions } from "./domain/nix-runtime-closure.js";
import type { ResolvedRuntimeProfile } from "./domain/runtime-profile.js";
import type { SessionBackend, SessionContext } from "./domain/session.js";
import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import {
  enterSessionConsole,
  listSessionProcesses,
  type SessionConsoleEnterOptions,
  type SessionConsoleOwnedExecutionObserver,
  type SessionConsoleRunner,
} from "./domain/session-console.js";
import type {
  PersistedSessionExecutionRecord,
  SessionExecutionDurableWriter,
  SessionExecutionIdentityReader,
  SessionExecutionRecord,
} from "./domain/session-execution-record.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./domain/errors.js";

export const SESSION_CONSOLE_CLI_COMMANDS = Object.freeze(["session enter", "session processes"] as const);

export type SessionConsoleCliCommand = Readonly<{
  readonly command: (typeof SESSION_CONSOLE_CLI_COMMANDS)[number];
  readonly session_id: string;
  readonly runtime_policy: RuntimePolicy | null;
}>;

export type SessionConsoleCliDependencies = Readonly<{
  readonly backend: SessionBackend;
  readonly sandbox_probe?: SandboxProbe;
  readonly sandbox_runtime_layout?: SandboxRuntimeLayout;
  readonly sandbox_runner?: SessionConsoleRunner;
  readonly runtime_projection?: SessionConsoleEnterOptions["runtime_projection"];
  readonly runtime_profile?: ResolvedRuntimeProfile;
  readonly runtime_profile_selection?: SessionConsoleEnterOptions["runtime_profile_selection"];
  readonly runtime_nix_options?: NixRuntimeClosureOptions;
  readonly runtime_fhs_options?: RuntimeResolutionFhsOptions;
  readonly persist_execution?: SessionExecutionDurableWriter;
  readonly read_executions?: (
    sessionId: string,
  ) =>
    | readonly (SessionExecutionRecord | PersistedSessionExecutionRecord)[]
    | Promise<readonly (SessionExecutionRecord | PersistedSessionExecutionRecord)[]>;
  readonly identity_reader?: SessionExecutionIdentityReader;
  readonly observe_owned_execution?: SessionConsoleOwnedExecutionObserver;
  readonly cgroup_filesystem?: CgroupFileSystem;
  readonly current_boot_id?: string;
}>;

function usage(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function valueAfter(arguments_: readonly string[], index: number, option: string): DomainResult<string> {
  const value = arguments_[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    return usage(`${option} requires a value.`, { option });
  }
  return success(value);
}

function commandParts(arguments_: readonly string[]): DomainResult<{
  command: (typeof SESSION_CONSOLE_CLI_COMMANDS)[number];
  arguments: readonly string[];
}> {
  if (arguments_[0] === "session" && arguments_[1] !== undefined) {
    const command = `session ${arguments_[1]}`;
    if (SESSION_CONSOLE_CLI_COMMANDS.includes(command as (typeof SESSION_CONSOLE_CLI_COMMANDS)[number])) {
      return success({
        command: command as (typeof SESSION_CONSOLE_CLI_COMMANDS)[number],
        arguments: arguments_.slice(2),
      });
    }
  }
  if (arguments_[0] === "enter" || arguments_[0] === "processes") {
    return success({
      command: `session ${arguments_[0]}` as (typeof SESSION_CONSOLE_CLI_COMMANDS)[number],
      arguments: arguments_.slice(1),
    });
  }
  return usage("Expected session enter or session processes.", { command: arguments_[0] ?? null });
}

/** Parse only the bounded options owned by the session-console surface. */
export function parseSessionConsoleCommand(arguments_: readonly string[]): DomainResult<SessionConsoleCliCommand> {
  const parts = commandParts(arguments_);
  if (!parts.ok) return parts;
  let sessionId: string | null = null;
  let runtimePolicy: RuntimePolicy | null = null;
  const values = parts.value.arguments;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index] as string;
    if (argument === "--session") {
      if (sessionId !== null) return usage("--session may be supplied only once.", { option: "--session" });
      const value = valueAfter(values, index, "--session");
      if (!value.ok) return value;
      sessionId = value.value;
      index += 1;
      continue;
    }
    if (argument === "--runtime-policy") {
      if (parts.value.command !== "session enter") {
        return usage("session processes does not accept --runtime-policy.", { option: "--runtime-policy" });
      }
      if (runtimePolicy !== null) return usage("--runtime-policy may be supplied only once.", {});
      const value = valueAfter(values, index, "--runtime-policy");
      if (!value.ok) return value;
      if (value.value === "strict") {
        runtimePolicy = {
          mode: "strict",
          host_visibility: "default-deny",
          compatibility: "disabled",
          unrestricted_host_fallback: "forbidden",
        };
      } else if (value.value === "compatibility") {
        runtimePolicy = {
          mode: "compatibility",
          host_visibility: "explicit",
          compatibility: "explicit",
          unrestricted_host_fallback: "explicit-only",
        };
      } else {
        return usage("--runtime-policy requires strict or compatibility.", {
          option: "--runtime-policy",
          value: value.value,
        });
      }
      index += 1;
      continue;
    }
    return usage(`Unknown session-console option: ${argument}.`, { option: argument });
  }
  if (sessionId === null) return usage("An explicit --session <id> is required.", { option: "--session" });
  return success({ command: parts.value.command, session_id: sessionId, runtime_policy: runtimePolicy });
}

/** Execute a parsed session-console command without owning central CLI routing or output. */
export async function executeSessionConsoleCommand(
  context: SessionContext,
  arguments_: readonly string[],
  dependencies: SessionConsoleCliDependencies,
): Promise<DomainResult<JsonObject>> {
  const parsed = parseSessionConsoleCommand(arguments_);
  if (!parsed.ok) return parsed;
  if (parsed.value.command === "session processes") {
    const result = await listSessionProcesses(context, dependencies.backend, {
      session_id: parsed.value.session_id,
      read_executions: dependencies.read_executions,
      identity_reader: dependencies.identity_reader,
      observe_owned_execution: dependencies.observe_owned_execution,
      cgroup_filesystem: dependencies.cgroup_filesystem,
      current_boot_id: dependencies.current_boot_id,
    });
    return result.ok ? success(result.value as unknown as JsonObject) : result;
  }
  const result = await enterSessionConsole(context, dependencies.backend, {
    session_id: parsed.value.session_id,
    ...(parsed.value.runtime_policy === null ? {} : { runtime_policy: parsed.value.runtime_policy }),
    ...(dependencies.runtime_projection === undefined ? {} : { runtime_projection: dependencies.runtime_projection }),
    ...(dependencies.runtime_profile === undefined ? {} : { runtime_profile: dependencies.runtime_profile }),
    ...(dependencies.runtime_profile_selection === undefined
      ? {}
      : { runtime_profile_selection: dependencies.runtime_profile_selection }),
    ...(dependencies.runtime_nix_options === undefined
      ? {}
      : { runtime_nix_options: dependencies.runtime_nix_options }),
    ...(dependencies.runtime_fhs_options === undefined
      ? {}
      : { runtime_fhs_options: dependencies.runtime_fhs_options }),
    ...(dependencies.sandbox_probe === undefined ? {} : { sandbox_probe: dependencies.sandbox_probe }),
    ...(dependencies.sandbox_runtime_layout === undefined
      ? {}
      : { sandbox_runtime_layout: dependencies.sandbox_runtime_layout }),
    ...(dependencies.sandbox_runner === undefined ? {} : { sandbox_runner: dependencies.sandbox_runner }),
    ...(dependencies.persist_execution === undefined ? {} : { persist_execution: dependencies.persist_execution }),
  });
  return result.ok ? success(result.value as unknown as JsonObject) : result;
}

export const runSessionConsoleCli = executeSessionConsoleCommand;
