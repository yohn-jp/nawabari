# Contributing

Thanks for your interest in contributing. This project is pre-1.0 — expect
breaking changes between minor versions until 1.0.

## Before you start

- Blank Issues are disabled. Open and discuss one concrete Issue before
  implementation.
- Include the Issue number in the branch name: `<type>/<issue-number>-<slug>`
  (e.g. `feat/42-add-init-command`), where `<type>` is one of `feat`, `fix`,
  `docs`, `refactor`, `test`, `chore`.
- Keep a pull request scoped to one closing Issue.

## Development setup

Requires Node.js >= 22.13 and [pnpm](https://pnpm.io/) 11.18.0.

```bash
pnpm install
pnpm run build
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run verify
```

`pnpm test` and `pnpm run verify` create the controlled sandbox-launcher
fixture in a temporary unprivileged directory. No `sudo`, machine-global
executable, or preinstalled bubblewrap is required. The separate real-isolation
tests run only when genuine bubblewrap and kernel support are available.

## Making changes

1. Create a branch off `main` using the Issue number.
2. Keep changes focused — a bug fix shouldn't carry along unrelated refactors.
3. Add or update tests next to the file they cover, as `<name>.test.ts`
   (or `<name>.test.mjs` under `scripts/`), using `node:test` +
   `node:assert/strict`.
4. Run `pnpm run verify` before opening a PR.
5. Update `README.md` in the same PR as any user-visible behavior change.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Code conventions

- TypeScript, strict mode, ESM (`module: NodeNext`). Relative imports use
  explicit `.js` extensions (e.g. `./cli.js`), even though the source file is
  `.ts` — required by NodeNext module resolution.
- Use full words in identifiers, not abbreviations.
- Comments explain **why**, not what.

## Pull requests

- Describe what changed and why.
- Link exactly one Issue using a closing reference such as `Closes #123`.
- Keep the pull request template sections.
- CI (typecheck, lint, test, build, package check) must pass.
- The `Governance / validate-pr` check enforces the branch-name and
  linked-Issue contract — see [`scripts/validate-pr.mjs`](scripts/validate-pr.mjs)
  and [`scripts/validate-branch-name.mjs`](scripts/validate-branch-name.mjs)
  for the exact rules.

## Reporting bugs / requesting features

Use GitHub Issues. For security issues, see [SECURITY.md](SECURITY.md)
instead of filing a public issue.
