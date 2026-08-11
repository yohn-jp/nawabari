# Nawabari

Nawabari is a standalone local Git/session ownership layer for parallel coding
agents. It gives each active session one exclusively owned worktree and one
mutable branch. It works without GitHub, `gh`, a network connection, Mottainai,
or a particular agent runtime.

Nawabari governs operations routed through Nawabari. It is an authorization and
ownership boundary, not an operating-system or filesystem sandbox: a process
that already has filesystem permissions can still edit another worktree
directly.

## Install

```bash
npm install -g nawabari
```

The package installs `nawabari` for direct use and `git-nawabari` for Git's
`git nawabari` external subcommand. Both names use the same entry point.

```bash
git nawabari --help
nawabari --version
```

## Session lifecycle

Session IDs are generated automatically as UUIDv7 values. They are immutable
machine identities; labels and branch names are separate display metadata.

```bash
git nawabari session create --branch feature/example --worktree ../example-worktree --json
git nawabari session id --json
git nawabari session show --json
git nawabari session list --json
git nawabari status --json
git nawabari guard --json
git nawabari session close --json
git nawabari gc --dry-run --json
git nawabari doctor --json
```

`session create` provisions a dedicated worktree and mutable branch atomically
under the repository-scoped mutation lock. The default/integration worktree
and its protected branch cannot be session resources. `session id` and the
other current-session commands resolve ownership from the current worktree;
callers do not need to repeat the session ID.

Close is conservative. Dirty worktrees, ambiguous ownership, mismatched Git
state, and commits not proven reachable from the integration branch block
destructive cleanup. A clean close releases only the owned worktree and
branch, and repeating close is idempotent. `gc` detects stale or interrupted
sessions; `--apply` uses the same close safety checks and reports blocked
sessions instead of guessing.

## Ownership guard

`git nawabari guard` is a cheap, side-effect-free authorization decision for a
Nawabari-governed mutation. It reads the current repository/worktree/branch and
the same authoritative session registry used by provisioning and lifecycle
operations. An optional `--session` asserts the caller's session identity.

```bash
decision=$(git nawabari guard --session "$NAWABARI_SESSION_ID" --json) || {
  printf '%s\n' "$decision" >&2
  exit 1
}
```

An allowed decision has `allowed: true` and `code: "ALLOWED"`. A denied
decision has `allowed: false`, a stable code such as
`WORKTREE_OWNED_BY_OTHER_SESSION`, `PROTECTED_WORKTREE`, or
`OWNERSHIP_MISMATCH`, and a non-zero exit status. Detached, corrupt, missing,
or conflicting state fails closed. The guard does not install hooks and does
not prevent direct filesystem writes outside Nawabari.

## Orchestrator integration

An external orchestrator can create a session, capture the returned
`session_id`, launch its worker with the returned `worktree` as `cwd`, and
check the guard before each Nawabari-governed mutation:

```bash
created=$(git nawabari session create --branch feature/task --json)
session_id=$(printf '%s' "$created" | jq -r .session_id)
worktree=$(printf '%s' "$created" | jq -r .worktree)

(cd "$worktree" && git nawabari guard --session "$session_id" --json)
# run the worker in "$worktree"
git nawabari session close --session "$session_id" --json
```

The orchestrator owns scheduling, prompts, and worker lifetime; Nawabari owns
only local session identity, worktree/branch ownership, and safe cleanup. No
Mottainai, GitHub, `gh`, network, or agent-runtime dependency is required.

## Repository state and concurrency

The authoritative registry is stored in the repository-common Git directory at
`.git/nawabari/session-registry.json`; linked worktrees therefore share one
registry. It records the schema version, repository identity, immutable session
ID, canonical worktree and branch identities, lifecycle state, and timestamps.

Ownership-changing writes use an exclusive repository-local lock and a synced
temporary file followed by atomic replacement. Concurrent creation cannot
silently duplicate an active worktree or branch. Lock recovery is conservative:
the lock records a random token, PID, host, and process-start identity; an
owner is reclaimed only when the same host proves that exact process identity
is dead. Invalid, remote, or otherwise unverifiable lock metadata is never
stolen and fails closed so an operator can inspect or remove it deliberately.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
