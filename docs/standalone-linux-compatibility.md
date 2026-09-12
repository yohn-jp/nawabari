# Standalone Linux protected-session compatibility

The executable compatibility conformance evidence for Issue #147 is
`src/domain/standalone-linux-compat.test.ts`. It resolves a real session with
`enforce: true` and the explicit `EXPLICIT_COMPATIBILITY_RUNTIME_POLICY`, uses
the discovered runtime layout, and executes commands through
`runSandboxedCommand`; it does not use the controlled bubblewrap test stub.

The default protected path is strict `development` runtime resolution. Its
policy/materializer wiring and default-deny projection are covered by
`src/domain/runtime-resolution.test.ts` and the protected-runtime package
coverage; this compatibility suite intentionally opts into the legacy layout.

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
