# Session-bound verification

The public `nawabari/contract` package exports `getSessionVerificationSnapshot`,
`executeSessionBoundVerification`, `describeSessionCandidateBundlePaths`, and
`stageSessionCandidateBundle`, their request/result types, and versioned contract
identifiers. The CLI exposes the same owner operations:

```sh
nawabari --json verification snapshot --session "$session_id"
nawabari --json verification candidate-paths --request-file candidate.json
nawabari --json verification execute --request-file verification.json
```

Run these commands in the repository or its owned worktree. Snapshot observation
adds no execution authority. Requests must carry the exact fresh owner snapshot,
an active managed session, its current filesystem policy, and a verification
profile. Missing ownership, stale claims or policy, and unavailable process
tracking fail closed. A caller does not construct a sandbox request.

A `nawabari.session-bound-verification.v1` request contains `schema_version: 1`,
`session_id`, `snapshot`, and `profile`. The profile uses
`nawabari.verification-profile.v1`: an approved executable/argv/cwd, declared or
repository read visibility, `write_policy: "deny"`, timeout, and output bound.
Verifier visibility is invocation-local and does not expand agent permissions.

For an externally assembled Candidate, first send a
`nawabari.session-candidate-bundle.v1` descriptor to `candidate-paths`. It contains
the session/snapshot, Candidate ID and SHA-256 digest, and exactly one source
bundle descriptor: `project_id`, `source_id`, `bundle_sha256`, `base_commit`,
`candidate_commit`, and `candidate_tree`. The bundle must advertise exactly
`refs/heads/mottainai-candidate`. Git object IDs are full SHA-1 or SHA-256 IDs;
digests use `sha256:<64 lowercase hex characters>`.

Transfer the source-owned bytes only to the returned `transfer_path`. The
returned private staging directories must be owned by the execution user, mode
0700, without symlink ancestors; the transfer is a regular owner-private file,
mode 0600, at most 64 MiB. The transfer operation is transport, not an attestation.
Use the returned `repository_path` as the verifier profile cwd. Include
`candidate_source: { candidate_id, candidate_digest, source }` in the verification
request. `execute` imports and verifies the exact bundle through a protected owner
staging launch, then runs the verifier against a read-only Candidate projection.
Do not call standalone `stage-candidate` first with that same request: staging
consumes the bundle and changes the session snapshot. Standalone staging returns
its new snapshot for subsequent owner operations.

The result binds the producer version, profile hash, source observations before
and after execution, managed execution identity, raw base64 stdout/stderr with
byte counts and completeness flags, physical namespace/start/termination/cleanup
observations, final snapshot, and a canonical SHA-256 receipt. Candidate-backed
results also include the actual staging receipt and Git head/tree identities.
A diagnostic stream or exit code alone does not establish a successful protected
execution. Unknown cleanup or incomplete output cannot become a passing receipt.
Consumers must preserve raw bytes and their own durable Evidence ID separately.

A profile timeout terminates its bounded execution. To explicitly terminate a
selected session's recorded owned execution scopes before closing it, use:

```sh
nawabari --json session close --session "$session_id" --drain-policy terminate
```

The default drain policy is `wait`. Termination uses the existing admission fence,
boot/execution identity, owned cgroup, and post-termination observation. It does
not terminate sibling sessions or the repository container. Closing still requires
the usual Git/integration and lifecycle conditions; a termination request does
not bypass them. Container restart invalidates live observations; take a fresh
snapshot and reconcile through the session owner before launching again.
