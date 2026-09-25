import { CLI_COMMAND_REGISTRY, type CliCommandDefinition, type CommandId } from "./cli-command-registry.js";

/** Stable identity for the generated skill/playbook artifact. */
export const CLI_SKILL_PROJECTION_ID = "nawabari.cli-skill-projection.v1" as const;

const CLI_NAME = "nawabari";

const SKILL_FRONTMATTER = `---
name: nawabari
description: Operate the Nawabari session/worktree harness through its canonical CLI. Use this skill whenever creating, inspecting, claiming resources for, running commands in, or closing a Nawabari-managed session.
---`;

/**
 * `command` is typed `CommandId` (derived from `CLI_COMMAND_REGISTRY` in
 * cli-command-registry.ts), not `string`: a typo or a renamed/removed
 * command is a compile-time error here, not a runtime throw discovered only
 * when the playbook is generated.
 */
const CANONICAL_ROUTINE: readonly { readonly command: CommandId; readonly purpose: string }[] = [
  { command: "capabilities", purpose: "discover the installed machine contract before relying on any behavior" },
  { command: "session create", purpose: "request a new session and its managed worktree" },
  { command: "session claim", purpose: "add a resource claim before touching a path" },
  { command: "authorize", purpose: "check an operation against concrete claims before acting" },
  { command: "commit", purpose: "commit only claim-authorized resources" },
  { command: "push", purpose: "push the owned branch to an explicit remote target" },
  { command: "session inspect", purpose: "check close/cleanup readiness without mutating anything" },
  { command: "session close", purpose: "close the session once its work is integrated" },
];

function commandHeading(definition: CliCommandDefinition): string {
  return `### \`${definition.name}\``;
}

function aliasLine(definition: CliCommandDefinition): string {
  if (definition.aliases === undefined || definition.aliases.length === 0) return "Aliases: none.";
  return `Aliases: ${definition.aliases.map((alias) => `\`${alias}\``).join(", ")}.`;
}

function commandSection(definition: CliCommandDefinition): string {
  return [
    commandHeading(definition),
    definition.summary,
    "",
    "```",
    definition.usage,
    "```",
    "",
    aliasLine(definition),
    `Complete option contract: \`${CLI_NAME} ${definition.name} --help --json\`.`,
  ].join("\n");
}

/**
 * Render the Nawabari operational skill/playbook document from the same
 * canonical registry that CLI dispatch, `--help`, and `capabilities` project
 * from. This never restates flag syntax beyond the registry's own usage
 * string, so it cannot carry a second, independently maintained option
 * table.
 */
export function renderCliSkillPlaybook(): string {
  const routine = CANONICAL_ROUTINE.map(
    ({ command, purpose }, index) => `${index + 1}. \`${CLI_NAME} ${command}\` — ${purpose}.`,
  ).join("\n");
  const commandIndex = CLI_COMMAND_REGISTRY.map(commandSection).join("\n\n");

  return `${SKILL_FRONTMATTER}

# Nawabari CLI playbook

This playbook is generated from Nawabari's single canonical command
authority, \`CLI_COMMAND_REGISTRY\` in \`src/cli-command-registry.ts\`. It
references command identities and renders their canonical usage; it never
duplicates an independent flag or syntax table. Regenerate with
\`pnpm run skill:generate\`; \`pnpm run skill:check\` fails CI when this file
drifts from the registry.

For the exact, current option contract of any command, always defer to its
live projection:

\`\`\`
${CLI_NAME} <command> --help --json
${CLI_NAME} capabilities --json
\`\`\`

## Canonical routine

${routine}

## Command index

${commandIndex}
`;
}
