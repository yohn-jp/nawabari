# nawabari

Read `.github/agent-governance/AGENTS.md` before working in this repository.

Nawabari owns machine-local, repository-scoped session/worktree isolation and protected execution.
It does not own GitHub governance, semantic orchestration, remote control, or machine provisioning.

## Canon

- `docs/architecture/index.md` identifies the accepted Target Architecture revision and its responsibility documents.
- The latest explicit human decision controls intent. The accepted architecture/public contract controls semantics;
  an accepted Issue / Implementation contract controls the bounded task within those semantics.
- Current code, schemas, generated artifacts, tests, and live GitHub state establish implementation reality.
  Consult `docs/architecture/implementation-status.md`; an accepted target is not a claim of implementation.
- Do not change authority boundaries, subsystem ownership, canonical state, lifecycle semantics, persistence,
  public-contract meaning, security/isolation, or compatibility policy independently.
- Return `ARCHITECTURE_DECISION_REQUIRED` with the exact base, affected contract, reachable path, and alternatives
  when a required semantic change is not already decided. Do not invent a fallback or a replacement authority.
- Preserve one repository transaction boundary. CLI and optional Control Server use the same domain authority;
  snapshots, diagnostics, attention, TUI, and Web UI are projections, not authorization sources.
- Shared governance copies and workflow policy remain organization-owned, including the current Inari suspension.

## Validation

Full verification: `pnpm run verify`.
Proof ownership and environment requirements: `docs/architecture/verification-provenance.md`.
Never substitute producer presence, a closed Issue, or an environment-blocked run for composed acceptance evidence.
