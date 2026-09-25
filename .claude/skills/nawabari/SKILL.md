---
name: nawabari
description: Operate the Nawabari session/worktree harness through its canonical CLI. Use this skill whenever creating, inspecting, claiming resources for, running commands in, or closing a Nawabari-managed session.
---

# Nawabari CLI playbook

This playbook is generated from Nawabari's single canonical command
authority, `CLI_COMMAND_REGISTRY` in `src/cli-command-registry.ts`. It
references command identities and renders their canonical usage; it never
duplicates an independent flag or syntax table. Regenerate with
`pnpm run skill:generate`; `pnpm run skill:check` fails CI when this file
drifts from the registry.

For the exact, current option contract of any command, always defer to its
live projection:

```
nawabari <command> --help --json
nawabari capabilities --json
```

## Canonical routine

1. `nawabari capabilities` — discover the installed machine contract before relying on any behavior.
2. `nawabari session create` — request a new session and its managed worktree.
3. `nawabari session claim` — add a resource claim before touching a path.
4. `nawabari authorize` — check an operation against concrete claims before acting.
5. `nawabari commit` — commit only claim-authorized resources.
6. `nawabari push` — push the owned branch to an explicit remote target.
7. `nawabari session inspect` — check close/cleanup readiness without mutating anything.
8. `nawabari session close` — close the session once its work is integrated.

## Command index

### `session create`

Request a new Nawabari session

```
nawabari session create [--branch <name>] [--worktree <path>|--worktree-root <path>] [--base <ref>] [--label <text>] [--execution-scope-file <path> --candidate-working-set-file <path>] [--resource <path-or-glob> --mode <read|write|exclusive-write> ...] [--enforce-claims]
```

Aliases: none.
Complete option contract: `nawabari session create --help --json`.

### `session id`

Resolve the current session identity

```
nawabari session id
```

Aliases: none.
Complete option contract: `nawabari session id --help --json`.

### `session show`

Show the current or selected session

```
nawabari session show [<session-id>|--session <id>]
```

Aliases: none.
Complete option contract: `nawabari session show --help --json`.

### `session inspect`

Report side-effect-free close/cleanup readiness for a session

```
nawabari session inspect [<session-id>|--session <id>] [--integrated-revision <rev>] [--schema-version <1|2>]
```

Aliases: none.
Complete option contract: `nawabari session inspect --help --json`.

### `session scope expand`

Explicitly expand a bounded session working set

```
nawabari session scope expand <session-id>|--session <id> --repository <id> --repository-host <host> --revision <n> --execution-scope-file <path> --path <repository-relative-path> --operation <READONLY|WRITE|CREATE|DELETE> [--reason <text>] [--evidence <text>] [--unresolved]
```

Aliases: none.
Complete option contract: `nawabari session scope expand --help --json`.

### `session reconcile`

Apply bounded lifecycle reconciliation for one selected session

```
nawabari session reconcile --session <id> --apply
```

Aliases: none.
Complete option contract: `nawabari session reconcile --help --json`.

### `session run`

Run one command inside the protected session sandbox

```
nawabari session run [--session <id>] [--runtime-policy <strict|compatibility>] -- <command> [args...]
```

Aliases: `session exec`.
Complete option contract: `nawabari session run --help --json`.

### `session shell`

Run an explicitly projected shell inside the protected session sandbox

```
nawabari session shell [--session <id>] [--runtime-policy <strict|compatibility>] -- <projected-shell> [args...]
```

Aliases: none.
Complete option contract: `nawabari session shell --help --json`.

### `session list`

List bounded repository session records

```
nawabari session list [--all|--history] [--limit <n>] [--offset <n>]
```

Aliases: none.
Complete option contract: `nawabari session list --help --json`.

### `session claim`

Add a canonical resource claim

```
nawabari session claim [<session-id>|--session <id>] [--repository <id>] --resource <path-or-glob> --mode <read|write|exclusive-write>
```

Aliases: `resource claim`.
Complete option contract: `nawabari session claim --help --json`.

### `session update`

Atomically replace a session's complete resource claim set

```
nawabari session update [<session-id>|--session <id>] [--repository <id>] --resource <path-or-glob> --mode <read|write|exclusive-write> [--resource <path-or-glob> --mode <read|write|exclusive-write> ...]
```

Aliases: `resource update`.
Complete option contract: `nawabari session update --help --json`.

### `session mutate`

Atomically apply exact-resource claim additions, changes, and releases

```
nawabari session mutate [<session>|--session <id>] [--repository <id>] (--upsert-resource <path-or-glob> --mode <read|write|exclusive-write> | --release-resource <path-or-glob>)+ (--if-generation <non-negative-safe-int> | --force)
```

Aliases: `resource mutate`.
Complete option contract: `nawabari session mutate --help --json`.

### `session transition`

Atomically transition one exact resource claim mode

```
nawabari session transition [<session>|--session <id>] [--repository <id>] --resource <path-or-glob> --mode <read|write|exclusive-write> (--if-generation <non-negative-safe-int> | --force)
```

Aliases: `resource transition`.
Complete option contract: `nawabari session transition --help --json`.

### `session claims`

List canonical resource claims

```
nawabari session claims [<session-id>|--session <id>]
```

Aliases: `resource list`, `resource claims`.
Complete option contract: `nawabari session claims --help --json`.

### `session release`

Release resource claims

```
nawabari session release [<session-id>|--session <id>] (--resource <path-or-glob> ... | --claim-id <id> ... | --all) (--if-generation <n> | --force)
```

Aliases: `resource release`.
Complete option contract: `nawabari session release --help --json`.

### `session close`

Close the current or selected session

```
nawabari session close [<session-id>|--session <id>] [--integrated-revision <rev>] [--fetch-remote <name> --fetch-branch <branch>]
```

Aliases: none.
Complete option contract: `nawabari session close --help --json`.

### `session discard`

Explicitly discard one selected session and its owned resources

```
nawabari session discard <session-id>|--session <id> [--preview]
```

Aliases: none.
Complete option contract: `nawabari session discard --help --json`.

### `authorize`

Authorize an operation against concrete claims

```
nawabari authorize --operation <name> --resource <path> [--resource <path>] [--session <id>]
```

Aliases: none.
Complete option contract: `nawabari authorize --help --json`.

### `checkpoint`

Capture bounded Git execution evidence

```
nawabari checkpoint [--session <id>]
```

Aliases: none.
Complete option contract: `nawabari checkpoint --help --json`.

### `evidence snapshot`

Capture bounded read-only evidence for one owned session

```
nawabari evidence snapshot --session <id>
```

Aliases: none.
Complete option contract: `nawabari evidence snapshot --help --json`.

### `diff`

Inspect bounded Git evidence for explicit paths

```
nawabari diff --session <id> --path <path> [options]
```

Aliases: none.
Complete option contract: `nawabari diff --help --json`.

### `commit`

Commit explicit claim-authorized resources

```
nawabari commit --message <final-message> (--resource <path> [--resource <path>] | --all-claimed) [--session <id>] [--message-pattern <regex>]
```

Aliases: none.
Complete option contract: `nawabari commit --help --json`.

### `push`

Push the owned branch to an explicit target

```
nawabari push --remote <name> --branch <name> (--resource <path> [--resource <path>] | --all-claimed) [options]
```

Aliases: none.
Complete option contract: `nawabari push --help --json`.

### `status`

Show repository context and bounded session status

```
nawabari status [--all|--history] [--limit <n>] [--offset <n>]
```

Aliases: none.
Complete option contract: `nawabari status --help --json`.

### `guard`

Verify current worktree/session ownership

```
nawabari guard [--session <id>] [--operation <name> --resource <path>]
```

Aliases: none.
Complete option contract: `nawabari guard --help --json`.

### `gc`

Detect or clean eligible stale sessions

```
nawabari gc [--dry-run|--apply]
```

Aliases: none.
Complete option contract: `nawabari gc --help --json`.

### `doctor`

Check local Nawabari prerequisites and reconciliation

```
nawabari doctor [--summary]
```

Aliases: none.
Complete option contract: `nawabari doctor --help --json`.

### `migrate`

Migrate legacy resource-claim registry state

```
nawabari migrate
```

Aliases: none.
Complete option contract: `nawabari migrate --help --json`.

### `capabilities`

Describe the standalone CLI/JSON contract

```
nawabari capabilities
```

Aliases: none.
Complete option contract: `nawabari capabilities --help --json`.
