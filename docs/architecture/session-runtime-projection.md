# Session Runtime Projection

Issue #287 defines the target protected-session model as:

```text
Session authority -> Runtime projection -> Existing isolation backend -> Process
```

Issue #288 establishes the typed contract at the middle boundary. The
implementation is `src/domain/runtime-projection.ts` and is deliberately pure:
it validates and canonically orders a declaration. It does not discover
packages, materialize files, probe the host, compile mounts, or launch a
process.

## Contract boundary

`SessionRuntimeProjection` describes the runtime view that a later resolver
has selected:

- `policy` distinguishes strict default-deny from explicitly selected
  compatibility behavior;
- `profile` identifies what runtime material exists;
- `requirements` declares the runtime and package material required by that
  profile;
- `filesystem` describes explicit source-to-sandbox projections, access mode,
  and provenance;
- `executables` describes stable entrypoint names and their abstract provider
  identities. Materialized providers are projected as pinned read-only files
  at `/nawabari/bin/<name>`; this is the canonical command surface.

Runtime profiles and executable projections are intentionally separate. A
profile does not implicitly expose every executable in its material, and an
executable provider is not a package-discovery mechanism. Concrete providers
and third-party tools remain outside this stable domain vocabulary.

Strict policy is the default and encodes `host_visibility: "default-deny"`
with `unrestricted_host_fallback: "forbidden"`. Compatibility projections
must carry compatibility provenance and use the explicit compatibility policy.
An omitted policy cannot select compatibility behavior.

## Sandbox ownership

`SessionRuntimeProjection` is resolved before the isolation backend. The
existing `SandboxExecutionRequest` remains the contract that binds an already
authorized Nawabari session to bubblewrap/capability/namespace execution. A
future resolver may consume this projection while compiling the sandbox
topology, but #288 does not add a second executor or change bubblewrap
behavior. The existing launcher now consumes the projection when present.
It emits canonical `--ro-bind`/`--bind` entries in target order after the
backend-owned mounts. An explicit projection is the complete user/runtime
view; it does not inherit the legacy runtime/system/user-tool mounts. Omitting
the projection retains the explicit compatibility path for existing callers.

The launcher canonicalizes each materialized source and rejects source
symlinks, unsafe worktree target parents, backend-owned target overlaps, and
ambiguous projection targets. Executable providers are resolved from the exact
materialized filesystem projection; no host `PATH` lookup is performed. Each
stable name receives one read-only file bind at `/nawabari/bin/<name>`, and
strict execution sets `PATH` to exactly `/nawabari/bin`. The backing source
must be a pinned executable outside that surface, so an alias cannot recurse
through the projected command directory. The one supported backend shadow is
an exact canonical worktree source/target, which may be read-only to narrow
session authority. Other read-write projections may only preserve the same
relative path within the authorized session worktree; projections can
therefore narrow that authority but cannot add a new writable host tree.

Missing providers and missing materialization are represented by the typed
`RUNTIME_PROVIDER_MISSING` and `RUNTIME_MATERIALIZATION_MISSING` errors. They
are recoverable failures; strict resolution must not turn either into an
unrestricted host fallback.

## Runtime profile selection

Issue #290 defines the material-only profile contract in
`src/domain/runtime-profile.ts`. The canonical catalog contains:

- `base`: the minimal Node runtime requirement (`node >=24`);
- `development`: `base` plus logical `git >=2` and `pnpm >=11` package
  requirements.

A repository or session selects profiles explicitly, for example
`resolveRuntimeProfile({ profiles: ["development"] })`. The resolver is pure:
it reads only the supplied catalog and selection. It does not inspect `PATH`,
home directories, shell startup files, package-manager state, or host package
installations. The output contains profile identity and logical
`runtime`/`package` requirements only; it contains no source paths, mounts,
executable names, or provider identities.

Profile IDs are a set and are canonically sorted. A definition may explicitly
inherit other profile IDs; inheritance is expanded parent-first and cycles or
conflicting definitions fail closed. Custom material is expressed as ordered
operations after profile composition:

```ts
resolveRuntimeProfile({
  profiles: ["base"],
  operations: [
    { operation: "add", requirement: { id: "git-package", kind: "package", name: "git", version: ">=2" } },
    { operation: "override", requirement: { id: "node-runtime", kind: "runtime", name: "node", version: ">=25" } },
    { operation: "remove", requirement_id: "git-package" },
  ],
});
```

`add`, `remove`, and `override` are explicit: duplicate additions, removal or
override of an unselected requirement, unknown profiles, cycles, and
conflicting requirement identities return typed runtime-profile errors. The
resolver sorts the final requirements by kind and stable ID and returns a
stable derived identity when composition or custom operations change the
material set. Nix and FHS materializers can consume this logical output
independently; choosing how to resolve or mount it is outside this contract.

## Bounded FHS materialization

`src/domain/fhs-runtime.ts` consumes a resolved profile plus one explicit FHS
host executable declaration for each requirement. Strict mode resolves the ELF
`PT_INTERP` and recursive `DT_NEEDED` closure using fixed FHS paths and emits
only regular-file read-only projections through the existing launcher. An
explicit compatibility policy may instead emit the existing FHS roots as
directory read-only projections; strict mode never does so.

Unsupported metadata, missing artifacts, and unresolved loaders/libraries
return recoverable `RUNTIME_MATERIALIZATION_MISSING`; they never select a
fallback. Legacy omitted-projection behavior remains solely for existing
callers of the pre-materialization launcher.

## Strict Nix closure materialization

Issue #291 implements the Nix materializer in
`src/domain/nix-runtime-closure.ts`. It maps logical requirements to explicit
Nix installables and queries `nix path-info --recursive --offline` for the
native runtime closure. The resolver accepts only canonical direct children
of the selected store root, verifies that each path is materialized and
non-symlinked, applies bounded requirement/path/output limits, and returns
deterministically ordered evidence.

Strict output contains one read-only `RuntimeFilesystemProjection` per
required store path, with source and target retaining the exact store-path
identity needed by dynamic loaders and absolute Nix references. It never
projects the store root, `/run/current-system`, wrapper trees, or user
profiles, and it creates no executable aliases. The result is passed to the
generic #289 projection compiler through `SessionRuntimeProjection`; an
undeclared absolute store path therefore has no mount in the private root.
Missing, invalid, or unavailable material uses the recoverable
`RUNTIME_MATERIALIZATION_MISSING` error. The legacy broad store mount is
emitted only when the caller explicitly selects the compatibility policy.
