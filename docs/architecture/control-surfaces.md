# Control surfaces

Normative owner: control adapters, operator capability, discovery, and read-model assembly.
Revision: [NAWABARI-TA-1](index.md). Q1/Q3 corrections are accepted but not implemented by this documentation change.

## Direct domain access, optional transport

CLI -> application/domain and Control Server -> the same application/domain are both first-class paths.
No existing CLI operation requires a server, HTTP round trip, or daemon. TUI remains supported.
Application services own typed command composition, current-authority checking, and approved-effect binding.
Presentation consumes results and does not own lifecycle, conflict, authorization, or recovery decisions.
Move the current `ui/session-actions` application responsibilities rather than copying them into another dispatcher.

CLI command/option/help discovery remains owned by the canonical command registry.
Domain action vocabulary is not defined by looking up a CLI option's values. HTTP maps to typed application requests;
there is no generic shell, executable command-string, remote agent, or arbitrary repository-path endpoint.
Public package exports remain `nawabari/state`, `nawabari/contract`, and `nawabari/manifest` projections, plus package metadata.
Do not publish internal mutation services or raw XState internals as new package APIs during refactoring.

## Trusted local operator capability (Q1)

The server is an operator surface across known repositories, not a session-agent authority endpoint.
Generate an ephemeral credential per server lifetime and rotate it on restart.
Only a trusted host-operator channel may deliver it. Unauthenticated root HTML/API must not disclose it.
Do not put the credential in URLs, logs, canonical repository state, agent prompts, or projected runtime files/environment.
Any local bootstrap artifact must stay outside protected visibility and cannot become a persistent domain authority.
Unconfined host processes with the same ambient operator privilege remain outside the isolation guarantee.

Keep IPv4 loopback-only binding, expected Host checks, same-origin browser mutation validation, no permissive CORS,
cryptographically strong token validation, JSON-only bounded mutation bodies, and safe browser rendering/CSP.
Use the existing dedicated API header; an absent/untrusted Origin is not a substitute for authentication.
Static unauthenticated content may provide an operator entry page without secret or private domain data.
The network mode remains inherited. Do not solve credential distribution by silently changing network compatibility.

Current root-document bootstrap conflicts with this rule. See [implementation status](implementation-status.md) and
[SECURITY.md](../../SECURITY.md); do not present the accepted correction as an existing guarantee.

## Server lifetime and discovery (Q3)

At most one Control Server is active per machine/user context, independent of selected port, cwd, or repository.
Zero is valid. A server lease and endpoint locator enforce operational ownership; they contain no session/claim/runtime state.
Resolve stale ownership through exact process-generation evidence, not PID/port/age alone. Unknown ownership fails closed.
Keep foreground execution, explicit occupied-port failure, supported port selection, and clean signal shutdown.
Do not add system service installation, automatic daemonization, remote listening, TLS/OAuth, accounts, or a global registry.

The machine catalog records only known canonical repository identity and safe reopen locators.
Registration uses serialized read-modify-write so concurrent repositories cannot lose each other's entries.
Each use re-resolves Git identity and existing registry presence; stale/unavailable locators do not create a new repository
or authorize deletion. Do not scan the machine for undeclared repositories or combine distinct repositories into one transaction.

A repository's synchronous lock/Git wait must not block unrelated repositories or health handling in the HTTP event loop.
Bounded I/O isolation or asynchronous adapters are implementation choices, not a new state owner or worker-side database.
All callers still use the same repository lock and current-state protocol.

## Observation service and projections

One application-owned Repository Observation Service composes the actual registry, coordination, profile, filesystem,
process, and lifecycle producers. Parsers/projectors alone are not collectors.
RepositoryRuntimeSnapshot is the canonical read model, not persistence or mutation authority.
TUI, Web UI, diagnostics, attention, conflict views, and bounded agent status consume it instead of probing independently.
No GET, refresh, or diagnostic operation implicitly cleans up, reconciles by mutation, or releases claims.

Preserve each producer's contract/version, source identity, observation time, availability, and truncation.
A consistent registry revision does not imply the kernel or worktree stopped changing.
If the registry changes during a join, retry within bounds or report stale/mixed/unknown evidence explicitly.
Do not expose an incompatible richer observation under an old schema identity.
Refresh considers physical observation changes as well as registry generations; unchanged persisted state is not proof that
live processes are unchanged. Mutation always reobserves required physical evidence rather than trusting a displayed empty state.

## Actions, approval, and errors

Offer only current typed lifecycle actions. State labels, attention colors, history, and age do not authorize buttons.
Authentication, concurrency evidence, and approval are checked separately; final domain mutation revalidates them.
Destructive preview/confirmation is bound to the approved effect at final commit, not only in UI preprocessing.
Existing observational retain/reconcile actions do not become park/apply aliases.
A current action token is not a transferable permission to control any session from a protected payload.

Preserve typed domain failures across CLI/HTTP. HTTP status is transport mapping only:
malformed input, authentication, not-found, stale/current conflict, unavailable capability, and unexpected internal failure
remain distinct. Do not turn an unknown producer into an empty successful response or imply durable retry from request-local caching.

## Required proof

Exercise CLI and HTTP against the same real backend; verify stale/changed-preview rejection and no-server operation.
Prove trusted operator success and protected-payload credential/other-session rejection, singleton across alternate ports,
concurrent catalog registration, server restart/token rotation, and repository A lock-held while B/health remain responsive.

Anchors: [server](../../src/control-server.ts), [catalog](../../src/control-repositories.ts),
[current dispatcher](../../src/ui/session-actions.ts), [backend](../../src/domain/session-backend.ts),
[snapshot](../../src/repository-runtime-snapshot.ts), and [observation parser](../../src/repository-runtime-observations.ts).
