# Session Runtime Projection

Issue #287 defines the target protected-session model as:

```text
Session authority -> profile/materializer resolver -> Runtime projection -> Existing isolation backend -> Process
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
must carry compatibility provenance and use
`EXPLICIT_COMPATIBILITY_RUNTIME_POLICY`; an omitted policy or projection
cannot select compatibility behavior for an enforced request.

## Sandbox ownership

`SessionRuntimeProjection` is resolved before the isolation backend. The
existing `SandboxExecutionRequest` remains the contract that binds an already
authorized Nawabari session to bubblewrap/capability/namespace execution.
Issue #297 composes the canonical profile, the selected Nix/FHS materializer,
and the #293 executable surface before attaching the validated projection to
that request. It does not add a second executor or change bubblewrap's
authority. The existing launcher consumes the projection as the sole enforced
user/runtime visibility authority. It emits canonical
`--ro-bind`/`--bind` entries in target order after the backend-owned mounts. An
explicit projection is the complete user/runtime view; it does not inherit the
legacy runtime/system/user-tool mounts. The compatibility builder in
`src/domain/compatibility-runtime-projection.ts` converts only the existing
bounded legacy layout into a read-only, compatibility-provenance projection.
An omitted projection is retained only for non-enforced/advisory request
compatibility; the protected launcher rejects it rather than selecting broad
compatibility visibility.

The launcher canonicalizes each materialized source and rejects source
symlinks, unsafe worktree target parents, backend-owned target overlaps, and
ambiguous projection targets. Executable providers are resolved from the exact
materialized filesystem projection; no host `PATH` lookup is performed. Each
stable name receives one read-only file bind at `/nawabari/bin/<name>`, and
strict execution sets `PATH` to exactly `/nawabari/bin`; compatibility PATH is
derived only from explicit compatibility projection targets and never from
ambient host `PATH`. The backing source must be a pinned executable outside
that surface, so an alias cannot recurse through the projected command
directory. The one supported backend shadow is
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

Issue #314 owns the standalone Linux development materialization and strict
readiness path in `src/domain/fhs-development-runtime.ts`. It accepts only
explicit executable evidence, delegates bounded ELF/shebang closure work to
`src/domain/fhs-runtime.ts`, and compiles the result through #293. Issue #297
selects and invokes that authority; it does not add another FHS declaration or
readiness implementation.

`src/domain/fhs-runtime.ts` consumes a resolved profile plus one explicit FHS
host executable declaration for each requirement. Strict mode resolves the ELF
`PT_INTERP` and recursive `DT_NEEDED` closure using fixed FHS paths and emits
only regular-file read-only projections through the existing launcher. An
explicit compatibility policy may instead emit the existing FHS roots as
directory read-only projections; strict mode never does so.

Unsupported metadata, missing artifacts, and unresolved loaders/libraries
return recoverable `RUNTIME_MATERIALIZATION_MISSING`; they never select a
fallback. Legacy omitted-projection behavior remains solely for non-enforced
callers of the pre-materialization launcher; protected execution requires an
explicit projection.

## Default runtime resolution

Issue #297 owns only the convergence wiring in
`src/domain/runtime-resolution.ts`. An enforced `session run`, `session exec`,
or `session shell` request uses `STRICT_RUNTIME_POLICY` and the canonical
`development` profile unless the caller supplies
`--runtime-policy compatibility`. Resolution selects exactly one strict
materializer: native Nix closure materialization when the Nix store, current
system, and Nix executable are available; otherwise bounded standalone-Linux
FHS materialization. A selected materializer failure is terminal; the
resolver never retries with broad mounts, host `PATH`, or another materializer.

Strict Nix selection delegates to #291, strict FHS selection delegates to the
#314 materialization/readiness path, and explicit compatibility delegates to
the #315/#316 `buildExplicitCompatibilityRuntimeProjection` authority. The
selected result is validated through #293 and attached as
`runtime_projection` before protected launch. Runtime-resolution evidence
retains policy, profile, and materializer. Provider leaves such as #295,
#296, and #309 remain opt-in and are not selected by the canonical
`development` default.

Issue #324 owns the FHS host/runtime evidence layer in
`readFhsDevelopmentExecutableCandidates()`
(`src/domain/fhs-development-runtime.ts`). Per canonical requirement, an
explicit `NAWABARI_FHS_*_EXECUTABLE` environment declaration always wins.
Absent that, the resolver falls back to
`discoverDefaultFhsDevelopmentExecutableCandidates()`: a small, fixed,
deterministic allowlist of FHS binary directories
(`FHS_DEVELOPMENT_DEFAULT_EXECUTABLE_ROOTS`, currently `/usr/bin`,
`/usr/local/bin`, and `/bin`)
is checked for a canonically resolved, non-symlink, regular, executable file
named after the requirement (`node`, `git`, `pnpm`). This is a fixed-root
allowlist, not a `PATH` search: it never consults process `PATH`, `HOME`,
profile directories, or Corepack state, so it cannot be redirected by an
attacker-controlled `PATH`. Every discovered candidate is re-validated by the
same strict pipeline that validates an explicit candidate; a requirement with
neither an explicit nor a discovered candidate still fails closed with
`RUNTIME_MATERIALIZATION_MISSING`. This lets `session run`/`session exec`/
`session shell` succeed under the documented default `--runtime-policy
strict` on a supported host without requiring any explicit configuration.

## Projected pnpm middleware

Issue #311 is the sole producer of the pinned RTK and pnpm backend material.
Its `materializePnpmMiddlewareBackends()` result supplies #296 with the exact,
already materialized read-only source-to-target pair for each backend. Issue
#296 owns only the launcher provider: it writes one small Node launcher and
feeds it back through the canonical #293 executable projection:

```text
/nawabari/bin/pnpm -> exact RTK path (`rtk proxy`) -> exact real pnpm path
```

The launcher embeds both sandbox-visible paths, passes the original argv after
the fixed `proxy` binding arguments, inherits cwd/environment/stdio, and never
constructs a shell command. The #296 consumer still rejects backend paths that
are relative, projected, self-referential, equal, missing, non-executable, or
not exactly materialized before launcher creation. It adds only one
regular-file projection; it does not expose a host PATH, a host pnpm fallback,
or a general middleware graph.

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

## Projected Git author identity

Issue #325 projects only the minimum Git author identity a commit needs
(`user.name`/`user.email`) into the session-private Git config already
described above; it never mounts host `HOME` or a caller's real global Git
config.

`discoverSandboxRuntimeLayout()` reads exactly two host global config keys
through bounded `git config --global --get user.name`/`user.email` queries
and carries the result as `git_identity` on `SandboxExecutionRequest`. The
sandbox launcher's `prepareGitMetadata` step separately reads
`user.name`/`user.email` from the authoritative host worktree with
`git config --local --get`, which — per key — takes precedence over the
projected host global value, then writes only the resolved keys into the
existing session-private `git_metadata/config` file with
`git config --file`. Neither read ever opens or copies a full config file,
so credential helpers, hooks, aliases, and every other global/local setting
are never imported. Identity absent at both scopes leaves the projected
config without a `[user]` section, so a sandboxed commit fails exactly as an
unconfigured Git would; `session-registry.ts` recognizes that specific
failure and adds a remediation hint instead of a generic Git failure
message.
