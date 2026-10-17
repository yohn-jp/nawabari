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
README, writes the claimed fixture, confirms the Git worktree change, and
attempts reads from pre-created outer-container, peer-worktree, control-store,
and secret sentinels. It checks the launch's raw bytes and physical namespace
and cleanup receipt, a stale-snapshot refusal without a new execution record,
a verifier timeout with observed descendant cleanup, public owner close with
`--drain-policy terminate` on the tested target, then publicly creates a
replacement only after the closed target releases its exclusive write claim.
The runner records engine-inspected OCI CPU/memory/PID/network settings and
the selected session's observed network mode. While target and sibling
executions are active, it reads each owner-identified cgroup limit chain and
records the effective inherited limits. This preserves the tested replacement,
active sibling, and container without concurrent write ownership. The bounded
sibling payload exits naturally, while its session and worktree remain active
for the owner. Neither script signals a host process, restarts the container,
or launches a host-side verifier.

For the 2026-10-17 g4 candidate, the exact Nawabari package SHA-256 is
`cd4d3321d6f088bb509ac0f4bf6cec94452a552ae5605aa7f53e669bff0b5805`. The
installer proof is produced separately and must match this package digest.
Keep each preparation and run evidence directory unique and retain failed
evidence; do not reuse or overwrite earlier profile probes.
