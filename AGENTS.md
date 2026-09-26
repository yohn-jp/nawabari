# nawabari

Read `.github/agent-governance/AGENTS.md` before working in this repository.

Nawabari is the local Git session/worktree isolation and authorization runtime for coding agents.

## Canon

- Accepted Issues / Implementation contracts define task scope.
- Repository state-machine, ownership, authorization, and lifecycle behavior is defined by canonical source, public contracts, generated state artifacts, and tests.
- Preserve the boundary that Nawabari owns Git/session runtime behavior; product orchestration belongs elsewhere.

## Validation

Full verification: `pnpm run verify`.
