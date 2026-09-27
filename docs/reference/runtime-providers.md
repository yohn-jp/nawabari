# Runtime provider references

Classification: version-bound implementation reference. The [runtime contract](../architecture/runtime-process.md)
owns authority, readiness, and isolation. These providers are existing opt-in consumers, not unused compatibility layers.
Exact historical output is preserved under [runtime evidence](../evidence/runtime/index.md).

## tgrep materialization and projected rg

The pinned backend is tgrep `1.0.4`, with requirement `tgrep-backend`.
Its Nix installable is `github:NixOS/nixpkgs/8804d221b8210f7b2b9e84a450617aac5df80e08#tgrep`.
Materialization delegates to the canonical offline local-store closure resolver and returns exact backend/interpreter material.
It does not expose a public executable, search host PATH, or download/install during provider execution.

The rg provider consumes that exact TgrepRuntimeMaterialization and exposes `/nawabari/bin/rg` through the canonical
executable projection. It embeds the exact backend/interpreter paths and launches argv with `shell: false`.
It does not expose tgrep's index/server controls, restore host grep/rg, or add arbitrary mounts.
`TGREP_RG_COMPATIBILITY_MATRIX` in `src/domain/runtime-provider-tgrep.ts` owns the accepted argument translation.
Unsupported flags/subcommands, unsafe paths, stdin operands, and ambiguous forms fail before backend spawn.
Patterns and paths remain argv data after an explicit terminator; exit status/signals are forwarded.

The pinned evidence contains backend version/help and hash; the help SHA-256 is
`af98560daab3db4eb96b8fc3beafa15f397dbe2a4c6e8f5b0566b07fd0a9255f` (9,103 UTF-8 bytes).
The existing FHS declaration lacks the immutable source/version/provenance proof for this provider and fails closed;
do not replace that failure with ambient executable discovery.
See [material evidence](../evidence/runtime/tgrep-materialization.md) and
[rg compatibility evidence](../evidence/runtime/tgrep-rg-provider.md). A copied evidence file is not a new runtime test.

## RTK and real pnpm material

The pinned backend requirements are `rtk-pnpm-middleware` (RTK `0.45.0`) and `pnpm-pinned-backend` (pnpm `11.18.0`).
Their immutable Nix installables are:

```text
github:NixOS/nixpkgs/bb92730f6e97ca1c19e285a872cdd62a1a25c467#rtk
github:NixOS/nixpkgs/44cc5cdbf88deb1d20243d1d5e3b46ad008b6139#pnpm
```

The exact projected targets are `/runtime/pnpm-middleware/rtk`,
`/runtime/pnpm-middleware/pnpm/bin/pnpm.mjs`, and its required companion `dist/pnpm.mjs`.
The pnpm provider source is the regular `libexec/pnpm/bin/pnpm.mjs`, not a symlinked `bin/pnpm`.
These backend pins are not the repository development package-manager version; that remains in `package.json`.

Materialization supplies exact read-only descriptors. The launcher provider binds the fixed chain:

```text
/nawabari/bin/pnpm -> exact RTK path (rtk proxy) -> exact real pnpm path
```

Pass original arguments without shell interpolation. Reject missing, relative, self-referential, equal, unmaterialized,
or otherwise invalid backend identities. No host pnpm fallback, generic middleware graph, or PATH search is introduced.
As with tgrep, unsupported FHS immutable-source proof is an explicit missing-material result.
The [preserved backend evidence](../evidence/runtime/pnpm-materialization.md) retains exact versions, source hashes,
help output, and the materializer/provider handoff; historical Issue numbers there are not current execution authority.

## Verification and changes

Retain separate pinned-provider conformance because it proves material provenance and a protected executable boundary,
not ordinary TypeScript unit behavior. A new backend version requires evidence for that exact version; do not carry old
help/hash results forward. Provider compatibility does not broaden filesystem or working-set permission.
Changing a public compatibility matrix or supported strict/compatibility behavior follows accepted Q6, not cleanup preference.
