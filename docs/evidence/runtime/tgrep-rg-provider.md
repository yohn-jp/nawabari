# Projected `rg` provider

Issue #295 exposes one public search entrypoint, `/nawabari/bin/rg`, backed by
the exact materialization established by #307/#308. It does not expose
`tgrep`, add `grep`, consult `PATH`, or fall back to a host executable.

## Backend authority

The provider consumes an already materialized `TgrepRuntimeMaterialization`.
It never calls Nix, downloads an artifact, runs `which`, or resolves a command
name. The backend path is the materialization's exact
`<tgrep-output>/bin/tgrep` source. The launcher interpreter is the exact
`node-runtime` executable in the same closure. Both paths are embedded in the
generated launcher and are only visible when #293's explicit filesystem
projection makes them visible.

The required evidence remains the #308 evidence:

- backend: `tgrep 1.0.4`;
- Nix installable:
  `github:NixOS/nixpkgs/8804d221b8210f7b2b9e84a450617aac5df80e08#tgrep`;
- help SHA-256:
  `af98560daab3db4eb96b8fc3beafa15f397dbe2a4c6e8f5b0566b07fd0a9255f`;
- help size: `9,103` UTF-8 bytes.

The provider accepts the materialization only when its version/help evidence,
provider identity, exact executable source, and strict closure projection still
match that contract. Evidence is not re-collected at provider runtime.

## Closed compatibility matrix

The source of truth is `TGREP_RG_COMPATIBILITY_MATRIX` in
`src/domain/runtime-provider-tgrep.ts`. Supported flags are normalized to the
listed tgrep spelling and the positional portion is always preceded by an
explicit `--` so a search pattern cannot become a tgrep subcommand.

| `rg` input                                                               | backend mapping               | status    |
| ------------------------------------------------------------------------ | ----------------------------- | --------- |
| `<PATTERN> [<PATH>...]`                                                  | `-- <PATTERN> [<PATH>...]`    | supported |
| `--files`                                                                | `--files`                     | supported |
| `-i`, `--ignore-case`                                                    | `--ignore-case`               | supported |
| `-s`, `--case-sensitive`                                                 | `--case-sensitive`            | supported |
| `-S`, `--smart-case`                                                     | `--smart-case`                | supported |
| `-F`, `--fixed-strings`                                                  | `--fixed-strings`             | supported |
| `-w`, `--word-regexp`                                                    | `--word-regexp`               | supported |
| `-v`, `--invert-match`                                                   | `--invert-match`              | supported |
| `-H`, `--with-filename` / `-I`, `--no-filename`                          | matching canonical flag       | supported |
| `-n`, `--line-number` / `-N`, `--no-line-number`                         | matching canonical flag       | supported |
| `-g`, `--glob` / `--iglob`                                               | matching flag and exact value | supported |
| `--hidden`, `--no-ignore`, `--no-messages`                               | matching canonical flag       | supported |
| `-l`, `--files-with-matches` / `--files-without-match`                   | matching canonical flag       | supported |
| `-c`, `--count` / `-o`, `--only-matching`                                | matching canonical flag       | supported |
| `-m`, `--max-count` / `--max-depth`                                      | matching flag and exact value | supported |
| `-q`, `--quiet`                                                          | `--quiet`                     | supported |
| PCRE, replacement, encoding, binary, JSON, vimgrep, color, column/offset | none                          | rejected  |
| type database, symlink following, unrestricted search                    | none                          | rejected  |
| tgrep commands, index/runtime controls                                   | none                          | rejected  |
| stdin operand `-`, unknown flags, combined short flags                   | none                          | rejected  |

Rejected forms return a canonical actionable `INVALID_ARGUMENT` before the
backend process is spawned. Incompatible case, filename, line-number, and
file-result modes are rejected at the same boundary. Values containing spaces,
Unicode, or leading dashes are passed as argv values; a leading-dash pattern
or path must follow the explicit `--` terminator. Search paths are limited to
repository-relative values; absolute paths and `..` escapes are rejected.

## Execution and authority

The generated launcher uses `spawn(exactBackendPath, translatedArgv, {
shell: false})` and inherits stdio. Nonzero backend exits and signals are
forwarded unchanged. The same `/nawabari/bin/rg` projection is therefore used
by direct `session run -- rg ...`, a child process resolving `rg` through the
strict `PATH=/nawabari/bin`, and the merged #294 `session shell` frontend.

The launcher is projected as a read-only regular file through #293. Its source
cannot be under `/nawabari/bin`, and the materializer rejects missing,
non-canonical, or conflicting artifacts. Strict sandbox filesystem projection
remains the authority for worktree and backend visibility; the adapter adds no
mounts and cannot restore hidden host `/usr/bin/rg`, `/usr/bin/grep`, or any
other host path.
