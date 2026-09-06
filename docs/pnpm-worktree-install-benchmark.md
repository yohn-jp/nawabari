# pnpm fresh-worktree benchmark

Issue #44 evaluates `pnpm` settings for repeated dependency installation in
fresh Git worktrees. The benchmark is reproducible with:

```bash
pnpm install --frozen-lockfile
pnpm run benchmark:pnpm-worktree-install -- \
  --runs 10 --base-ref 9ddb76c737ebf99e94c252c5dc321ea70032f8b3 \
  --output /tmp/nawabari-pnpm-worktree.json
```

The benchmark clones the repository into a temporary local clone, creates a
fresh detached Git worktree for every measurement, and uses an independent
pnpm store for each configuration. It measures worktree creation through
`pnpm install --frozen-lockfile` completion. Cold, repeated warm, and one
fresh worktree after a deterministic local dependency/lockfile change are
reported separately. The temporary clone and worktrees are removed unless
`--keep-temp` is supplied.

## Decision

Adopt `enableGlobalVirtualStore: true` in `pnpm-workspace.yaml`.

The repeated fresh-worktree result is materially and consistently faster. The
first cold install is slower, so the setting is justified specifically by
Nawabari's repeated warm-worktree workflow rather than by averaging cold and
warm runs together. No other pnpm defaults are redundantly configured.

## Measured result

Environment: Linux WSL2 (`6.6.114.1-microsoft-standard-WSL2`), x64, Node
`v22.22.1`, pnpm `11.18.0`, filesystem statfs type `61267`, 4096-byte blocks.
The baseline was `origin/main` at commit
`9ddb76c737ebf99e94c252c5dc321ea70032f8b3`.

| Scenario                                        | Current settings | `enableGlobalVirtualStore: true` |
| ----------------------------------------------- | ---------------: | -------------------------------: |
| Cold first worktree (1 run)                     |         3,094 ms |                         4,138 ms |
| Warm fresh worktrees (10 runs, median)          |       1,265.5 ms |                         1,002 ms |
| Warm spread (min–max)                           |   1,245–1,302 ms |                     979–1,033 ms |
| Fresh worktree after dependency/lockfile change |         1,283 ms |                           985 ms |
| Cold `node_modules` usage                       |       70,740 KiB |                          556 KiB |

The warm median improves by 20.8%; every warm run in this measurement was
faster with the global virtual store. The dependency-change fixture improves
by 23.2%. The global store itself was 94,020 KiB versus 90,128 KiB for the
current configuration; this is the expected tradeoff for moving the repeated
virtual-store projection out of each worktree.

## Correctness and CI checks

The benchmark checks the approved `esbuild` postinstall and executable, a
native ESM import of `tsx`, and a build followed by a native ESM import from
`dist/contract.js` for both configurations. All three checks passed.

`pnpm run verify` passed in both configurations, including formatting, lint,
typecheck, 135 tests, pinned-action governance, exact package contents, and
the packed-package smoke test. The candidate also passed the same verify
command with `CI=true GITHUB_ACTIONS=true`.

pnpm 11.18.0's actual behavior is recorded rather than assumed: the current
default uses a local virtual store under CI, while an explicit workspace
setting of `enableGlobalVirtualStore: true` keeps the global virtual store in
CI. The candidate was therefore tested with that explicit CI behavior; no
Nawabari runtime or second cache-management mechanism is introduced.

## Mottainai follow-up

The result applies to pnpm dependency provisioning for repeated repository
worktrees. It does not add package-manager behavior to Nawabari or couple
Nawabari to Mottainai. Mottainai should evaluate its own bootstrap/cache
policy separately if it wants to reuse this evidence.
