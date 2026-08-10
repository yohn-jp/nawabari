# AGENTS.md

Minimal execution contract for coding agents in this repository. Prefer the
deterministic checks below over natural-language process; they are what CI
actually enforces.

## Scope

- The accepted Issue defines the task scope. Don't add adjacent refactors,
  cleanup, or follow-up work unless required to satisfy that scope.
- Report newly noticed out-of-scope problems; don't fix them inline.

## Workflow

- Branch off `main`, named `<type>/<issue-number>-<slug>` (see
  [CONTRIBUTING.md](CONTRIBUTING.md)). Never commit directly to `main`.
- Before opening a PR, run `pnpm run verify` — it composes format check,
  lint, typecheck, tests, action-pin validation, and the package/smoke-test
  suite. All of it must pass locally before it's asked to pass in CI.
- Link exactly one closing Issue in the PR body (`Closes #123`) and keep the
  PR template sections intact.

## Code

- TypeScript strict mode; no `any` (enforced by `eslint.config.mjs`).
- Tests live next to the code they cover as `<name>.test.ts`.
- Don't disable a lint rule, test, or CI check to make a change pass — fix
  the underlying issue or ask before weakening the guard itself.
