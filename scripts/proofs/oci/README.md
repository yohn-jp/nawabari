# OCI N1 physical proof

`nawabari-oci-n1-prepare.py` creates a fresh, disposable repository profile,
commits the two fixture files, creates one target with exact initial read and
write claims, creates a zero-execution drain probe with an atomic README read
claim, and binds an existing active sibling by its public session ID.
The target's read-only baseline contains `README.md` and a separate stale
claim trigger; its write-only fixture is not incorrectly required as a
read-only baseline. When an earlier guard-only attempt closed a target or
drain probe, the runner creates a replacement through public `session create`
using the preserved scope and candidate working-set artifacts. The runner
observes the sibling payload populated, closes the zero-execution probe
through public `session close --drain-policy wait`, and confirms the exact
sibling execution remains populated afterward. This exercises observed
sibling attribution in the physical cgroup tree.

`nawabari-oci-n1-run.py` uses only the public Nawabari CLI inside the selected
OCI container. It runs a real strict Node payload that reads the claimed
README, writes and reads back the claimed fixture, confirms the Git executable
is available while repository metadata access remains denied inside the
payload, and attempts reads from pre-created outer-container, peer-worktree,
control-store, and secret sentinels. After the payload, the public owner
checkpoint must observe the exact changed path under the selected session's
claim. The runner checks the launch's raw bytes and physical namespace and
cleanup receipt, a stale-snapshot refusal without a new execution record,
a verifier timeout with observed descendant cleanup, public owner close with
`--drain-policy terminate` on the tested target. A dirty-worktree close retains
that exact active target; a replacement is created only after the public API
has actually closed the target and released its exclusive write claim.
The runner records engine configuration separately from host-kernel evidence.
It binds Podman's owned container init PID to its `/proc` start time and
cgroup, observes the actual cgroup-v2 ancestor limits and network namespace,
and checks the container's host-visible interfaces and routes. While target
and sibling executions are active, it maps each public owner-reported
Nawabari scope below the observed repository cgroup, then reads that exact
host-kernel controller chain, `cgroup.events`, and `cgroup.procs`. The report
keeps explicit session-scope `max` values while deriving effective limits
from the physical ancestor chain. This preserves the retained target (or its
publicly created replacement), active sibling and container without concurrent
write ownership. The bounded
sibling payload exits naturally, while its session and worktree remain active
for the owner. Neither script signals a host process, restarts the container,
or launches a host-side verifier.

When continuing a run whose exact package and target already have a successful
strict-boundary receipt, `nawabari-oci-n1-run.py --reuse-positive-evidence`
validates and byte-copies that receipt instead of starting the successful
payload again. The remaining checks still obtain fresh public owner and
kernel observations.

For the 2026-10-17 g4 candidate, the exact Nawabari package SHA-256 is
`6a3504bf2a6f62eb9f38009f1c266edbb71418127e6214d2e5bbd6a54846ca3d`
(production source `75590a8`; earlier `7747e92a` evidence is retained separately). The
installer proof is produced separately and must match this package digest.
Keep each preparation and run evidence directory unique and retain failed
evidence; never overwrite earlier profile probes.

Cancellation completion requires repeated empty observations of the exact
public-owner and host cgroup plus re-observation of both captured payload PID
generations as absent or reused. A whole-host PID-namespace scan is diagnostic;
unreadable unrelated processes remain unknown. An unresolved run response or
missing physical/raw receipt remains incomplete and never becomes passing
verification. The original failed physical run is preserved. The corrected
predicate can be evaluated against those saved raw observations without
launching another payload; that is separately classified offline evaluation.
