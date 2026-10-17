# Strict execution with a masked parent procfs

This repair is an implementation candidate, not OCI qualification. Physical
execution, managed process ownership, and installed-consumer proof are separate
acceptance conditions.

The strict launcher previously always requested a new procfs with `--proc /proc`.
Linux can reject that mount when the enclosing rootless OCI profile masks paths
under its procfs. Binding the enclosing procfs would expose process information
outside the payload's private PID namespace; unmasking the container would change
its security boundary.

The request resolver now reads its own `/proc/self/mountinfo` before launch. A
parent procfs with child overmounts in an unprivileged user namespace, or an
unobservable parent procfs, selects an
empty read-only tmpfs at `/proc` instead. An observable procfs without child overmounts
selects the existing new private procfs. This selection only narrows visibility;
it does not retry a failed materializer, import the enclosing procfs, or select
compatibility execution. The private PID/user/mount/IPC/UTS namespaces and all
other filesystem and syscall restrictions remain required.

The empty view deliberately provides no `/proc/self`, process enumeration, or
proc-based descriptor paths. Tools requiring those interfaces remain unsupported
under that view; their failure must not trigger a broader mount. Physical tool
compatibility must be established with the exact installed artifact.

This change does not make a read-only cgroup hierarchy writable, establish a
delegated execution scope, or satisfy managed launch admission. Doctor's generic
sandbox readiness is not proof of managed runtime readiness. The public verifier
must preserve durable reservation, supervisor attachment, epoch revalidation,
release evidence, and observed cleanup; unavailable ownership remains a blocker.

The bounded policy tests and authoritative sandbox-request tests passed 21/21
on source commit `22287ce6255b2d1f89345c359c2c4ff0298a7ba2`; TypeScript passed
on that source. These checks do not certify the launcher, the OCI profile, or
physical isolation.
