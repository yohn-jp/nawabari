# Standalone Linux protected-session compatibility

The executable conformance evidence for Issue #147 is
`src/domain/standalone-linux-compat.test.ts`. It resolves a real session with
`enforce: true`, uses the runtime layout discovered by the canonical profile,
and executes commands through `runSandboxedCommand`; it does not use the
controlled bubblewrap test stub.

Run the evidence on a supported standalone Linux host with:

```text
node --test --import tsx src/domain/standalone-linux-compat.test.ts
```

The test covers:

- Git worktree root, status, and diff observation inside the protected child;
- Nawabari checkpoint, diff, claim, commit, local-bare-remote push, merge, and
  close lifecycle operations;
- shell/core tools, Node, pnpm, Rust/Cargo, Python/uv, a C compiler and its
  subprocess, and a short-lived long-running agent-like CLI process;
- repository-owned shared HOME state and per-session HOME/cache state across
  sequential sessions;
- independent worktree, `/tmp`, and process views during concurrent launches.

The fixture uses only a temporary local Git repository and local bare remote.
It does not contact GitHub, invoke `gh`, require Mottainai or an LLM, or make
network access part of the evidence. The assertion for the protected contract
also requires `network_mode: "inherited"`.

For reproducibility, record the source revision and host/tool identities with
the test result:

```text
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
