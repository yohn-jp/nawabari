<p align="center">
  <img src="./docs/assets/readme/nawabari-hero.webp" alt="Nawabari — Git Worktree Isolation." width="100%">
</p>

<p align="center">
  <a href="https://github.com/yohn-jp/nawabari/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yohn-jp/nawabari/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/nawabari"><img alt="npm" src="https://img.shields.io/npm/v/nawabari"></a>
  <a href="https://www.npmjs.com/package/nawabari"><img alt="Node" src="https://img.shields.io/node/v/nawabari"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/nawabari"></a>
</p>

# Nawabari

Nawabari is a local governance layer for parallel coding agents. It gives each agent session an owned Git worktree and branch, records which repository resources that session may use, and checks those boundaries before governed mutations.

It is for teams and tools that need several agents to work in one repository without silently sharing a worktree, overwriting one another's files, or guessing whether a session is safe to close. Nawabari is local-first: the session registry, Git observations, and authorization decisions do not require GitHub, `gh`, a network connection, or a particular agent runtime.

This README describes the current 0.10.x product model. It is an overview and navigation surface, not a copy of generated contracts or implementation history.

The canonical routine-use workflow is one machine-authority path for both people
and agents:

1. Create a managed session with explicit initial claims.
2. Declare any required auxiliary repository-local state explicitly.
3. Inspect the session and its claims.
4. Run governed work and mutations through the claim and evidence surfaces.
5. Handle claim conflicts from machine-readable evidence and typed lifecycle actions.
6. Reconcile stale or inconsistent physical state through the canonical operation.
7. Close or discard according to the lifecycle authority.
8. Confirm convergence with `doctor` and garbage-collection observation.

Nawabari governs operations routed through Nawabari. A normal governed session is an ownership and authorization boundary, not an operating-system or filesystem sandbox. A process with ambient filesystem permissions can still edit another worktree directly.

## Install

Node.js 24 or newer is required.

```bash
npm install -g nawabari
nawabari --version
git nawabari --help
```

The package installs both `nawabari` and `git-nawabari`; `git nawabari ...` works as Git's external subcommand.

## Canonical routine-use workflow

Run from the repository's integration worktree. The following bootstrap uses the
same public option shape as the packed routine-use certification. Omit the
auxiliary declaration when the session needs no declared repository-local state;
do not replace it with an arbitrary host path.

```bash
nawabari capabilities --json
nawabari doctor --json

auxiliary_state='{"source":{"kind":"repository-local","path":".codegraph/ignored"},"target":{"kind":"managed-worktree","path":".codegraph/ignored"},"mode":"copy","durability":"durable"}'
created=$(git nawabari session create \
  --branch feature/example \
  --resource README.md --mode write \
  --auxiliary-state "$auxiliary_state" \
  --json)
session_id=$(printf '%s' "$created" | jq -r .session_id)
worktree=$(printf '%s' "$created" | jq -r .worktree)

(cd "$worktree" && git nawabari session show --session "$session_id" --json)
(cd "$worktree" && git nawabari session claims --session "$session_id" --json)
(cd "$worktree" && git nawabari session inspect --session "$session_id" --schema-version 2 --json)

(cd "$worktree" && git nawabari session claim --session "$session_id" --resource contract-lifecycle.txt --mode exclusive-write --json)
(cd "$worktree" && git nawabari authorize --session "$session_id" --operation source-write --resource contract-lifecycle.txt --json)
(cd "$worktree" && "$EDITOR" contract-lifecycle.txt)
(cd "$worktree" && git nawabari evidence snapshot --session "$session_id" --json)
(cd "$worktree" && git nawabari checkpoint --session "$session_id" --json)
(cd "$worktree" && git nawabari commit --session "$session_id" --message "Exercise governed lifecycle" --resource contract-lifecycle.txt --json)
(cd "$worktree" && git nawabari push --session "$session_id" --remote origin --branch feature/example --resource contract-lifecycle.txt --create-upstream --json)
```

`session create` provisions the new worktree under `<repository-parent>/.nawabari/worktrees` by default (discoverable via `status --json` as `managed_worktree_root`). Nawabari creates that managed subdirectory on first default placement. New exact `--worktree` paths must be under the reported root; an absolute path directly under the repository parent remains accepted for compatibility with older callers and persisted sessions.

The initial-claim grammar is `--resource <path-or-glob> --mode <read|write|exclusive-write>` and the pair may be repeated. Each resource is paired with its own mode. The parser also permits zero pairs for backward compatibility, but the canonical routine path declares at least one initial claim. Initial claims are committed atomically with the new session, worktree, and branch. A conflict returns a machine-readable failure such as `RESOURCE_CLAIM_CONFLICT` and does not leave a partially established session or claim set.

The packed auxiliary-state declaration above is the bounded `copy` form: a `repository-local` source is copied to a `managed-worktree` target with `durability: durable`. It is an explicit, repeatable, allowlisted capability. It does not discover ignored state, project process-local sockets/PID files/logs, shadow Git-tracked paths, or expose arbitrary host filesystem paths. Auxiliary-state projection is separate from `SessionRuntimeProjection`: the former copies declared repository-local durable state for a managed worktree; the latter describes explicit runtime material and filesystem visibility for protected execution. Auxiliary state does not change the runtime projection.

The create operation is atomic, but a caller must treat an uncertain result carefully. If JSON reports `REGISTRY_DURABILITY_UNCERTAIN`, re-read the reported session and claims before retrying. If the exact original declaration is already present, follow `bootstrap_retry.next_action: inspect-established-session` and inspect that `session_id`; if another declaration owns the worktree or branch, follow `bootstrap_retry.next_action: inspect-blocking-session`. Nawabari never silently adopts an existing owner. A retry is appropriate only after the authoritative state proves that the requested bootstrap was not established.

`--all-claimed` is an explicit resource selector. It resolves safely observed Git-changed paths covered by qualifying claims; it does not bypass claim authorization. Use repeated `--resource <path>` when an explicit path list is preferable.

After reviewing and integrating the session branch through the caller's normal local Git/provider process:

```bash
git nawabari session inspect --session "$session_id" --json
git nawabari session close --session "$session_id" --json
```

Close is conservative. Unintegrated commits, dirty worktrees, ambiguous Git state, and ownership mismatches remain blocked. For a squash or rebase merge, pass an exact local `--integrated-revision <rev>` so Nawabari can independently re-verify the content.

If the lifecycle result exposes a recoverable blocker, follow its typed `next_action`/`next_actions` entry. `reconcile-physical-state` is the non-mutating observation action (its command is `doctor`). Its explicit apply action is `reconcile-physical-state-apply`, and its exact command is:

```bash
git nawabari session reconcile --session "$owner_session_id" --apply --json
```

The session ID must be the blocking owner reported by the machine result. A successful apply returns `operation: "reconcile-apply"`, `action.action_id: "reconcile-physical-state-apply"`, and a completed outcome; the owner is terminalized and its claims are released only when the existing lifecycle and physical-state evidence authorizes that transition. Retry the blocked claim only after this result succeeds.

After every session reaches its terminal lifecycle result, confirm convergence from
the repository integration worktree:

```bash
git nawabari gc --dry-run --json
git nawabari doctor --json
```

## Authority model

Each boundary has one job and one local authority. README summarizes the product contract; executable code and machine-readable projections remain authoritative for exact schemas, transitions, and failure vocabularies.

| Boundary               | What it answers                                                                                    | Typical commands                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Session lifecycle      | Which session owns a worktree/branch and whether it can safely progress or terminate               | `session create`, `session inspect`, `session close`                   |
| Resource Claims        | Which session may access a canonical repository resource and at what mode                          | `session claim`, `session claims`, `session update`, `session release` |
| Mutation authorization | Whether a concrete operation has sufficient claims and no conflicting owner                        | `guard`, `authorize`, `commit`, `push`                                 |
| Repository evidence    | What Git can observe about revisions, paths, changes, ancestry, and bounded diffs                  | `checkpoint`, `evidence snapshot`, `diff`                              |
| Auxiliary state        | Whether explicitly declared durable repository-local state may be copied into the managed worktree | `session create --auxiliary-state`, `capabilities`                     |
| Reconciliation/cleanup | Whether observed physical state permits a lifecycle recovery or cleanup action                     | `session inspect`, `session reconcile`, `doctor`, `gc`                 |
| Protected execution    | Whether a command runs inside the opt-in Linux process/filesystem boundary                         | `session run`, `session exec`, `session shell`, `doctor`               |

Claims are not task labels and do not encode GitHub or agent semantics. `write` permits ordinary path changes; `exclusive-write` is required for finalizing operations such as commit and push. Conflicting or ambiguous claims fail closed.

The default governance path does not install hooks and does not prevent direct filesystem writes outside Nawabari. Its guarantee is that Nawabari-routed operations consult authoritative session, Git, and claim state before mutation.

Nawabari's authority ends at local session ownership, claims, Git evidence, and the lifecycle of the managed worktree and branch. Task meaning, Issue/PR state, review decisions, and provider/GitHub state remain outside that authority.

### Claim conflict and physical recovery

`RESOURCE_CLAIM_CONFLICT` does not always mean stale state. A healthy owner is reported with `ownerState: "active"`; the certified contention path exposes `inspect-blocking-session` and `wait-for-conflicting-claim-release` safe actions without a reconciliation `nextAction`. Inspect the owner and wait for the legitimate claim release; do not remove another session's claim.

For a stale or inconsistent owner, the machine result instead carries physical and lifecycle evidence such as `ownerPhysicalState: "prunable-missing"`, `ownerLifecycleState: "stale-inconsistent"`, and the typed `nextAction.actionId: "reconcile-physical-state"`. Inspect it first:

```bash
git nawabari session inspect --session "$owner_session_id" --schema-version 2 --json
```

Then use the explicit apply operation shown above and retry the original claim after it completes. Age or a missing path alone is not destructive authority. The packed test removes a worktree only as external fault injection; supported recovery does not involve editing the session registry manually or deleting a raw Git worktree.

## Session and resource lifecycle

The normal path is:

```text
session create (explicit initial claims)
      ↓
inspect session/claims → claim/authorize → checkpoint → commit or push
      ↓                                              ↓
  inspect readiness                         integrate the branch
      ↓                                              ↓
session close or discard  ←─────────────────────────┘
       ↓
doctor + gc --dry-run convergence check
```

If work is not integrated, `session inspect` reports bounded blockers and safe next actions. Discard is never an implicit fallback for close or garbage collection.

The Session lifecycle is backed by the executable XState authority in 0.10.x and exposed through public state, contract, and manifest projections. Consumers use those projections rather than internal machine nodes or actor objects.

### Claims

Claims are canonical repository-relative resource records attached to a session. Supported modes are `read`, `write`, and `exclusive-write`. The canonical routine path establishes its first claim during `session create`; later additions, transitions, and releases use the existing claim surfaces.

```bash
git nawabari session claim --session "$session_id" --resource src/example.ts --mode exclusive-write --json
git nawabari session claims --session "$session_id" --json
git nawabari session update --session "$session_id" --resource src/example.ts --mode exclusive-write --resource test/example.test.ts --mode write --if-generation 1 --json
git nawabari session release --session "$session_id" --all --force --json
```

Resource aliases are discoverable through help. Use `--help --json` rather than copying option metadata into an integration.

Claim modes are cumulative. The canonical operation requirements are derived from the operation authorization policy and are shown by `session claim --help`:

- `read`: no governed operation
- `write`: `source-write`, `stage`
- `exclusive-write`: `source-write`, `stage`, `commit`, `branch-mutation`, `push`, `cleanup`

The policy requires `exclusive-write` for operations that finalize or remove shared state. This mapping is documentation of the executable authority, not a second claim policy; integrations should discover the current values from help or the machine contract.

### Inspect, close, discard, and garbage collection

`session inspect` is read-only and uses the same close/cleanup evidence as `session close`. Use `--schema-version 2` when consuming the single-authority lifecycle and action projection.

```bash
git nawabari session inspect --session "$session_id" --json
git nawabari session discard --session "$session_id" --preview --json
```

`session discard` requires an explicit session ID and may destroy unintegrated commits and uncommitted work in that session's worktree. Preview reports bounded destructive scope without mutation. Actual discard revalidates repository, worktree, branch, `HEAD`, and registry ownership before destructive steps.

When the caller intentionally abandons the session, apply that explicit
decision with `git nawabari session discard --session "$session_id" --json`.
Discard is not an automatic fallback for a blocked close.

`gc --dry-run` reports stale candidates and blockers. `gc --apply` only cleans candidates passing the same safety checks; elapsed age alone is diagnostic suspicion, not destructive authority. `doctor` reports prerequisite and reconciliation state without silently repairing ownership. Use the typed lifecycle action and explicit `session reconcile` operation for supported stale/inconsistent-owner recovery; `doctor` does not silently repair it.

## Governed Git work

`guard` and `authorize` are separate read-only boundaries:

- `guard` without an operation verifies the current physical worktree, branch, and session ownership/context. It does not evaluate resource claims.
- `authorize` evaluates a named operation against concrete resources, using the canonical operation policy and active claims. It does not grant or persist claims.
- `guard --operation <name> --resource <path>` remains a compatibility convenience for the combined claim-aware check. Use `authorize` when the operation decision itself is the intended boundary.

The operation vocabulary is discoverable from the CLI and includes `source-write`, `stage`, `commit`, `branch-mutation`, `push`, and `cleanup`.

`checkpoint` and `evidence snapshot` describe Git-observable facts only. They do not infer task meaning, Issue ownership, or review status. `diff` requires explicit concrete paths and bounds optional patch output.

```bash
git nawabari commit --session "$session_id" --message "Update example" --resource src/example.ts --json
git nawabari commit --session "$session_id" --message "Update example" --all-claimed --json
git nawabari push --session "$session_id" --remote origin --branch feature/example --all-claimed --json
```

## Optional protected execution

Protected execution is an opt-in Linux-only mode beneath the existing Nawabari session and claim authority. It does not create a second session identity and does not turn ordinary `session create` work into a sandbox.

```bash
git nawabari session run --session "$session_id" --runtime-policy strict -- node worker.js
git nawabari session exec --session "$session_id" -- npm test
git nawabari session shell --session "$session_id" --runtime-policy compatibility
```

The `--` terminator is mandatory. The command is passed as argv and is not interpreted by a shell. The canonical profile gives the child a private root, `/tmp`, `/proc`, HOME, and cache state, mounts only the owned worktree read-write, and does not expose sibling worktrees or Nawabari control paths. Network mode is explicitly `inherited`, not isolated. Required Linux capabilities fail closed when unavailable; optional Landlock and cgroups v2 provide defense in depth when available.

Protected execution defaults to the strict `development` runtime profile. Only declared Node, Git, and the deterministic `ls` baseline utility are projected through `/nawabari/bin`; `/usr`, `/bin`, `/nix/store`, the host home, and local user-tool directories are not implicitly visible. pnpm is an explicit opt-in development requirement. Compatibility is available only through the explicit `--runtime-policy compatibility` option.

```bash
git nawabari doctor --json
```

See [Standalone Linux compatibility](docs/standalone-linux-compatibility.md) for platform-specific details.

## CLI and machine-readable discovery

The installed CLI is the primary integration surface. Discover its contract rather than hard-coding presentation output:

```bash
nawabari capabilities --json
nawabari --version --json
nawabari session create --help --json
nawabari session inspect --help --json
nawabari session reconcile --help --json
nawabari commit --help --json
```

`capabilities --json` works without a Git repository. The top-level contract is `nawabari.standalone-execution.v1`, schema version `1`; Resource Claim meaning is separately versioned as `nawabari.resource-claims.v2`. Package version alone is not a compatibility decision. The capability projection publishes the initial-claim grammar and retry vocabulary, auxiliary-state contract, lifecycle action IDs, and the `session reconcile --session <id> --apply` apply arguments used above.

JSON mode emits one bounded document on stdout. Consumers should use machine-readable fields and stable codes rather than parse human-oriented text.

The command surface includes Session lifecycle, Resource Claims, authorization/evidence, governed Git commit/push, reconciliation/discovery, and protected execution. Use `--help --json` and `capabilities --json` for the authoritative inventory. Human-readable guidance and agent integrations use these same command and action identifiers; there is no separate human or agent workflow.

An agent-facing playbook at [`.claude/skills/nawabari/SKILL.md`](.claude/skills/nawabari/SKILL.md) is generated from the same `CLI_COMMAND_REGISTRY` authority (`pnpm run skill:generate`; `pnpm run skill:check` fails CI on drift). It orients an operating agent toward the canonical routine and each command's live `--help --json` projection; it does not restate an independent flag or syntax table.

## Stable package exports

Node consumers can use public projections without spawning the CLI:

```js
import {
  availableNawabariCommands,
  classifyNawabariState,
  getNawabariSessionStateSnapshot,
  nawabariTransitionDecision,
} from "nawabari/state";

import { nawabariMachineContract } from "nawabari/contract";

import { generateNawabariProductStateManifest, serializeNawabariProductStateManifest } from "nawabari/manifest";
```

`nawabari/state` provides transport-neutral lifecycle projection and read-only observation of an existing session. `nawabari/contract` provides the installed machine-contract projection. `nawabari/manifest` provides the deterministic Product State Manifest projection.

These exports do not grant mutation authority and do not expose raw XState machines, actor references, internal state-node IDs, private context, or `dist/` deep imports. Mutations still go through authoritative runtime paths. See [XState state architecture](docs/architecture/xstate-state-architecture.md).

## Further reading

- [XState state architecture](docs/architecture/xstate-state-architecture.md): lifecycle authority, public projections, and integration boundaries.
- [Standalone Linux compatibility](docs/standalone-linux-compatibility.md): protected-execution compatibility and conformance details.
- [Release notes](docs/releases/): version-specific changes and migration context.
- [Contributing](CONTRIBUTING.md): development workflow and repository conventions.
- [Security policy](SECURITY.md): vulnerability reporting.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm test
```

`pnpm run verify` runs the complete repository validation, including package and workflow checks.
