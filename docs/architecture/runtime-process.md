# Runtime and processes

Normative owner: runtime preparation, admission, process ownership, and physical execution observation.
Revision: [NAWABARI-TA-1](index.md). See [implementation status](implementation-status.md) before treating target rules as
implemented guarantees.

## Responsibility chain

```text
selected immutable worktree profile + current access policy
  -> exact material resolution and executable projection
  -> filesystem/environment compilation
  -> current admission + durable execution reservation
  -> trusted supervisor attachment to owned scope
  -> durable release-attempt evidence
  -> payload GO
  -> fresh boot/process/cgroup observation
  -> operation-owned finalization or unresolved recovery
```

One-shot and interactive managed execution consume the same authorities. The shell is an explicitly projected executable,
not host shell plus chdir. The upper Worktree Runtime Profile owns configuration/maximum/pin/provenance;
material-only RuntimeProfile and SessionRuntimeProjection retain their lower-level responsibilities.
Do not merge these concepts just because both contain the word profile.

## Preparation and readiness

Desired declaration, resolved definition, pinned session profile, materialized runtime, observed capability, and drift are
separate facts. Repository edits produce drift, not automatic mutation of an existing pin.
Select materializers deterministically. A selected failure is terminal; strict execution must not try broad host mounts,
PATH lookup, another profile, or compatibility mode to manufacture success.
Providers consume exact material and expose explicit entrypoints; they do not discover new executable authority.
Use [runtime references](../reference/runtime-projection.md) for existing materializer/provider contracts.

Compile explicit session-local HOME/XDG/TMP and private Git/hook material with proven ownership and declared provenance.
Host PATH, HOME, credentials, arbitrary hooks, and startup files are not implicit inputs.
Auxiliary repository-local copies remain separate from runtime projections and cannot shadow tracked source.
Control Server credentials or their trusted bootstrap channel must never become projected runtime material.
Network mode remains `inherited`; this design does not add network isolation or a credential/network broker.

Report generic sandbox capability, material availability, managed process-tracking readiness, and bootstrap readiness
separately. Doctor, UI, and snapshots consume the same readiness producer rather than implementing independent probes.
A generic capability flag or cgroup filesystem presence does not prove that the managed delegated scope is usable.
Required capabilities must be demonstrated before reporting a usable managed bootstrap; unsupported remains explicit.

## Durable launch ownership

Every managed protected execution receives an immutable execution ID and durable ownership before payload start.
Bind the session, selected profile digest, effective filesystem witness, current runtime epoch, boot identity, supervisor
PID/starttime where established, and exact owned cgroup identity/root as required by the record contract.
PID alone is insufficient. Do not construct an owned scope from a guessed current host path for a legacy record.

Reserve -> attach -> record release attempt -> revalidate current epoch/admission -> GO ordering is mandatory.
Ordinary execution requires lifecycle eligibility and open current admission; a typed bootstrap purpose has its own
bounded `new`-session permission. Do not loosen ordinary admission to repair a bootstrap path.
An old policy token is not authority for a new launch. A running execution retains its original witness.
A durable execution record is not a promise of automatic payload replay, service restart, durable stdout, or job scheduling.

## Observation, drain, and termination

Git/FS/runtime observers report current facts. Owned process observation uses boot identity, process generation where
relevant, and current cgroup population. A top-level exit does not prove descendants are gone.
A zero-length execution record list is not a positive kernel-empty proof; unknown, untracked, and missing evidence remain
explicit. A different boot cannot be treated as the same live process or permission to signal a reused PID.

For authority reduction, close admission durably, release the repository lock, and collect bounded owned-scope evidence.
Wait and explicit terminate are distinct policies. Ordinary close does not silently SIGKILL processes.
Terminate only positively identified owned processes under explicit intent, then reobserve; elapsed time is not proof.
Reacquire the same repository lock and revalidate fence epoch/admission and fresh occupancy before final domain mutation.
Runtime must not directly release a claim or decide that unintegrated Git work can be discarded.

## Crash and cleanup

Before GO, uncertainty must remain distinguishable from confirmed non-release. After a release attempt or lost response,
reconstruct from durable evidence and fresh physical observation; do not rerun the payload merely because its result is lost.
Do not equate recorded `exited` with successful bootstrap, completed cleanup, or proven-empty scope.
Cleanup of runtime directories/scopes is identity-bound and requires the owning operation's proof.
Server restart reconstructs state; it does not assume ownership of arbitrary orphan processes or auto-resume execution.

## Required proof

Use real compiled supervisors and actual descendants on supported Linux with delegated cgroups v2.
Exercise reserve/attach/release/GO crash windows, PID reuse/different boot, live descendants after parent exit,
closed-admission races, absent/unobservable scopes, and exact policy witness preservation.
Controlled observation tests establish decisions, not positive sandbox/process isolation certification.

Anchors: [managed console](../../src/domain/session-console.ts),
[protected launch](../../src/domain/session-protected-launch.ts),
[supervisor](../../src/domain/session-launch-supervisor.ts),
[execution records](../../src/domain/session-execution-record.ts),
[process observation](../../src/domain/session-process-observation.ts), and
[drain integration](../../src/session-runtime-lifecycle.ts).
