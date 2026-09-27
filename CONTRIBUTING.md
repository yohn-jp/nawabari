# Contributing

## Authority before implementation

Read [AGENTS.md](AGENTS.md), the organization contract it delegates to, and the
[accepted Target Architecture](docs/architecture/index.md).
The architecture is an accepted design, not a claim that every target capability already exists.
Check [implementation status](docs/architecture/implementation-status.md) and the current source before defining a task.

A normal implementation starts with an accepted Issue, uses `<type>/<issue-number>-<slug>` in an isolated worktree,
and produces one bounded PR to the governed base. Do not implement on `main` or an Epic integration branch.
Use the current organization workflow for Epic topology, PR templates, and required checks.
Explicit user-authorized documentation work does not imply permission to create or close Issues merely to supply a link.
Record that authority truthfully in the PR; do not fabricate a closing reference or disable a governance check.

An Implementation Agent may choose internal algorithms, names, and adapters inside the accepted contract.
It may not independently change authority ownership, canonical state, lifecycle, persistence, public semantics,
security/isolation, or compatibility. Report `ARCHITECTURE_DECISION_REQUIRED` with concrete contradictory evidence when
such a change is needed. Keep unrelated work independent; do not guess through the affected boundary.

## Development

Use Node.js >=24 and the exact package-manager version declared by `package.json#packageManager`.
Do not copy an obsolete version from a historical setup note.

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run typecheck
pnpm run format:check
pnpm run lint
pnpm run manifest:check
pnpm run verify
```

Tests use `node:test` and `node:assert/strict`, adjacent to the relevant source or under `scripts`.
TypeScript uses strict ESM/NodeNext and explicit `.js` extensions for relative runtime imports.
Use full identifier words and comments explaining reasons. Commit types include `feat`, `fix`, `docs`, `refactor`,
`test`, and `chore`. Avoid unrelated refactoring and speculative extension points.

## Proof and documentation ownership

Follow [verification/provenance](docs/architecture/verification-provenance.md).
Pure tests, repository integration, compiled workers, installed-package checks, and real Linux-system proofs establish
different facts. Some ordinary tests use controlled seams; that does not remove the real sandbox/Nix/cgroup prerequisites
of other tests or of the full verification path. Report blocked or unexecuted checks accurately.
Run focused checks while changing the owned surface and the required final checks on the submitted tree.
CI results must be tied to their actual SHA and environment.

Update the owning responsibility document when an explicitly approved semantic change is implemented.
Update README/reference usage only for commands actually exposed by the product.
Generated state diagrams follow the canonical generator; do not hand-edit them to depict an unimplemented target.
Provider pins and recorded conformance output belong in references/evidence, not a second architecture authority.

## Pull requests

Preserve the repository's current template sections and identity marker.
Describe delivered changes, relevant migration/security concerns, and checks actually run.
Reference existing design Issues as historical sources where appropriate without claiming their acceptance criteria are
newly completed. PR creation does not authorize merge; documentation adoption does not authorize product implementation.
Shared workflows remain organization-owned and referenced according to the existing policy.
The current organization AGENTS suspension of agent Inari usage remains in effect; this document does not reverse it.

For bugs/features use the repository Issue forms. Report security concerns through [SECURITY.md](SECURITY.md).
