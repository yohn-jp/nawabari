# Releasing Nawabari

This document describes the procedure for publishing a new version of `nawabari` to npm. The publish pipeline is defined in [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) and is authoritative for exact behavior; this file is an operational summary, not a second source of truth.

## Overview

Publishing is triggered by a **published GitHub Release** whose tag is `v<package.json version>`, targeting a commit on `main`. The workflow re-verifies the tag/commit/version relationship itself, so an incorrectly targeted or malformed release simply fails validation rather than publishing something wrong.

```
release created (tag vX.Y.Z, target = commit on main)
  -> prepare: verify tag matches package.json version at that commit
  -> build:   format check, lint, typecheck, test, action-pinning check,
              build + pack the exact release tarball
  -> smoke-test: install and run the packed tarball on Node 24
  -> publish: npm publish (Trusted Publishing/OIDC), skipped if already published
```

Any job failure stops the pipeline before `npm publish` runs. **No partial or unformatted release is ever published to the registry** — a failure here means try again, not that npm needs cleanup.

## Steps

1. **Prepare the release commit on `main`.**
   - Bump `"version"` in [`package.json`](../../package.json) to the target `X.Y.Z` via a normal PR (governed by Inari, `pr create --template default` or `release` as applicable).
   - Add `docs/releases/X.Y.Z.md` describing the release, following the style of prior entries in this directory.
   - Run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, and `pnpm test` locally before opening the PR — these are exactly the gates `publish.yml` re-runs, so catching failures here avoids a stuck release later.
   - Merge the PR to `main`.

2. **Create the GitHub Release**, targeting the exact merge commit on `main`:

   ```bash
   gh release create vX.Y.Z \
     --target <40-char-commit-sha> \
     --notes-file docs/releases/X.Y.Z.md \
     --title "Nawabari X.Y.Z"
   ```

   `--target` requires the full commit SHA (a short SHA is rejected as an invalid `target_commitish`). Publishing the release triggers `publish.yml` automatically.

3. **Watch the run:**

   ```bash
   gh run list --workflow=publish.yml --limit 1
   gh run watch <run-id> --exit-status
   ```

4. **If a job fails before `publish`:** nothing was published to npm. Fix the underlying issue on a normal branch/PR to `main`, then either re-run the failed job (only safe if the failure was environmental) or delete and recreate the release/tag once `main` is fixed:

   ```bash
   gh release delete vX.Y.Z --yes
   git push origin :refs/tags/vX.Y.Z
   ```

   Prefer bumping to the next patch version and re-releasing over reusing a tag once its release has been deleted, if the fix changes any published-facing content (e.g. release notes bundled into what a consumer reads), to keep tag history unambiguous.

5. **If `publish` succeeds**, verify from the registry:

   ```bash
   npm view nawabari@X.Y.Z version
   npx -y nawabari@X.Y.Z --version --json
   ```

## Recovering a specific immutable release

`publish.yml` also accepts `workflow_dispatch` with `release_tag`, `release_commit`, and `package_version` inputs, for re-running publish against an **already-existing, unchanged** immutable release tag (e.g. the npm publish step itself failed after all prior gates passed). It re-verifies the tag/commit/version triple exactly as the `release` trigger does and is not a way to publish a different commit under an existing tag.

## Notes

- The `publish` job is a no-op (skipped, not failed) if the target version is already on the npm registry, making the pipeline safe to re-trigger.
- Format/lint/typecheck/test failures most commonly come from files not run through `pnpm exec prettier --write` before commit — this includes `docs/releases/*.md`, not just source.
