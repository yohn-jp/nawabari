# GitPaw

GitPaw is a standalone local Git/session primitive. This repository currently
provides the foundational repository-scoped session registry used by later
worktree and lifecycle features. It does not require GitHub, a network
connection, Mottainai, or a particular agent runtime.

## Session registry

`SessionRegistry` stores authoritative state in the common Git directory at
`.git/git-paw/session-registry.json`. The path is resolved through
`git rev-parse --git-common-dir`, so linked worktrees share one registry.

Session IDs are automatically generated UUIDv7 values. Their 48-bit
millisecond timestamp supports useful ordering and their random portion makes
local concurrent creation collision-resistant without a central coordinator.
IDs are immutable; the optional `label` is display metadata and is never used
to identify or own a session.

The versioned record contains the repository identity, canonical worktree
identity/path, canonical branch identity, lifecycle state, and UTC creation
and update timestamps. Writers take an exclusive lock in the same common Git
state and replace the registry through a synced temporary file and atomic
rename. Invalid JSON, unsupported schema versions, repository identity
mismatches, duplicate session IDs, and conflicting active resource ownership
are rejected with typed errors; ambiguous state is not repaired implicitly.

The domain API is independent of CLI output:

```ts
import { SessionRegistry } from "./src/session-registry.js";

const registry = new SessionRegistry({ cwd: process.cwd() });
const session = registry.create({ label: "reviewer" });
console.log(session.sessionId, session.worktreePath, session.branchName);
console.log(registry.resolveCurrentSession().sessionId);
```

This registry records existing worktree and branch identities; provisioning,
cleanup, lifecycle transitions, and hook/orchestrator integration are handled
by later issues. GitPaw governs operations that use its APIs and is not an
operating-system or filesystem sandbox.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
