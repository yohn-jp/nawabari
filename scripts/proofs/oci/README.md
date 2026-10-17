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
`--drain-policy terminate` on the tested target, then publicly creates a
replacement only after the closed target releases its exclusive write claim.
The runner records engine configuration separately from host-kernel evidence.
It binds Podman's owned container init PID to its `/proc` start time and
cgroup, observes the actual cgroup-v2 ancestor limits and network namespace,
and checks the container's host-visible interfaces and routes. While target
and sibling executions are active, it maps each public owner-reported
Nawabari scope below the observed repository cgroup, then reads that exact
host-kernel controller chain, `cgroup.events`, and `cgroup.procs`. The report
keeps explicit session-scope `max` values while deriving effective limits
from the physical ancestor chain. This preserves the tested replacement,
active sibling, and container without concurrent write ownership. The bounded
sibling payload exits naturally, while its session and worktree remain active
for the owner. Neither script signals a host process, restarts the container,
or launches a host-side verifier.

When continuing a run whose exact package and target already have a successful
strict-boundary receipt, `nawabari-oci-n1-run.py --reuse-positive-evidence`
validates and byte-copies that receipt instead of starting the successful
payload again. The remaining checks still obtain fresh public owner and
kernel observations.

For the 2026-10-17 g4 candidate, the exact Nawabari package SHA-256 is
`7747e92aacbca9d167a2b9328042d444db604dfd4a1a2097c0c3d7181bcc711d`. The
installer proof is produced separately and must match this package digest.
Keep each preparation and run evidence directory unique and retain failed
evidence; never overwrite earlier profile probes.
