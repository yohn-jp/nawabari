# Using this template

This repository is a baseline for new public TypeScript CLI projects (npm
distribution, GitHub-hosted, Node.js 22+, pnpm). It was extracted from the
Mottainai repository's development infrastructure, stripped of
Mottainai-specific product assumptions. See the accompanying audit for what
was kept, simplified, dropped, or made optional, and why.

Delete this file once you're done bootstrapping.

## 1. Create the new repository

```bash
# Using GitHub CLI, from a copy of this template's contents:
gh repo create OWNER/REPO_NAME --public --source . --remote origin
```

Or push this directory's git history to a fresh empty GitHub repo.

## 2. Replace placeholders

Search the whole tree for these tokens and replace every occurrence:

| Token          | Replace with                                      | Appears in                                |
| -------------- | ------------------------------------------------- | ----------------------------------------- |
| `OWNER`        | GitHub username or org                            | `package.json`, `CODEOWNERS`, `README.md` |
| `OWNER_NAME`   | Copyright holder name                             | `LICENSE`                                 |
| `PACKAGE_NAME` | npm package / bin name (no `@scope/` prefix here) | `package.json`, `README.md`, `src/cli.ts` |
| `REPO_NAME`    | GitHub repository name                            | `package.json`                            |
| `YEAR`         | Current year                                      | `LICENSE`                                 |

```bash
# Example, from the repo root, after copying:
grep -rl 'OWNER\|OWNER_NAME\|PACKAGE_NAME\|REPO_NAME\|YEAR' --exclude-dir=node_modules --exclude-dir=.git . \
  | xargs sed -i \
      -e 's/OWNER_NAME/Jane Doe/g' \
      -e 's/OWNER/janedoe/g' \
      -e 's/PACKAGE_NAME/gitpaw/g' \
      -e 's/REPO_NAME/gitpaw/g' \
      -e 's/YEAR/2026/g'
```

Run replacements in the order shown (`OWNER_NAME` before `OWNER` — it's a
superset match) or use distinct tokens if your sed doesn't support ordered
`-e` chains predictably.

If the package is unscoped (no `@OWNER/` prefix on npm), edit
`package.json`'s `"name"` field to drop the scope after replacement.

## 3. Fill in TODOs

- `README.md` — description and usage.
- `src/cli.ts` — real commands; wire `getVersion()` to `package.json`'s
  version (e.g. via a generated build-metadata step, or
  `createRequire(import.meta.url)("../package.json").version`).
- `SECURITY.md` — if the CLI executes commands, reads/writes outside a
  confined root, or handles credentials, document those trust boundaries
  explicitly (see the comment left in the file).

## 4. One-time GitHub repository setup

- **Branch protection / ruleset on `main`**: require the `CI` and
  `Governance` workflow checks before merge.
- **npm Trusted Publishing**: on npmjs.com, configure this repo + the
  `.github/workflows/publish.yml` file as a Trusted Publisher for the
  package. No npm token secret is needed — `publish.yml` uses OIDC
  (`id-token: write`). Create a `npm` GitHub Environment (Settings →
  Environments) so the publish job's `environment: npm` resolves.
- **CodeQL**: enabled by default via `.github/workflows/codeql.yml`; no
  extra setup needed beyond having Code Scanning available (public repos
  get it for free).
- **Dependabot**: `.github/dependabot.yml` is already wired for weekly
  `github-actions` and `npm` updates.

## 5. First release

```bash
pnpm install
pnpm run build
pnpm run verify
git add -A && git commit -m "chore: bootstrap from oss-cli-ts-template"
git push -u origin main
# Then, on GitHub: create a Release with tag v0.0.1 matching package.json's
# version. publish.yml runs on release-published and publishes to npm.
```

## What's deliberately NOT included

- Coverage gating/sharding, mutation testing, property testing, AI PR-review
  bots, and the "regression proof" auto-execution job from Mottainai are
  real but heavyweight patterns. Add them later, individually, once the
  project's size and contributor count justify the complexity — don't
  adopt them on day one just because Mottainai has them.
- Integration/E2E test-layer separation: start with one `pnpm test`. Split
  into fast/integration/e2e layers only once test runtime or fixture
  needs (filesystem, subprocess, network) actually demand it.
