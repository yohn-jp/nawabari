# GitPaw

GitPaw is a local Git/session ownership layer for parallel coding agents. The
repository registry is a persistence boundary for later session, worktree, and
lifecycle commands; it does not provide an OS sandbox or network coordination.

## Install

```bash
npm install -g @OWNER/PACKAGE_NAME
```

## Usage

```bash
PACKAGE_NAME --help
```

## Registry concurrency and atomicity

The authoritative registry is supplied by the domain registry in the
repository-common Git directory. `RegistryMutationBoundary` is the single
concurrency/atomicity boundary: its `create`, `claim`, `close`, `release`, and
`gc` operations all acquire the same repository-scoped local lock before
reading, validating, and committing state. The domain supplies a codec and may
configure its existing registry path, schema, and resource model. The callback
supplied to each operation owns higher-level product semantics; this boundary
does not implement session identity, worktree provisioning, or lifecycle
policy.

By default the boundary uses `gitpaw/registry.json` and a local directory lock
at `gitpaw/registry.lock`, created with an exclusive filesystem operation. The
domain can point it at an existing common-state authority such as
`git-paw/session-registry.json` and its corresponding lock path. It is
intentionally not a distributed lock and does not coordinate different clones
or machines. Lock metadata contains a random token, host, PID, and (where
available) the process start token. A contender waits for a live owner and
returns typed `LOCK_BUSY` on timeout.
Expired locks are reclaimed only when the owner is on the local host and its
PID/start token can be proven dead. Remote, malformed, unverifiable, or
ambiguous locks return typed `LOCK_STALE`/`LOCK_INVALID` outcomes and are never
silently stolen.

Registry writes use a same-directory temporary file, file sync, and atomic
rename followed by a directory sync. Readers open only the authoritative
`registry.json`, so a crash before rename leaves the previous complete document
in place; an orphan temporary file is ignored. A crash after taking the lock
leaves a recoverable lock only when the conservative stale-owner proof above is
available. Otherwise retry fails closed until an operator or a future explicit
recovery policy resolves the ambiguity.

The codec owns the versioned document and rejects corrupt JSON, unsupported
schema versions, and domain-specific ownership conflicts. `RegistryError.code`
and `RegistryLockError.code` are the stable machine-readable outcomes for
callers.

## Session lifecycle and safe cleanup

`session close` operates only on the selected session (or the session owning
the current worktree). It verifies the registry ownership against Git's local
worktree inventory, refuses dirty or ambiguous worktrees, and refuses to delete
a branch whose commits are not proven reachable from the repository's
integration branch. A clean provisioned session transitions through
`closing` to `closed`; the `closing` state is retained if an operation is
interrupted so a later close or `gc --apply` can retry safely. Repeating close
for a closed session is an idempotent success.

```bash
git paw session close --json
git paw session close --session <session-id> --json
git paw gc --dry-run --json
git paw gc --apply --json
```

`gc` is detection-only by default. A session is a candidate when it is already
`stale`, a close is in progress, its `updated_at` is older than the default
24-hour stale threshold, or its worktree path is missing. `gc --apply` first
marks candidates stale, then applies the same close safety checks. Dirty,
ambiguous, ownership-mismatched, or recoverable-commit sessions remain in the
registry and are returned in the machine-readable `blocked` list. Missing
resources are cleaned only when the remaining branch state is proven safe.

GitPaw governs operations routed through GitPaw; it cannot prevent a process
with filesystem permission from editing or deleting another worktree directly.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
