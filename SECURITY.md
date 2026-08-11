# Security Policy

## Supported Versions

This project is pre-1.0 (`0.x`). There is no long-term support branch yet —
security fixes land on `main` and the latest `0.x` release only.

| Version | Supported |
| ------- | --------- |
| 0.x     | ✅        |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](../../security/advisories/new) on this
repository rather than opening a public issue. If that path is unavailable to
you, open an issue with minimal detail and ask a maintainer to follow up
through a private channel.

Include, where possible:

- A description of the issue and its impact
- Steps or a minimal reproduction
- Affected version/commit

We aim to acknowledge reports within 5 business days. This is a small,
independently maintained project without a dedicated security team, so
response times are best-effort.

## Trust boundaries

Nawabari invokes the local `git` executable and reads or writes the repository's
common Git directory and managed worktree paths. It is intended for a trusted
local user and does not provide an operating-system sandbox, filesystem ACL,
or process isolation. Direct filesystem writes by a process that already has
permission to access another worktree are outside Nawabari's enforcement
boundary.

Nawabari does not contact GitHub, `gh`, an agent runtime, or a remote service,
and it does not handle credentials. Inputs that select branches and paths are
validated before Git mutation; ambiguous ownership and recoverable work fail
closed.
