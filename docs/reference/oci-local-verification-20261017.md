# Local OCI producer and consumer evidence — 2026-10-17

This records scoped local proof for the owner-authorized Mottainai Next producer repair. It is not independent code review, npm release certification, or full Mottainai Goal acceptance.

## Exact candidate

- Upstream base: `4fdee617765ba6d7a19c636e9e6b37112b5c68ff`.
- Saved verifier work `36e29e8e` and seccomp branch `14f89c08ed58b37c063061ea7e09df4f25ea1f8f` are preserved in ancestry.
- Packed production source: `75590a89f193803f94a69a0b68e18cafcb243a8d`, tree `522319d1f15e9e4aa0252ba88d8c247248ac2a20`.
- Package: `nawabari@0.14.0`; unpublished SHA-256 `6a3504bf2a6f62eb9f38009f1c266edbb71418127e6214d2e5bbd6a54846ca3d`.
- SHA-512 integrity: `sha512-8ZGXJqCUUigTduxdUKoGRbTfAWYsOxQUwe7T+cCEDf9XZfSTL2XSlOroHOSX+VVbJkwejr+TRPHwZVbwWL6Lsw==`.
- Subsequent changes are proof-script/documentation only; all 423 compiled files match this artifact.
- Next production pin: `492c5f521bf13299faea17f800a7bea0c1f6bfac`; later Next checkpoints preserve raw evidence/documentation.

## Actual supported environment

Rootless Podman 5.8.9/crun 1.30.1, NixOS 26.05/Linux 6.18.52, image `localhost/mottainai-oci-consumer-catatonit@sha256:0f69206065dc3ecb8622a6e0b0bf719e3fd1477a756470f3b324504877a57a97`, Node 24.17.0, Git 2.47.3 and Bubblewrap 0.12.0. Private PID/user/cgroup boundaries, default seccomp, no network or privilege; cpu/memory/pids delegation uses empty repository parents and image-owned catatonit. Host kernel cgroup observations prove inherited one CPU/512 MiB/128 PID limits; these are not independently configured per-session quotas. Network observation shows a private namespace, loopback only and no IPv4 routes.

Strict execution keeps all five observed namespaces distinct. Procfs is explicitly denied under the parent's masked/overmounted topology; no broad proc unmask or host fallback is used. The real payload read README, wrote/read its claimed tracked file, invoked Git, denied private Git metadata, and used the public checkpoint for exact in-claim Git changes. Actual outer-root/peer/control/secret sentinels were inaccessible.

## Verification and persistence

The exact tarball was installed offline into a separate disposable Next consumer at `668ed4d652e4d45e9cdcea263284dc68a6958209`. Public Candidate paths/import/verification used an actual Git bundle and exact head/tree checks. Both stage and verify have complete raw output, observed exit and empty namespace/cgroup evidence. The verifier printed exactly `PASS: owner-scoped README verifier\n`.

Evidence ID `verify-eb1573eb-b129-4ee6-aedb-bd0e085a8236` survived SQLite close/reopen (writer epoch 1 to 2) with the same complete private artifacts. Owner receipt body SHA-256: `96209687974abfea4d65695b9c91f28afe0be4a5cbb1930f5be3398e2942b405`; durable execution artifact: `dd890cbc64e1e0bbc8536db4e3e13f4494adf00edb981cb8ba06f4d231cc8996`. Public Candidate release proved a drained/kernel-empty fence, removed the exact clean subtree, then session close removed its worktree/branch and the Environment stopped.

This is a direct production-port proof with normal owner intent/grants and zero AgentRun contributions. It does not stand in for a model-backed application objective.

## Cancellation, timeout, stale refusal and restart

For actual cancellation `ebbff9f0-ba73-4454-baac-cdbd1d89c353`, a fresh protected nonce and live host parent/child identities were bound to the exact owned cgroup/private PID namespace before public close with terminate policy. The owner and host each observed that exact cgroup empty 28 times; the first empty sample followed the live sample by about 3.2 seconds, before the 45-second natural deadline. Both correlated PIDs were subsequently absent, the sibling survived and dirty work was retained by `DIRTY_WORKTREE`.

**The run acknowledgement remains unresolved.** It returned `SANDBOX_EXECUTION_FAILED`/`unresolved`, without a physical/raw receipt. A supplementary whole-host PID namespace scan stayed unknown because unrelated processes were unreadable. No whole-namespace-empty or byte-complete cancellation receipt, and no verification PASS, is claimed. The original runner exit 1 and failure summary remain unchanged. Its extra global-host-visibility/dirty-discard/replacement requirements do not replace the approved N1 requirement to reobserve the correct owned process scope and preserve sibling/container. The separate evidence classification records this distinction; production acceptance predicates were not relaxed.

Timeout returned unavailable/failed with an observed timeout exit and empty owned namespace/cgroup; its raw marker bytes are explicitly incomplete/truncated. A stale public snapshot refused `STALE_REGISTRY` with an unchanged execution-ID set. The current Next public EnvironmentPort stopped/restarted the same g4 container after fresh quiescence: two exact sessions stayed active with unchanged distinct worktrees, branches, base and working sets; delegated topology and host kernel limits/network were reobserved. Container stop was not used to claim per-session cancellation.

## Local checks and limits

Fresh packed-source checks: 84 focused tests passed without skips; typecheck, affected ESLint/Prettier, build and compiled worker (1/1) passed. Exact tarball and compiled-file equality checks passed. Fresh pinned Next checks passed typecheck/build and 52 focused tests without skips. The installed pinned package's contract/state/manifest exports imported successfully and private-path import was denied.

Nine real Landlock/protected/readiness/release source cases plus one unmatched-module load passed in the selected FHS OCI environment on earlier source `2ec5bea`; they are separately identified source evidence. The later production delta affects unresolved supervisor observation, tested at packed source and the actual installed N1 path. No full Linux-system lane or broad full product suite is claimed. Host full backend/CLI checks remain limited by absent canonical Nix Git material; no FHS host fallback was introduced. A prior source-input tmpfs pressure timeout is preserved separately, corrected by moving test inputs to the OCI writable filesystem without changing limits.

Reviewable raw evidence and digests are preserved in Next:

- [Exact-package consumer evidence](https://github.com/yohn-jp/mottainai-next/tree/fabcd62d/docs/reports/implementation/oci-recovery/evidence/20261017-next-physical-consumer-6a3504).
- [Original cancellation uncertainty and successful owner restart](https://github.com/yohn-jp/mottainai-next/tree/fabcd62d/docs/reports/implementation/oci-recovery/evidence/20261017-n1-cancel-restart).
- [Continuation chronology](https://github.com/yohn-jp/mottainai-next/blob/fabcd62d/docs/reports/implementation/oci-recovery/nawabari-20261017-continuation.md).

No npm package is published. Upstream merge/release and external review remain separate. An explicitly authorized compatible model/provider binding remains absent, so full Next R5–R7/Goal acceptance and its post-Goal Tsukai PR lifecycle remain blocked.
