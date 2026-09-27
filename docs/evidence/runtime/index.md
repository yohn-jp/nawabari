# Historical runtime evidence

These files preserve the exact provider documents from source baseline
`3f814154c6ba9509ae9a1a15db41c890fc02271c`, unchanged from the reconstruction baseline.
They are version-bound historical evidence, not current architecture, new test results, or dispatch instructions.
Original Issue-owner wording and migration plans remain historical inside the preserved documents.
The [accepted architecture](../../architecture/index.md) owns current responsibility and security decisions;
[provider references](../../reference/runtime-providers.md) describe how to consume the existing material contracts.

- [tgrep materialization](tgrep-materialization.md): exact pinned backend source, version, hashes, and help evidence.
- [Projected rg provider](tgrep-rg-provider.md): version-bound compatibility matrix and provider handoff.
- [RTK/pnpm materialization](pnpm-materialization.md): exact backend sources, projection targets, hashes, and output.

Preserved Git blob identities:

```text
tgrep-materialization.md  d033f42bbabbe704910c70c5c891f5dc212ffe0d
tgrep-rg-provider.md      e57cd00ed7358542cf9ed20a3f980207806e760c
pnpm-materialization.md   49631d4bbbae42b2bb8aceedce56d5d7473e942e
```

These are the original bytes, not re-collected evidence. A backend upgrade needs evidence from that exact new material;
retaining a historical help/hash record does not certify a new version or a different runtime environment.
