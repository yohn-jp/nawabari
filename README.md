<p align="center">
  <img src="./docs/assets/readme/nawabari-hero.webp" alt="Nawabari — Git Worktree Isolation." width="100%">
</p>

# Nawabari

Nawabari is a machine-local runtime for coding-agent sessions. It binds each session to an owned Git worktree and
mutable branch, checks declared access and coordination boundaries, and supports protected execution on Linux.
Repository ownership remains independent for each local Git repository; a shared remote does not merge local authority.

Nawabari owns local execution and recovery, not task selection, semantic orchestration, or GitHub Issue/PR governance.
Local ownership operations do not require GitHub, `gh`, or a particular agent runtime. Explicit Git push/fetch operations
and caller programs may use the network.

The [accepted Target Architecture](docs/architecture/index.md) defines the design to which the product must converge.
The [implementation status](docs/architecture/implementation-status.md) distinguishes that target from the current code.
This documentation adoption does not implement parking, change claim enforcement, repair Control Server authentication,
add a singleton lease, or strengthen filesystem durability by itself.

## Install and discover

Use Node.js 24 or newer.

```bash
npm install -g nawabari
nawabari --version
nawabari capabilities --json
git nawabari session create --help --json
```

The package installs `nawabari` and `git-nawabari`; Git discovers the latter as `git nawabari`.
Use installed help and capabilities for exact supported commands, schemas, options, and failure codes.
Package version, persisted schema version, claim schema version, and public contract identity are distinct.

## Local session workflow

From the repository's integration worktree, create a session and retain the returned identity and worktree path.
The default session does not require resource claims for otherwise-valid session-owned operations.
Worktree/branch ownership, applicable scope restrictions, and conflicts with another session's claims remain enforced.

```bash
nawabari session create --branch feature/example --json
nawabari session show --session "$session_id" --json
nawabari session inspect --session "$session_id" --schema-version 2 --json
```

Set `session_id` and the working directory from the create result; do not use another session's worktree.
For explicit claim enforcement, declare it at creation:

```bash
nawabari session create --branch feature/claimed --enforce-claims \
  --resource README.md --mode write --json
```

Commit and push are explicit governed operations with concrete resources. On claim-enforced sessions, their required
claim strength is discovered from the operation contract. Integration/review decisions remain caller-owned.
After integration, inspect and close. A blocked close does not authorize discard.

```bash
nawabari session close --session "$session_id" --json
nawabari gc --dry-run --json
nawabari doctor --json
```

See [current CLI workflows](docs/reference/cli-workflows.md) for bounded working sets, auxiliary state, claims,
Git mutation, explicit discard, reconciliation, and bootstrap retry. Target park/resume semantics are documented in
[session lifecycle](docs/architecture/session-lifecycle.md), not advertised here as implemented commands.

## Execution guarantees

An ordinary session is an ownership boundary, not automatic OS isolation. Direct edits by a host process with ambient
permissions remain outside the mediated-operation guarantee.
Protected execution requires the selected Linux sandbox and explicit runtime material. Managed execution additionally
uses durable execution ownership, launch admission, and owned process/cgroup evidence. These are separate capabilities;
a generic sandbox-ready result does not prove managed-runtime readiness.

```bash
nawabari session run --session "$session_id" --runtime-policy strict -- node worker.js
```

Strict execution does not silently fall back to host PATH, HOME, broad mounts, or compatibility mode.
Network mode remains `inherited`; filesystem isolation does not imply isolation from host loopback services.
See [runtime/process](docs/architecture/runtime-process.md), [runtime reference](docs/reference/runtime-projection.md),
and [security policy](SECURITY.md) before interpreting a capability or isolation claim.

## Optional local Control Server

```bash
nawabari server
nawabari server --port 47472
```

The current foreground server binds only `127.0.0.1`, defaults to port `47471`, and serves known repositories through one
browser endpoint. CLI and TUI work without it. Stop it with Ctrl-C or SIGTERM.

**Current limitation:** the implementation audited for this adoption bootstraps its control token into the unauthenticated
root document. With inherited host networking, this is not an isolation boundary against untrusted local/protected
processes. Do not treat concurrent untrusted workloads and this server as a securely separated operator interface.
The accepted target requires trusted-host-only credential delivery; that repair remains implementation work.
Different ports also do not currently enforce the accepted machine/user singleton requirement.

The [control-surfaces contract](docs/architecture/control-surfaces.md) defines authentication, lifecycle, discovery,
concurrency, and projection boundaries without turning this optional server into a remote control plane.

## Public Node projections

```js
import { getNawabariSessionStateSnapshot } from "nawabari/state";
import { nawabariMachineContract } from "nawabari/contract";
import { generateNawabariProductStateManifest } from "nawabari/manifest";
```

These exports expose read/classification/contract projections, not mutation permission or raw XState actors.
Do not deep-import private `dist` modules as a supported API.

## Documentation and development

Start with the [documentation map](docs/index.md), [contribution workflow](CONTRIBUTING.md), and
[release history](docs/releases/). Development uses the exact `packageManager` declaration in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Verification includes package and environment-dependent proofs. A missing sandbox, runtime material, or delegated cgroup
is not a successful security test. See the [proof matrix](docs/architecture/verification-provenance.md).
