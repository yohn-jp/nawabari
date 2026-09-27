# Standalone Linux compatibility qualification

Classification: implementation/test reference, not a universal platform-support or security guarantee.
The [runtime/process contract](architecture/runtime-process.md) and
[verification/provenance contract](architecture/verification-provenance.md) own the design and proof obligations.

## Named proof

The executable compatibility scenario is `src/domain/standalone-linux-compat.test.ts`.
It resolves a real session with `enforce: true` and the explicit `EXPLICIT_COMPATIBILITY_RUNTIME_POLICY`, discovers the
runtime layout, and calls `runSandboxedCommand`. It does not use a controlled bubblewrap substitute as positive evidence.

```bash
node --test --import tsx src/domain/standalone-linux-compat.test.ts
```

This deliberately exercises compatibility mode. The default strict `development` resolution and managed process-tracking
boundary have separate tests and prerequisites; a passing compatibility scenario does not prove all three equivalent.
No test result is newly reported by this documentation revision.

## Coverage and prerequisites

The existing scenario covers Git worktree root/status/diff, Nawabari checkpoint/diff/claims/commit, local-bare-remote push,
integration and close; shell/core tools, Node, pnpm, Rust/Cargo, Python/uv, C compiler subprocesses, and an agent-like process;
compatibility HOME/cache behavior across sequential sessions; and independent worktree, temporary, and process views
across concurrent launches.

Run on a supported standalone Linux host with the actual sandbox/kernel capability and required tool material.
Missing capability or material is unsupported/BLOCKED evidence, not a passing isolation proof.
The fixture uses temporary local Git repositories and a local bare remote, not GitHub, `gh`, an LLM, or Mottainai.
The asserted network mode is `inherited`; it does not establish isolation from host loopback services or the Control Server.
The [current Control Server limitation](../SECURITY.md) and accepted trusted-operator correction remain separate concerns.

## Record the evidence

Tie results to the exact source, environment, and tool identities rather than a release label alone.

```bash
git rev-parse HEAD
uname -a
node --version
pnpm --version
git --version
rustc --version
cargo --version
python3 --version
uv --version
cc --version
```

Use `package.json#packageManager` for repository development, not a pinned provider's backend pnpm version.
See [runtime projection](reference/runtime-projection.md) and [provider evidence](evidence/runtime/index.md)
for the distinction between declarations, materialization, executable projection, and historical qualification.
