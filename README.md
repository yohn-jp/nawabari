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

## Session resource claims

Resource claims are versioned, session-scoped ownership records stored in the
same repository registry and protected by the same mutation lock. They are
caller declarations; Nawabari does not infer them from task text or source
code. Claim JSON exposes `schema_version`, `claim_id`, `session_id`, the
repository/worktree identities, canonical `resource`, `mode`, and timestamps.
The initial claim schema version is `1` and supports `read`, `write`, and
`exclusive-write`.

```bash
git nawabari session claim --session "$NAWABARI_SESSION_ID" \
  --resource 'src/**/*.ts' --mode read --json
git nawabari session claims --session "$NAWABARI_SESSION_ID" --json
git nawabari session update --session "$NAWABARI_SESSION_ID" \
  --resource 'src/**/*.ts' --mode write --json
git nawabari session release --session "$NAWABARI_SESSION_ID" --json
```

Overlapping claims use this complete compatibility matrix; non-overlapping
claims are compatible for every mode:

| existing \/ requested | read       | write    | exclusive-write |
| --------------------- | ---------- | -------- | --------------- |
| read                  | compatible | conflict | conflict        |
| write                 | conflict   | conflict | conflict        |
| exclusive-write       | conflict   | conflict | conflict        |

Claims use canonical repository-relative POSIX paths. Literal path segments,
`*`/`?` segment wildcards, and a complete `**` segment are supported. Empty,
`.`/`..`, absolute, drive-relative, backslash, unsupported-glob, and
symlink-escaping forms are rejected with stable machine-readable codes.
Equivalent claim acquisition and release retries are idempotent. Closing or
garbage-collecting a session releases its claims; no separate claim registry
or claim lock exists. Claims describe ownership state only and do not provide
OS-level filesystem observation or a filesystem sandbox.

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
`WORKTREE_OWNED_BY_OTHER_SESSION`, `PROTECTED_WORKTREE`, `DETACHED_HEAD`,
`WORKTREE_MISMATCH`, or `OWNERSHIP_MISMATCH`, and a non-zero exit status.
Detached, corrupt, missing, or conflicting state fails closed. The guard does
not install hooks and does not prevent direct filesystem writes outside
Nawabari.

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

## Claim-aware operation authorization

`authorize` is the single decision surface for a governed local operation. Its
versioned vocabulary and required claim access are:

| operation         | required access   |
| ----------------- | ----------------- |
| `source-write`    | `write`           |
| `stage`           | `write`           |
| `commit`          | `exclusive-write` |
| `branch-mutation` | `exclusive-write` |
| `push`            | `exclusive-write` |
| `cleanup`         | `exclusive-write` |

The request contains a session identity, an operation, and concrete
repository-relative resources. Nawabari independently verifies the current
repository, owned worktree, branch, active session, and persisted claims;
caller-supplied labels do not weaken that decision. The JSON result is the
automation contract and reports stable allow/deny codes such as
`MISSING_RESOURCE_CLAIM`, `RESOURCE_CLAIM_CONFLICT`, `INVALID_RESOURCE`, and
the existing ownership/physical-observation codes.

```bash
git nawabari authorize --session "$NAWABARI_SESSION_ID" \
  --operation source-write --resource src/example.ts --json
```

`checkpoint --json` captures bounded Git-observable `changed`, `staged`,
`unstaged`, and `untracked` path sets, canonicalizes them through the same
resource model, and reports `in_claim` and `out_of_claim` paths. Checkpoint
evidence is limited to the state Git exposes at that instant. Direct
filesystem activity that is reverted, ignored, or otherwise not observable in
the Git checkpoint is outside Nawabari's guarantee; this feature is not an
OS-level filesystem monitor.

## Physical execution context

Nawabari treats Git and the canonical filesystem as the authority for every
governed session context. It independently observes the repository common
directory, worktree path, current branch, and current `HEAD`, then compares
those observations with the session registry. Caller-supplied paths and branch
labels are expectations only; they are never used to replace an observation
Git can make.

The shared verifier fails closed with stable registry reasons for detached
`HEAD`, missing or prunable worktrees, repository/worktree/branch mismatches,
stale or conflicting registry ownership, ambiguous Git state, and unavailable
physical observations. Git process failures remain distinct and bounded:
spawn failure, timeout, output-limit, and non-zero/unexpected exit.

Provisioning canonicalizes the managed root and every existing path segment
before invoking Git. Traversal, symlink/intermediate-segment escapes, existing
worktree paths, and existing local branches are rejected deterministically;
the repository lock serializes Nawabari provisioning and Git's own ref checks
remain the final collision authority.

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
