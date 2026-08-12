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

## Standalone machine contract

The installed CLI/JSON surface is the integration boundary. An orchestrator
must discover the contract before using the lifecycle:

```bash
nawabari capabilities --json
nawabari --version --json
```

Both discovery commands work without a Git repository. A compatible
installation reports `contract_id: "nawabari.standalone-execution.v1"` and
`schema_version: 1`. The capability response lists the exact commands,
result-schema versions, identity fields, and stable `failure_codes`. The
package version is release metadata; it is not a substitute for the
machine-contract identifier.

The supported standalone sequence is:

```text
session create -> session claim(s) -> authorize/checkpoint
-> commit/push -> doctor (reconciliation) -> session close/gc
```

The JSON envelope is one document on stdout. Success has `ok: true`, a
`command`, and the command's versioned result fields. Failure has `ok: false`,
the `command`, a stable `code`, a bounded human-readable `message`, and
optional structured `details`; JSON mode writes no decorative stderr. Exit
codes are `0` success, `2` usage, `3` rejected/unsafe operation, `4`
unavailable capability, `5` failed doctor checks, and `70` unexpected internal
failure. Consumers must use these fields and codes, never human presentation.

The result schemas expose the following identities:

| Surface                | Versioned identities                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| session lifecycle      | `session_id`, `repository`, `worktree`, `branch`, `state`                        |
| claims                 | `claim_id`, `session_id`, `resource`, `mode`                                     |
| authorization          | `operation`, `allowed`, `code`, `claim_ids`                                      |
| checkpoint evidence    | `head`, `changed`, `staged`, `unstaged`, `untracked`, `in_claim`, `out_of_claim` |
| commit/push            | `commit_sha`, `remote`, `branch`, `target`, `relation`                           |
| reconciliation/cleanup | `clean`, `issues`, `candidates`, `cleaned`, `blocked`, `recovery_hints`          |

Git subprocesses are bounded at 10 seconds and 64 KiB of output; checkpoint
evidence is bounded to 4,096 paths. `GIT_SPAWN_FAILED`, `GIT_TIMEOUT`,
`GIT_OUTPUT_LIMIT`, and `GIT_COMMAND_FAILED` remain distinct failure codes.
The local lifecycle requires Git and the repository-local registry/lock only;
it does not require Mottainai, GitHub, `gh`, network access, an LLM, or a
coding-agent runtime.

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

`status --json` reports the resolved `managed_worktree_root` used when
`session create` omits `--worktree`. `session create --help --json` describes
all four create options as optional and reports defaults for branch, worktree,
base (`HEAD`), and label.

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
sessions instead of guessing. `gc --dry-run` performs the same non-mutating
cleanup preflight and includes stable blocker codes and `recovery_hints` for
every candidate that is not safe. Cleanup revalidates the physical worktree,
branch, and `HEAD` observations immediately before each destructive Git
operation.

Routine `session list` and `status` output excludes `closed` history and is
limited to 64 records. Use `--all` (or `--history`) for an explicit complete
history view; closed records remain persisted and are never silently deleted
by listing or cleanup.

`gc` stale eligibility is separate from closed-history retention. Its default
threshold is 24 hours (`86,400,000` ms), measured from persisted `updated_at`;
records already in `stale` or `closing` state are eligible, and an otherwise
live record is also eligible when Git reports its registered worktree as
missing or prunable. Physical Git/worktree state is authoritative for that
check. `gc --dry-run` and `gc --apply` do not treat a closed record as a stale
cleanup candidate.

`doctor` includes a non-destructive `reconciliation` check. It reports
registry/Git ownership drift, including missing or prunable worktrees and
unregistered physical worktrees, without repairing or deleting anything.

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

Mottainai is one optional caller of this contract, not a runtime dependency.
It may retain task semantics, scheduling, validation policy, Issue/PR
governance, and worker lifetime. It must pass concrete local declarations to
Nawabari and retain the returned JSON identities. Nawabari does not import or
execute Mottainai/GitHub workflow code, infer claims from task text, or create
a second registry/database.

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
`MISSING_RESOURCE_CLAIM`, `INSUFFICIENT_CLAIM_MODE`, `RESOURCE_CLAIM_CONFLICT`,
`INVALID_RESOURCE`, and
the existing ownership/physical-observation codes.

`INSUFFICIENT_CLAIM_MODE` means a matching claim exists but its granted mode
is weaker than the operation requires. Its bounded details identify the
resource, required access, and matching granted mode names;
`MISSING_RESOURCE_CLAIM` remains reserved for an absent matching claim.

**`authorize` returns an authorization decision only; it does NOT execute the
operation itself.** Governed commit and push execution use this same decision
path before invoking bounded Git subprocesses.

```bash
git nawabari authorize --session "$NAWABARI_SESSION_ID" \
  --operation source-write --resource src/example.ts --json
```

Governed commit accepts only a caller-decided final message and explicit
repository-relative resources. Every resource must be covered by an active
`exclusive-write` claim; all Git-visible changed/staged paths must be in the
explicit list. JSON includes the resulting `commit_sha`.

```bash
git nawabari commit --session "$NAWABARI_SESSION_ID" \
  --message 'record the local change' --resource src/example.ts --json
```

An optional `--message-pattern <regex>` validates the final message against a
caller-declared rule before Git is invoked; Nawabari does not own or infer
commit-message conventions (such as Conventional Commits) itself, so this
check runs only when a caller explicitly supplies a pattern, and a mismatch
fails with `INVALID_COMMIT_MESSAGE` before anything is staged. A repository's
own `commit-msg` Git hook (if any) still runs normally, since governed commit
invokes real `git commit`.

```bash
git nawabari commit --session "$NAWABARI_SESSION_ID" \
  --message 'feat: record the local change' --resource src/example.ts \
  --message-pattern '^(feat|fix|docs|refactor|test|chore): .+$' --json
```

Governed push requires explicit claim-covered resources and an explicit
`--remote`/`--branch` target. Existing upstream and local/remote relation are
inspected before mutation. A missing upstream requires `--create-upstream`;
behind or diverged history requires explicit `--force`, which uses
`--force-with-lease`. The JSON result identifies the pushed `target` and
reports its relation.

```bash
git nawabari push --session "$NAWABARI_SESSION_ID" \
  --remote origin --branch feature/example --resource src/example.ts --json
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

An explicit `--base` ref that is empty, malformed, or does not resolve to a
commit fails with `INVALID_BASE_REF`. The bounded JSON details retain the
rejected ref, identify `HEAD` as the default recovery base, and include the
retry hint to omit `--base`; Nawabari does not enumerate or fuzzy-search refs.

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

### Conformance and extraction boundary

The packed-package suite exercises the complete standalone sequence, including
cross-process claim conflicts, governed commit/push, reconciliation, retryable
cleanup, and prunable worktree recovery. Native tests additionally cover
process interruption/atomic-write recovery, partial staging or commit failure,
stale physical state, cleanup races, bounded subprocess failures, and
idempotency (`src/registry/store.test.ts`, `src/git-mutation.test.ts`,
`src/cleanup-authority.test.ts`, `src/session-lifecycle.test.ts`, and
`scripts/smoke-test.mjs`).

The relevant Mottainai #28 execution cases are mapped as follows:

- repository/worktree identity, provisioning path safety, branch collision,
  symlink escape, local staging/commit/push safety, cleanup revalidation, and
  reconciliation are Nawabari-native authority and tests;
- task semantics, prompts, validation evidence policy, Conventional Commit and
  PR/Issue governance, GitHub operations, and agent hooks remain optional
  orchestrator-only semantics and must not move into Nawabari.

Run `pnpm run test:package` to validate the exact packed tarball and its
installed CLI, or `pnpm run verify` for the complete local conformance gate.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
