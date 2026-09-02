# Nawabari

Nawabari is a standalone local Git/session ownership layer for parallel coding
agents. It gives each active session one exclusively owned worktree and one
mutable branch. It works without GitHub, `gh`, a network connection, Mottainai,
or a particular agent runtime.

Nawabari governs operations routed through Nawabari. By default it is an
authorization and ownership boundary, not an operating-system or filesystem
sandbox: a process that already has filesystem permissions can still edit
another worktree directly. This default (legacy) mode is unchanged.

The opt-in protected session mode defines a Linux-only OS/filesystem/process
enforcement boundary underneath the existing session/worktree/resource
authority (`src/domain/sandbox.ts`, contract
`nawabari.sandbox-execution.v1`). It binds one existing Nawabari session
resolved through the authoritative registry/guard path to a typed sandbox
execution request; it does not create a second session identity. A
machine-readable capability/doctor report distinguishes required Linux
primitives (bubblewrap, user/mount/PID/IPC/UTS namespaces, the versioned
seccomp baseline, and capability reduction) from optional defense-in-depth
primitives (cgroups v2 and Landlock). When protected execution is requested and a required capability
is unavailable or the platform is unsupported, resolution fails closed and
never returns a request that claims the legacy unsandboxed path is
protected. The lower-level contract remains responsible only for capability
detection and the typed request/result shape; `resolveSandboxExecutionRequest()`
returns a request without invoking bubblewrap. The managed `session run`
launcher consumes that request and establishes the protected boundary. Network
mode is honestly reported as `inherited` (shared with the host), not isolated.

`git nawabari session run --session <id> -- <command> [args...]` is the
managed protected execution entry point. It resolves the existing session
through the normal guard authority and compiles a fixed bubblewrap argv; the
command is passed after an argv terminator and is never interpreted by a
shell. Resolution or launch failure never falls back to the legacy ambient
filesystem view.

The canonical profile starts from a private root, mounts only the owned
worktree read-write, gives each session private `/tmp`, `/proc`, HOME and
cache state, and exposes no sibling worktree or control-plane path. A small
repository-owned `nawabari/sandbox/shared-home` subtree is the only HOME state
shared between sessions. Selected host user-tool directories (`~/.local/bin`
and pnpm's user bin when present) are read-only; credentials and the rest of
the host HOME are not mounted. `/dev`, system certificates/configuration, and
the detected runtime are explicit read-only/runtime inputs.

On standalone Linux the profile uses existing `/usr`, `/bin`, `/lib*` and
selected `/etc` paths only when present. On NixOS it additionally selects
`/nix/store`, `/run/current-system`, `/run/wrappers`, and the per-user profile
when present; no `/usr` layout is assumed. Missing required paths or namespace
support produces a stable capability/topology error. The protected child uses
`nawabari.seccomp.v1`, a compatibility-first deny-list whose policy denials
return `EPERM` rather than hanging or terminating ordinary development
subprocess trees. Ambient capabilities are empty (`--cap-drop ALL`). Network
remains inherited by design.

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

The `resource-claims` capability additionally exposes a machine-readable
`claim_set_replacement` object (`commands`, `atomic: true`,
`pairing: "adjacent-resource-mode"`, `idempotent_retry: true`,
`unchanged_on_rejection: true`) describing the atomic multi-claim replacement
surface documented above, so a caller can discover this contract instead of
assuming it from the CLI help text.

Resource-claim semantics are generation `nawabari.resource-claims.v2` with
claim-record schema `2`. The standalone envelope deliberately remains
`nawabari.standalone-execution.v1`: this is a meaning-compatible top-level
identity, while callers select the child resource-claim generation before
operating. A future meaning-changing claim authorization, conflict, transition,
release, or required-mode change must publish a new resource-claim generation
and identity; the package version alone is never a compatibility decision.
The capability binds every lifecycle command and alias to its result schema,
implementation-owned stable failure vocabulary, transition-matrix identity,
CAS/force and rejected-non-mutation guarantees, and deterministic recovery
action schema.

The supported standalone sequence is:

```text
session create -> session claim(s) -> authorize/checkpoint
-> commit/push -> doctor (reconciliation) -> session close/gc
-> explicit session discard only when the selected work is intentionally disposable
```

The JSON envelope is one document on stdout. Success has `ok: true`, a
`command`, and the command's versioned result fields. Failure has `ok: false`,
the `command`, a stable `code`, a bounded human-readable `message`, and
optional structured `details`; JSON mode writes no decorative stderr. Exit
codes are `0` success, `2` usage, `3` rejected/unsafe operation, `4`
unavailable capability, `5` failed doctor checks, and `70` unexpected internal
failure. Consumers must use these fields and codes, never human presentation.

The result schemas expose the following identities:

| Surface                | Versioned identities                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| session lifecycle      | `session_id`, `repository`, `worktree`, `branch`, `state`                                                                           |
| explicit discard       | `previous_head`, `worktree_removed`, `branch_removed`, `released_claims`, `final_state`, final `session.state`/`terminal_operation` |
| claims                 | `claim_id`, `session_id`, `resource`, `mode`, `claim_set_generation`, `previous_claim_set_generation`                               |
| authorization          | `operation`, `allowed`, `code`, `claim_ids`                                                                                         |
| checkpoint evidence    | `head`, `changed`, `staged`, `unstaged`, `untracked`, `in_claim`, `out_of_claim`                                                    |
| repository evidence    | `session_id`, `base_revision`, `head`, `clean`, `paths.stats`, `evidence_hash`                                                      |
| bounded diff           | `from_revision`, `to_revision`, `paths`, `stats`, `patch`, `evidence_hash`                                                          |
| commit/push            | `commit_sha`, `remote`, `branch`, `target`, `relation`                                                                              |
| reconciliation/cleanup | `clean`, `issues`, `candidates`, `cleaned`, `blocked`, `recovery_hints`                                                             |

Git subprocesses are bounded at 10 seconds and 64 KiB of output; checkpoint
evidence is bounded to 4,096 paths. `GIT_SPAWN_FAILED`, `GIT_TIMEOUT`,
`GIT_OUTPUT_LIMIT`, and `GIT_COMMAND_FAILED` remain distinct failure codes.
The local lifecycle requires Git and the repository-local registry/lock only;
it does not require Mottainai, GitHub, `gh`, network access, an LLM, or a
coding-agent runtime.

## Read-only repository evidence

The evidence family is session-addressed and has no task, Issue, semantic, or
GitHub interpretation. It is the physical repository authority for one owned
session:

```bash
git nawabari evidence snapshot --session "$NAWABARI_SESSION_ID" --json
git nawabari diff --session "$NAWABARI_SESSION_ID" --path src/example.ts --json
git nawabari diff --session "$NAWABARI_SESSION_ID" --path src/example.ts \
  --patch --max-bytes 32768 --max-hunks 32 --json
```

`evidence snapshot` verifies the registry's repository/worktree/branch owner,
then reuses checkpoint's exact NUL-safe Git observation for `changed`,
`staged`, `unstaged`, and `untracked` paths. It also reports canonical per-path
stats, `clean`, the current `head`, session state, and an `evidence_hash`.
New sessions persist the exact creation/base revision as `base_revision`;
legacy records that lack this field report `base_revision: null` and
`base_revision_proven: false` rather than inferring it from a mutable ref.

`diff` requires at least one explicit concrete path and never accepts a glob or
an empty repository-wide selection. Stats are returned by default. Patch text
requires `--patch` and is bounded to at most 64 paths, 64 KiB, and 128 hunks;
the caller may request smaller limits. Unrepresentable Git observations fail
with `GIT_STATE_AMBIGUOUS`; a requested path whose stat is not exposed by Git
remains in the result with `available: false` and makes snapshot evidence
`complete: false`, so no path silently disappears.

## Session lifecycle

Session IDs are generated automatically as UUIDv7 values. They are immutable
machine identities; labels and branch names are separate display metadata.

```bash
git nawabari session create --branch feature/example --worktree ../example-worktree --json
git nawabari session id --json
git nawabari session show --json
git nawabari session show <session-id> --json
git nawabari session list --json
git nawabari status --json
git nawabari guard --json
git nawabari session close --json
git nawabari session discard --session <session-id> --json
git nawabari gc --dry-run --json
git nawabari doctor --json
```

`status --json` reports the resolved `managed_worktree_root` used when
`session create` omits `--worktree` and `--worktree-root`. `session create
--help --json` describes all create options as optional and reports defaults
for branch, worktree, worktree root, base (`HEAD`), and label.

`--worktree-root` selects only the parent directory for a new session
worktree; Nawabari still derives the final worktree basename from its own
session-naming contract. It is mutually exclusive with `--worktree`, the
exact-path override. Every session record's `worktree_root` field reports
the resolved parent of that session's worktree.

`session create` provisions a dedicated worktree and mutable branch atomically
under the repository-scoped mutation lock. The default/integration worktree
and its protected branch cannot be session resources. `session id` and the
other current-session commands resolve ownership from the current worktree;
callers do not need to repeat the session ID for current-owner operations.

Session-scoped commands use one target grammar: the canonical `--session <id>`
option is accepted everywhere, and `show`, `inspect`, `claim`, `claims`,
`release`, `update`, `close`, and `discard` also accept one positional
`<session-id>` immediately after the subcommand. Supplying both forms is
rejected as ambiguous. `session discard` always requires one explicit target
and never infers the current worktree owner.

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

`session discard` is the sole explicit destructive abandonment path. It
revalidates repository identity, the selected session, exact worktree/branch
ownership, and session/worktree `HEAD` immediately before each Git mutation.
It may destroy the selected session's unintegrated commits and uncommitted
worktree contents, removes only that session's worktree/branch, releases only
its claims, and records `terminal_operation: "discard"` plus the pre-discard
`HEAD`. It never acts as an implicit fallback for `close`, `gc`, `doctor`, or
reconciliation; sibling sessions remain untouched. A partial failure leaves a
retryable closing record and a repeated discard converges or returns an
explicit terminal idempotent result.

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
The claim schema version is `2` and supports `read`, `write`, and
`exclusive-write`. Schema v1 records use different overlap semantics and are
not interpreted implicitly: an embedding caller must explicitly run
`SessionRegistry.migrate()` before using them.

```bash
git nawabari session claim --session "$NAWABARI_SESSION_ID" \
  --resource 'src/**/*.ts' --mode read --json
git nawabari session claims --session "$NAWABARI_SESSION_ID" --json
git nawabari session update --session "$NAWABARI_SESSION_ID" \
  --resource 'src/**/*.ts' --mode write --force --json
git nawabari session release --session "$NAWABARI_SESSION_ID" --all --force --json
```

`session update` (and its `resource update` alias) atomically replaces a
session's _complete_ claim set in one `updateClaims()` transaction, backed by
the same repository lock as every other mutation. `--resource`/`--mode` are
repeatable to submit a multi-resource desired set in a single call; each
`--resource` must be immediately followed by its own `--mode`, so pairing is
positional adjacency rather than flag order and repeated resources can never
be associated with the wrong mode:

```bash
git nawabari session update --session "$NAWABARI_SESSION_ID" \
  --resource src/a.ts --mode exclusive-write \
  --resource src/b.ts --mode exclusive-write \
  --json
```

If any requested claim in the set is invalid or conflicts, the whole update
is rejected and the session's prior claim set is left unchanged; no partial
or empty intermediate claim state is ever observable. Submitting the same
complete desired set again is idempotent. A successful replacement's JSON
exposes the resulting `claims` together with machine-readable `added` and
`released` claims.

The complete public claim lifecycle is:

```text
session claim/resource claim (additive acquire)
-> session transition/resource transition (one exact-resource mode change)
-> session mutate/resource mutate (atomic exact-resource deltas)
-> session release/resource release (--resource, --claim-id, or explicit --all)
-> session update/resource update (atomic complete-set replacement)
```

All destructive mutations require exactly one `--if-generation` CAS or
explicit `--force`. A stale CAS returns `STALE_CLAIM_SET` without changing
claims or generation. Additive claim is not replacement; selected release
preserves unrelated claims; `--all` is the unambiguous all-claims selector.
An exact contradictory additive claim remains rejected with
`CONTRADICTORY_CLAIM` and may carry the typed `transition-exact-resource`
recovery action, whose generation is directly usable as the transition CAS.

The modes have these normative meanings:

- `read`: a non-mutating access declaration. It is not a consistency lease,
  so it may overlap an ordinary `write` claim.
- `write`: ordinary source-modification authority. It may overlap `read`, but
  not another writer or any `exclusive-write` claim.
- `exclusive-write`: stronger ownership-sensitive mutation authority. It
  excludes every overlapping claim, including `read`.

Overlapping claims use this complete compatibility matrix; non-overlapping
claims are compatible for every mode:

| existing \/ requested | read       | write      | exclusive-write |
| --------------------- | ---------- | ---------- | --------------- |
| read                  | compatible | compatible | conflict        |
| write                 | compatible | conflict   | conflict        |
| exclusive-write       | conflict   | conflict   | conflict        |

Claims use canonical repository-relative POSIX paths. Literal path segments,
`*`/`?` segment wildcards, and a complete `**` segment are supported. Empty,
`.`/`..`, absolute, drive-relative, backslash, unsupported-glob, and
symlink-escaping forms are rejected with stable machine-readable codes.
Equivalent claim acquisition and release retries are idempotent. Closing or
garbage-collecting a session releases its claims; no separate claim registry
or claim lock exists. Claims describe ownership state only and do not provide
OS-level filesystem observation or a filesystem sandbox.

An ordinary source change uses `write` and can proceed while another session
holds a `read` declaration:

```bash
git nawabari session claim --session "$NAWABARI_SESSION_ID" \
  --resource src/example.ts --mode write --json
git nawabari authorize --session "$NAWABARI_SESSION_ID" \
  --operation source-write --resource src/example.ts --json
```

A stronger ownership-sensitive operation uses `exclusive-write` and therefore
requires no overlapping claim:

```bash
git nawabari session claim --session "$NAWABARI_SESSION_ID" \
  --resource src/example.ts --mode exclusive-write --json
git nawabari authorize --session "$NAWABARI_SESSION_ID" \
  --operation commit --resource src/example.ts --json
```

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

## Actionable lifecycle rejections

Stable codes are necessary but not sufficient for a caller to pick a safe
next step without a second, separate inspection. For the codes below,
Nawabari's `details` carry bounded, deterministic evidence and a
`safeActions`/`safe_actions` list of stable, kebab-case next-action
identifiers, in addition to the human-readable `message`. JSON and human
output always render the identical underlying result; only the formatting
differs.

- **`RESOURCE_CLAIM_CONFLICT`** (`session claim`/`session update`,
  `authorize`, `guard --operation`) reports the blocking claim
  (`ownerClaimId`, `ownerResource`, `ownerMode`) and the blocking session's
  canonical identity (`ownerSessionId`, `ownerWorktree`, `ownerBranch`, and
  `ownerLabel` when the session has one) in the same result, so a caller
  never needs a second `session list` scan to find the owner.
- **`PROTECTED_WORKTREE`**/**`PROTECTED_BRANCH`** raised by a live command
  (not by cleanup) add `phase: "execution"` and distinguish the current
  (protected) execution context from the referenced `--session` target:
  `requestedSessionId`, `targetWorktree`, `targetBranch`, and `targetState`
  when that session exists. `safeActions` names the deterministic fix
  (`run-from-managed-session-worktree`, `select-target-session-explicitly`)
  instead of the unrelated cleanup-time hint.
- **`INVALID_SESSION_ID`** stays machine-ID based: an invalid `--session`
  value is never silently reinterpreted as a label. When it exactly and
  unambiguously matches one active session's label, the result adds
  `session_id_hint` (the canonical session ID) and
  `session_label_match: "unique"` as a non-authoritative hint. An ambiguous
  or absent label match never guesses: `session_label_match` reports
  `"ambiguous"` (with `session_label_match_count`) or `"none"` instead.
- **`RECOVERABLE_COMMITS`** raised by `session close` carries the same
  `close_readiness`/`result_state` classification `session inspect` reports
  for the identical state — `external_evidence_required` when ancestry alone
  could not prove the branch safe and a `--integrated-revision` proof might
  resolve it (e.g. after a squash/rebase merge), versus `blocked` when
  supplied evidence failed to prove equivalence, versus `ambiguous` when Git
  observation itself was inconclusive. For supplied evidence, bounded
  `proofFailure` details distinguish an unauthoritative revision from a
  tree-equivalence failure. The bounded evidence also includes
  `currentSessionHead`, `suppliedIntegratedRevision`, `resolvedIntegrationSha`,
  `lineageProof`/`authorityProof`, and `contentProof`. `safe_actions` includes
  `discard-session` only as an explicit user choice; it does not authorize an
  implicit cleanup fallback. Both surfaces reuse one authority, so a raw close
  rejection and `session inspect` never drift apart.

None of the above weakens fail-closed behavior, changes an error code's
meaning, or performs any mutation while producing the rejection.

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

For a worker that must receive the protected filesystem/process boundary, use
the managed launcher instead of starting the worker directly:

```bash
git nawabari session run --session "$session_id" -- node worker.js
```

The launcher owns only the child sandbox topology and process attachment. The
session registry, worktree/branch ownership, resource claims and lifecycle
remain the authoritative Nawabari domain state.

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

Commit evidence distinguishes three sets: the caller's **declared/authorized**
resources (the explicit, claim-covered list a caller passed in), the
**staged** set Git reports as staged immediately before the commit runs, and
the **actual committed** set — read back from the resulting commit itself via
a bounded, NUL-safe `git diff-tree` observation, not inferred from staging
intent. The `resources` field in a successful `commit --json` result is
always the actual committed set, proven equal to or a subset of the
authorized resources; if Git staging/index drift between staging and the
commit (a hook, a concurrent process) causes the actual commit to contain a
path outside the authorized set, the result is not reported as an ordinary
successful commit — it fails with `COMMIT_RESULT_DIVERGED`, which retains the
resulting `commitSha` (the Git commit already happened) alongside the
authorized, actual, and divergent path sets for recovery/reconciliation.

```bash
git nawabari commit --session "$NAWABARI_SESSION_ID" \
  --message 'record the local change' --resource src/example.ts --json
```

An optional `--message-pattern <regex>` validates the final message against a
caller-declared rule before Git is invoked; Nawabari does not own or infer
commit-message conventions (such as Conventional Commits) itself, so this
check runs only when a caller explicitly supplies a pattern, and a mismatch
fails with `INVALID_COMMIT_MESSAGE` before anything is staged. The pattern is
bounded to 512 characters and is evaluated before the repository lock is
acquired, so a pathological caller-supplied pattern cannot stall other
sessions' governed operations. A repository's own `commit-msg` Git hook (if
any) still runs normally, since governed commit invokes real `git commit`.

```bash
git nawabari commit --session "$NAWABARI_SESSION_ID" \
  --message 'feat: record the local change' --resource src/example.ts \
  --message-pattern '^(feat|fix|docs|refactor|test|chore): .+$' --json
```

Governed push requires explicit claim-covered resources and an explicit
`--remote`/`--branch` target. Existing upstream and local/remote relation are
inspected before mutation. A missing upstream requires `--create-upstream`;
behind or diverged history requires explicit `--force`. Force pushes use an
exact `--force-with-lease` bound to the observed remote branch SHA; non-force
pushes rely on `--no-force` without any lease option. Nawabari fetches only
the explicit remote branch into a disposable ref when local ancestry is
missing; it does not update tracking refs or fetch unrelated branches/tags.
The JSON result includes the immutable `source_sha`, explicit `target_ref`,
observed `observed_remote_sha`, and relation.

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

Checkpoint canonicalization fails closed: a Git-reported path that cannot be
represented as a canonical repository resource (traversal, symlink escape, or
syntax reserved for the claim/glob model) never disappears from evidence.
Checkpoint fails the whole observation with `GIT_STATE_AMBIGUOUS` instead of
silently omitting the path, so a caller can never mistake an unrepresentable
observation for a clean one. This mirrors the strictness governed mutation
already applies to the same Git-observed paths, so checkpoint evidence is
never weaker than mutation authorization.

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
