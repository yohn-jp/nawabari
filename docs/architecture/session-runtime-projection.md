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
  identities.

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
behavior.

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
