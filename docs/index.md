# Documentation map

## Accepted architecture

[Target Architecture NAWABARI-TA-1](architecture/index.md) is the normative design adopted on 2026-09-27.
Read [implementation status](architecture/implementation-status.md) alongside it; target requirements are not release claims.

## Current usage and implementation references

- [CLI workflows](reference/cli-workflows.md): existing commands, bounded inputs, explicit recovery, and retry limitations.
- [Runtime projection](reference/runtime-projection.md): material-only profiles, strict/compatibility resolution, providers.
- [Runtime providers](reference/runtime-providers.md): pinned tgrep/rg and RTK/pnpm boundaries and preserved evidence.
- [Standalone Linux compatibility](standalone-linux-compatibility.md): a named compatibility proof, not universal support.
- [Contributing](../CONTRIBUTING.md) and [security reporting](../SECURITY.md).

## Generated and historical evidence

[Generated lifecycle diagram](architecture/generated/session-lifecycle.mmd) reflects the executable machine, not the target.
[Runtime evidence](evidence/runtime/index.md) preserves exact historical provider material without making it architecture.
[Protected execution benchmark](protected-execution-benchmark.md),
[pnpm worktree install benchmark](pnpm-worktree-install-benchmark.md), and [release notes](releases/)
remain historical measurements or release records, not current certification.

Old architecture URLs are retained as navigation to their replacements. They contain no parallel normative rules.
Organization-governance mirrors, license, code of conduct, binary assets, and historical release records are not rewritten
as product design documents. Their existing owners and purposes remain intact.
