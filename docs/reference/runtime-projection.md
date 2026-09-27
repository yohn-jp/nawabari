# Runtime projection reference

Classification: implementation reference, not a second authority. Design owners are
[runtime/process](../architecture/runtime-process.md) and [filesystem/isolation](../architecture/filesystem-isolation.md).

## Separate contracts

The upper Worktree Runtime Profile describes selected local runtime configuration, filesystem ceilings, tools, shell,
environment roots, and private Git/hooks. Repository catalog composition is bounded/deterministic; selection is explicit
and bootstrap pins definition/provenance. Later changes expose drift rather than refreshing the active pin.

The lower material-only RuntimeProfile describes logical runtime/package requirements, not mount permissions or agent roles.
SessionRuntimeProjection is a validated, canonically ordered view of selected policy, material profile, requirements,
filesystem source/target entries, executables, and provider identities. It neither discovers packages nor launches processes.
SandboxExecutionRequest binds the already authorized session to that view and the existing isolation backend.

## Current default and explicit compatibility

The existing material catalog includes `base` (Node >=24) and `development` (base plus Git and deterministic `ls`).
pnpm and third-party provider material are explicit requirements, not prerequisites for unrelated commands.
Profile composition/add/remove/override is deterministic and rejects conflicts, cycles, and missing references.
This does not make every executable inside a selected package visible.

Enforced default execution uses strict resolution. Select native Nix closure materialization where its canonical capability
is present, otherwise the bounded standalone-Linux FHS materializer. Once selected, materialization failure is terminal;
there is no retry through broad mounts, host PATH, or another materializer.
Explicit compatibility uses its bounded compatibility-provenance projection, not an automatic strict fallback.
Omitted projection is not permitted to select broad visibility for an enforced launch.

Strict Nix projects the exact approved closure, not `/nix/store` wholesale.
Strict FHS resolves bounded declared executable/ELF/shebang material. Its explicit `NAWABARI_FHS_*_EXECUTABLE` declaration
precedes the existing fixed-root candidate allowlist (`/usr/bin`, `/usr/local/bin`, `/bin`), never process PATH/HOME/Corepack.
Every selected candidate still goes through canonical validation; missing required material fails closed.

## Executables and mounts

Canonical entrypoints are explicit read-only providers under `/nawabari/bin`.
Strict PATH is exactly that projected surface. An executable provider consumes exact material, not a command name to discover.
Reject ambiguous targets, source symlinks, unsafe target parents, backend-owned overlap, and self-referential providers.
An explicit projection does not inherit unspecified legacy host mounts.
Writable projections cannot create an additional writable host tree outside the accepted worktree/explicit capability contract.

Shell entry uses its explicit projected shell and deterministic startup behavior; it does not read ambient host startup files.
Auxiliary-state copies are separately declared repository-local material and do not change SessionRuntimeProjection implicitly.
The accepted effective-policy conjunction controls repository permissions and exact namespace operations.

## Material references and evidence

[Runtime providers](runtime-providers.md) describes pinned tgrep/rg and RTK/pnpm adapters.
[Standalone Linux compatibility](../standalone-linux-compatibility.md) deliberately tests the explicit compatibility path,
not proof that strict and managed paths have identical guarantees.
The [former full projection document](https://github.com/yohn-jp/nawabari/blob/3f814154c6ba9509ae9a1a15db41c890fc02271c/docs/architecture/session-runtime-projection.md)
is historical detail. Responsibility statements in the accepted architecture supersede its migration/Issue-owner wording.

Implementation anchors: [projection](../../src/domain/runtime-projection.ts),
[material profile](../../src/domain/runtime-profile.ts), [resolution](../../src/domain/runtime-resolution.ts),
[upper profile](../../src/domain/worktree-runtime-profile.ts).
