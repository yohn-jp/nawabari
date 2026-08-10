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

The authoritative registry lives in the repository-common Git directory at
`gitpaw/registry.json`. This location is shared by every worktree of the same
repository. `RepositoryRegistry` is the single mutation boundary: its
`create`, `claim`, `close`, `release`, and `gc` operations all acquire the same
repository-scoped local lock before reading, validating, and committing state.
The callback supplied to each operation owns higher-level product semantics;
the boundary does not implement worktree provisioning or lifecycle policy.

The lock is a local directory lock at `gitpaw/registry.lock`, created with an
exclusive filesystem operation. It is intentionally not a distributed lock
and does not coordinate different clones or machines. Lock metadata contains a
random token, host, PID, and (where available) the process start token. A
contender waits for a live owner and returns typed `LOCK_BUSY` on timeout.
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

The registry document is versioned and rejects corrupt JSON, unsupported schema
versions, duplicate session IDs, and duplicate active worktree/branch
ownership. Closed records may remain as history and no longer reserve their
resources. `RegistryError.code` and `RegistryLockError.code` are the stable
machine-readable outcomes for callers.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
