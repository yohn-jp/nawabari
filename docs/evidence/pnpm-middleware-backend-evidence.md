# Projected pnpm middleware backend evidence

Captured for Issue #296 before implementing the adapter.

## Pinned versions

```text
$ rtk --version
rtk 0.45.0

$ pnpm --version
11.18.0
```

## `rtk --help` evidence

The adapter-relevant command lines below are copied verbatim from the pinned
help output. The complete output captured at implementation time has SHA-256
`40989e25434eb58de9d776509e70223fb2f3f2f7270f0995aed9d8541d91b4f0`.

```text
A high-performance CLI proxy designed to filter and summarize system outputs before they reach your LLM context.

Usage: rtk [OPTIONS] <COMMAND>

Commands:
  ls             List directory contents with token-optimized output (proxy to native ls)
  tree           Directory tree with token-optimized output (proxy to native tree)
  read           Read file with intelligent filtering
  smart          Generate 2-line technical summary (heuristic-based)
  git            Git commands with compact output
  gh             GitHub CLI (gh) commands with token-optimized output
  glab           GitLab CLI (glab) commands with token-optimized output
  aws            AWS CLI with compact output (force JSON, compress)
  psql           PostgreSQL client with compact output (strip borders, compress tables)
  pnpm           pnpm commands with ultra-compact output
  err            Run command and show only errors/warnings
  test           Run tests and show only failures
  json           Show JSON (compact values by default, or keys-only with --keys-only)
  deps           Summarize project dependencies
  env            Show environment variables (filtered)
  find           Find files with compact tree output (accepts native find flags like -name, -type)
  summary        Run command and show heuristic summary
  dotnet         .NET commands with compact output (build/test/restore/format)
  docker         Docker commands with compact output
  kubectl        Kubectl commands with compact output
  oc             OpenShift CLI (oc) commands with compact output
  init           Initialize rtk instructions for assistant CLI usage
  wget           Download with compact output (strips progress bars)
  gain           Show token savings summary and history
  hook-audit     Show RTK hook rewrite audit metrics (requires RTK_HOOK_AUDIT=1)
  rewrite        Rewrite a raw command to its RTK equivalent (single source of truth for hooks)
  hook           Hook processors for LLM CLI tools (Gemini CLI, Copilot, etc.)
  run            Execute a shell command via sh -c (raw, no filtering or tracking)
  proxy          Execute command without filtering but track usage
  pipe           Read stdin, apply filter, print filtered output (Unix pipe mode)
  trust          Trust project-local TOML filters in current directory
  untrust        Revoke trust for project-local TOML filters
  verify         Verify hook integrity and run TOML filter inline tests
  learn          Learn CLI corrections from RTK usage history
  session        Show RTK adoption across Claude Code sessions
  telemetry      Manage telemetry consent and data (RGPD/GDPR)
  config         Show or create configuration file
  help           Print this message or the help of the given subcommand(s)

Options:
  -v, --verbose...
          Verbosity level (-v, -vv, -vvv) — only recognized before the subcommand

      --ultra-compact
          Ultra-compact mode: ASCII icons, inline format (Level 2 optimizations)

      --skip-env
          Set SKIP_ENV_VALIDATION=1 for child processes (Next.js, tsc, lint, prisma)

  -h, --help
          Print this message or the help of the given subcommand(s)

  -V, --version
          Print version
```

The selected binding is also present in the pinned subcommand help:

```text
$ rtk proxy --help
Execute command without filtering but track usage

Usage: rtk proxy [OPTIONS] [ARGS]...

Arguments:
  [ARGS]...  Command and arguments to execute
```

## Binding decision

The fixed launcher invokes the pinned RTK by exact path with this argv prefix:

```text
<exact-rtk-path> proxy <exact-real-pnpm-path> <original-pnpm-argv...>
```

`rtk pnpm` is not used: its versioned command surface resolves the backend by
the basename `pnpm`. The `proxy` command accepts an exact command argument, so
the adapter does not provide a basename, PATH entry, `which`, `command -v`, or
shell command. The generated launcher preserves the inherited environment and
cwd and uses inherited stdio with non-shell spawning.

Any backend that is missing, relative, projected, self-referential, equal to
the other backend, non-executable, or not represented by an exact read-only
source-to-target materialization fails before the launcher is written.
