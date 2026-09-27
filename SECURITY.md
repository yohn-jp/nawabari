# Security Policy

## Supported versions and reporting

This project is pre-1.0. Security fixes land on `main` and the latest `0.x` release; there is no long-term support branch.
Report suspected vulnerabilities privately through this repository's
[GitHub Security Advisories](https://github.com/yohn-jp/nawabari/security/advisories/new), not a public reproduction.
If private reporting is unavailable, ask for a private contact with minimal public detail.
Include impact, affected version/commit, and a minimal reproduction where available.
Acknowledgement within five business days is a best-effort objective, not a guaranteed response time.

## Guarantees and trust assumptions

Nawabari-mediated ownership and Git operations validate repository, session, worktree, branch, applicable authorization,
and recoverable-work evidence. Ordinary sessions do not install a universal filesystem ACL or sandbox every host process.
A process running outside the protected boundary with ambient access can bypass mediated commands.

Protected Linux execution uses explicit runtime projection and the selected supported isolation backend.
Managed execution additionally requires durable execution identity, admission fencing, and owned process/cgroup evidence.
Missing required capabilities fail closed. Optional capability availability must not be reported as a stronger guarantee.
The host kernel, trusted operator, approved runtime material, and host-side enforcement code remain trusted.
Nawabari does not protect against host root or an unconfined process with the operator's ambient privileges.

Network mode is `inherited`. A protected process may reach host loopback or external services according to host networking.
No implicit network isolation, secret broker, remote authentication service, or cloud control plane is promised.
Explicit Git transport and projected programs can use credentials supplied through their separately authorized channels;
Nawabari must not implicitly inherit host credentials, arbitrary hooks, startup files, or home directories.

## Control Server: current limitation and accepted correction

At source baseline `3f814154c6ba9509ae9a1a15db41c890fc02271c`, the optional Control Server places its startup control token
in the unauthenticated root HTML. Combined with inherited networking, this does not separate protected payloads from the
machine-wide operator capability. Browser Host/Origin/CORS/CSP protections are not authentication of non-browser clients.
This is a statically identified composition risk, not a claim of an executed exploit or a completed fix.
Do not rely on this server as a securely isolated operator surface while untrusted local/protected workloads run.

[Decision Q1](docs/architecture/decisions/2026-09-27-target-architecture.md) requires credential delivery only through a
trusted host-operator channel. Unauthenticated HTTP, logs, URLs, repository state, and protected runtime projections must
not expose that capability. The network contract remains unchanged. Freshness tokens and destructive confirmation are
separate from caller authentication and cannot replace it.
This documentation change adopts the correction; the implementation gap is tracked in the
[implementation status](docs/architecture/implementation-status.md).

## Canonical security contracts

The [product boundary](docs/architecture/product-boundary.md) defines actors and trust assumptions.
[Filesystem/isolation](docs/architecture/filesystem-isolation.md) owns permission narrowing and path safety.
[Runtime/process](docs/architecture/runtime-process.md) owns process attribution and quiescence.
[Persistence/concurrency](docs/architecture/persistence-concurrency.md) owns crash and uncertainty semantics.
[Control surfaces](docs/architecture/control-surfaces.md) owns local operator capability and browser/transport protections.
These documents, rather than this reporting policy, own the detailed invariants.
