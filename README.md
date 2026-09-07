# Nawabari

Nawabari is a local governance layer for parallel coding agents. It gives each
agent session an owned Git worktree and branch, records which repository
resources that session may use, and checks those boundaries before governed
mutations.

It is for teams and tools that need several agents to work in one repository
without silently sharing a worktree, overwriting one another's files, or
guessing whether a session is safe to close. Nawabari is local-first: the
session registry, Git observations, and authorization decisions do not require
GitHub, `gh`, a network connection, or a particular agent runtime.

This README describes the current 0.9.x product model. It is an overview and
navigation surface, not a copy of the generated contracts or implementation
history.

The product model is intentionally small:

1. Create a session. Nawabari provisions a dedicated worktree and branch.
2. Claim the resources the session is allowed to use.
3. Route governed work through claims, evidence, and mutation authorization.
4. Inspect the result, then close the session only when integration is proven.

Nawabari governs operations that are routed through Nawabari. A normal
governed session is an ownership and authorization boundary, not an operating
system or filesystem sandbox. A process that already has filesystem
permissions can still edit another worktree directly; Nawabari does not claim
to prevent that ambient access.

## Install

Node.js 24 or newer is required.

```bash
npm install -g nawabari

nawabari --version
git nawabari --help
```

The package installs both `nawabari` and `git-nawabari`. They use the same
entry point, so `git nawabari ...` works as Git's external subcommand.

## First session

Run the following from the repository's ordinary integration worktree. The
JSON result from `session create` contains the machine session identity and
the worktree path chosen by Nawabari.

```bash
# Optional but recommended for an orchestrator: discover the installed contract first.
nawabari capabilities --json

created=$(git nawabari session create --branch feature/example --worktree ../example-worktree --json)
session_id=$(printf '%s' "$created" | jq -r .session_id)
worktree=$(printf '%s' "$created" | jq -r .worktree)

# Claims are repository-relative and belong to the session's worktree.
(cd "$worktree" && git nawabari session claim --session "$session_id" --resource src/example.ts --mode exclusive-write --json)

# Check the same boundary before a governed source mutation.
(cd "$worktree" && git nawabari guard --session "$session_id" --operation source-write --resource src/example.ts --json)

# The agent edits only its owned worktree.
(cd "$worktree" && "$EDITOR" src/example.ts)

# Capture bounded Git evidence, then commit the claimed changed resources.
(cd "$worktree" && git nawabari checkpoint --session "$session_id" --json)
(cd "$worktree" && git nawabari commit --session "$session_id" --all-claimed --message "Update example" --json)
```

`--all-claimed` is an explicit resource selector. It resolves safely observed
Git-changed paths covered by qualifying commit claims; it does not bypass
claim authorization. Use repeated `--resource <path>` when an explicit path
list is preferable.

After reviewing and integrating the session branch into the repository's
integration branch, inspect and close it:

```bash
git nawabari session inspect --session "$session_id" --json
git nawabari session close --session "$session_id" --json
```

Close is conservative. Unintegrated commits, dirty worktrees, ambiguous Git
state, and ownership mismatches remain blocked. For a squash or rebase merge,
pass an exact local `--integrated-revision <rev>` so Nawabari can re-verify the
content independently. It never treats a remote provider or a caller's claim
as proof by itself.

## The authority model

Each boundary has one job and one local authority. The README summarizes the
contract; executable code and machine-readable projections remain authoritative
for exact schemas, transitions, and failure vocabularies.

| Boundary               | What it answers                                                                                                      | Typical commands                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Session lifecycle      | Which session owns a worktree/branch, and whether it is active, ready to close, blocked, stale, discarded, or closed | `session create`, `session show`, `session inspect`, `session close`   |
| Resource Claims        | Which session has `read`, `write`, or `exclusive-write` access to a canonical repository path or supported glob      | `session claim`, `session claims`, `session update`, `session release` |
| Mutation authorization | Whether a concrete operation has the required claim strength and no conflicting owner                                | `guard`, `authorize`, `commit`, `push`                                 |
| Repository evidence    | What Git can observe about paths, `HEAD`, changes, ancestry, and bounded diffs                                       | `checkpoint`, `evidence snapshot`, `diff`                              |
| Protected execution    | Whether a command runs inside an opt-in Linux process/filesystem boundary                                            | `session run`, `session exec`, `doctor`                                |

Claims are not task labels and do not encode GitHub or agent semantics. A
`write` claim permits ordinary path changes; `exclusive-write` is required for
operations that finalize or mutate shared Git state, such as `commit` and
`push`. Conflicting or ambiguous claims fail closed. Complete claim-set
replacement and exact-resource mutation are atomic and support an explicit
generation check or an explicit `--force` intent.

The default governance path does not install hooks and does not prevent direct
filesystem writes outside Nawabari. Its guarantee is that Nawabari-routed
operations consult the authoritative local session registry, physical Git
state, and resource claims before they mutate.

## Session and resource lifecycle

The normal path is:

```text
session create
      ↓
active session → claim resources → guard/checkpoint → commit or push
      ↓                                              ↓
  inspect readiness                         integrate the branch
      ↓                                              ↓
session close  ←────────────────────────────────────┘
```

If work is not integrated, `session inspect` reports bounded blockers and safe
next actions. Retain the session, provide independently verifiable integration
evidence, or explicitly discard the selected session. Discard is never an
implicit fallback for close or garbage collection.

The Session lifecycle is backed by the executable XState authority in 0.9.x
and exposed to callers through public state, contract, and manifest
projections. Consumers use those projections rather than internal machine
nodes or actor objects.

### Claims

Claims are canonical, repository-relative resource records attached to a
session. The supported modes are:

- `read`: observe a resource.
- `write`: change a resource without claiming exclusive ownership.
- `exclusive-write`: change a resource while excluding overlapping claims;
  required for finalizing operations such as commit and push.

Useful flows include:

```bash
# Add one claim.
git nawabari session claim --session "$session_id" --resource src/example.ts --mode exclusive-write --json

# List the canonical claims.
git nawabari session claims --session "$session_id" --json

# Replace the complete set atomically. Pair each resource with its mode.
git nawabari session update --session "$session_id" --resource src/example.ts --mode exclusive-write --resource test/example.test.ts --mode write --if-generation 1 --json

# Release every claim only with explicit destructive intent.
git nawabari session release --session "$session_id" --all --force --json
```

The resource aliases (`resource claim`, `resource update`, `resource list`,
and related forms) are discoverable through help. Use `--help --json` rather
than copying option metadata into an integration.

### Inspect, close, discard, and garbage collection

`session inspect` is read-only and uses the same close/cleanup evidence as
`session close`. It is the preferred preflight for a caller that needs to
decide what to do next.

```bash
git nawabari session inspect --session "$session_id" --json
git nawabari session discard --session "$session_id" --preview --json
```

`session discard` requires an explicit session ID and may destroy unintegrated
commits and uncommitted work in that selected session's worktree. Preview
reports the bounded destructive scope without mutating anything. The actual
discard revalidates repository, worktree, branch, `HEAD`, and registry
ownership before each destructive step.

`gc --dry-run` reports stale candidates and their blockers. `gc --apply` only
cleans candidates that pass the same safety checks as close; elapsed age alone
is not destructive authority. `doctor` reports prerequisite and reconciliation
state without silently repairing ownership.

## Governed Git work

Use `guard` or `authorize` when an orchestrator needs a decision before a
mutation. Both expose stable machine fields such as `allowed`, `operation`,
`code`, and the matching claim IDs. The current operation vocabulary is
discoverable from the CLI, and includes `source-write`, `stage`, `commit`,
`branch-mutation`, `push`, and `cleanup`.

`checkpoint` and `evidence snapshot` describe Git-observable facts only. They
do not infer task meaning, Issue ownership, or review status. `diff` requires
explicit concrete paths and bounds optional patch output.

Commit and push always retain the existing claim checks. Push requires an
explicit remote and target branch; network access is not implicit in local
session lifecycle operations.

```bash
# Explicit resource selection.
git nawabari commit --session "$session_id" --message "Update example" --resource src/example.ts --json

# Or select all safely resolved changed resources covered by commit claims.
git nawabari commit --session "$session_id" --message "Update example" --all-claimed --json

git nawabari push --session "$session_id" --remote origin --branch feature/example --all-claimed --json
```

## Optional protected execution

Protected execution is an opt-in, Linux-only mode beneath the existing
Nawabari session and claim authority. It does not create a second session
identity and it does not turn ordinary `session create` work into a sandbox.

```bash
git nawabari session run --session "$session_id" -- node worker.js
# `session exec` is an alias.
git nawabari session exec --session "$session_id" -- npm test
```

The `--` terminator is mandatory; the command is passed as an argv vector and
is not interpreted by a shell. The canonical profile gives the child a private
root, private `/tmp`, `/proc`, HOME, and cache state, mounts only the owned
worktree read-write, and does not expose sibling worktrees or Nawabari control
paths. Network mode is explicitly `inherited`, not isolated. Required Linux
capabilities are checked before launch; unavailable or unsupported requirements
fail closed and never fall back to an ambient unprotected process. Optional
Landlock and cgroups v2 provide defense in depth when available.

Check the host without creating a session:

```bash
git nawabari doctor --json
```

The `sandbox` report identifies required and optional capabilities, readiness,
the protected-execution contract, and the effective network mode. See the
[protected Linux compatibility notes](docs/standalone-linux-compatibility.md)
for the platform-specific verification matrix.

## CLI and machine-readable discovery

The installed CLI is the primary integration surface. Discover the contract,
version, command vocabulary, and result schemas before writing an adapter:

```bash
nawabari capabilities --json
nawabari --version --json
nawabari session create --help --json
nawabari commit --help --json
```

`capabilities --json` works without a Git repository. The current top-level
contract is `nawabari.standalone-execution.v1`, schema version `1`. Resource
claim meaning is separately versioned as `nawabari.resource-claims.v2`; the
package version alone is not a compatibility decision.

JSON mode emits one bounded document on stdout. Success and failure envelopes
carry machine-readable fields including `ok`, `command`, and, on failure, a
stable `code` and bounded `message`. Consumers should use these fields rather
than parse human-oriented text. Exact result schemas, failure codes, and
capability matrices are available from `capabilities --json` and are not
duplicated here.

The full command surface is grouped as follows:

- Session: `session create`, `session id`, `session show`, `session list`,
  `status`, `session inspect`, `session close`, and explicit `session discard`.
- Claims: `session claim`, `update`, `mutate`, `transition`, `claims`, and
  `release`, with `resource` aliases.
- Authorization and evidence: `guard`, `authorize`, `checkpoint`,
  `evidence snapshot`, and `diff`.
- Governed Git: `commit` and `push`, including explicit `--all-claimed`.
- Reconciliation and discovery: `doctor`, `gc`, `migrate`, and
  `capabilities`.
- Protected execution: `session run` and its `session exec` alias.

## Stable package exports

Node consumers can use the same public projections without spawning the CLI:

```js
import {
  availableNawabariCommands,
  classifyNawabariState,
  getNawabariSessionStateSnapshot,
  nawabariTransitionDecision,
} from "nawabari/state";

import { nawabariMachineContract } from "nawabari/contract";

import {
  generateNawabariProductStateManifest,
  renderNawabariSessionLifecycleDiagram,
  serializeNawabariProductStateManifest,
} from "nawabari/manifest";
```

`nawabari/state` provides a transport-neutral lifecycle projection and a
read-only observation path for an existing session. `nawabari/contract`
provides the installed machine-contract projection. `nawabari/manifest`
provides the deterministic Product State Manifest projection and renderers.

These exports do not grant mutation authority. They do not expose raw XState
machines, actor references, internal state-node IDs, private context, or
`dist/` deep imports. Mutations still go through the CLI or the authoritative
session registry. The [state architecture document](docs/architecture/xstate-state-architecture.md)
describes the boundary and ownership in more detail.

## Further reading

Use the README as the product overview and navigation surface. The following
documents hold deeper material:

- [XState state architecture](docs/architecture/xstate-state-architecture.md):
  lifecycle authority, public projections, and integration boundaries.
- [Generated lifecycle diagram](docs/architecture/generated/session-lifecycle.mmd):
  the current public lifecycle projection.
- [Standalone Linux compatibility](docs/standalone-linux-compatibility.md):
  protected-execution compatibility and conformance details.
- [0.9.1 release notes](docs/releases/0.9.1.md): current release context and
  public-surface additions.
- [Contributing](CONTRIBUTING.md): development workflow and repository
  conventions.
- [Security policy](SECURITY.md): vulnerability reporting.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

`pnpm run verify` runs the complete repository validation, including package
and workflow checks.
