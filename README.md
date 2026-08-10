# GitPaw

GitPaw is a standalone local Git/session ownership layer for parallel coding
agents. It gives each active session one exclusively owned worktree and one
mutable branch. It works without GitHub, `gh`, a network connection, Mottainai,
or a particular agent runtime.

GitPaw governs operations routed through GitPaw. It is an authorization and
ownership boundary, not an operating-system or filesystem sandbox: a process
that already has filesystem permissions can still edit another worktree
directly.

## Install

```bash
npm install -g git-paw
```

The package installs the `git-paw` executable, which Git discovers as the
`git paw` external subcommand.

```bash
git paw --help
git-paw --version
```

## Session lifecycle

Session IDs are generated automatically as UUIDv7 values. They are immutable
machine identities; labels and branch names are separate display metadata.

```bash
git paw session create --branch feature/example --worktree ../example-worktree --json
git paw session id --json
git paw session show --json
git paw session list --json
git paw status --json
git paw guard --json
git paw session close --json
git paw gc --dry-run --json
git paw doctor --json
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

`git paw guard` is a cheap, side-effect-free authorization decision for a
GitPaw-governed mutation. It reads the current repository/worktree/branch and
the same authoritative session registry used by provisioning and lifecycle
operations. An optional `--session` asserts the caller's session identity.

```bash
decision=$(git paw guard --session "$GITPAW_SESSION_ID" --json) || {
  printf '%s\n' "$decision" >&2
  exit 1
}
```

An allowed decision has `allowed: true` and `code: "ALLOWED"`. A denied
decision has `allowed: false`, a stable code such as
`WORKTREE_OWNED_BY_OTHER_SESSION`, `PROTECTED_WORKTREE`, or
`OWNERSHIP_MISMATCH`, and a non-zero exit status. Detached, corrupt, missing,
or conflicting state fails closed. The guard does not install hooks and does
not prevent direct filesystem writes outside GitPaw.

## Repository state and concurrency

The authoritative registry is stored in the repository-common Git directory at
`.git/git-paw/session-registry.json`; linked worktrees therefore share one
registry. It records the schema version, repository identity, immutable session
ID, canonical worktree and branch identities, lifecycle state, and timestamps.

Ownership-changing writes use an exclusive repository-local lock and a synced
temporary file followed by atomic replacement. Concurrent creation cannot
silently duplicate an active worktree or branch. Lock recovery is conservative:
an owner that cannot be proven dead is never stolen, so ambiguous recovery
fails closed.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
