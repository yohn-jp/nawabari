# Product boundary

Normative owner: product scope and trust actors. Revision: [NAWABARI-TA-1](index.md).
This is the accepted target; [implementation status](implementation-status.md) records remaining gaps.

## Product

Nawabari is the machine-local, repository-scoped authority binding coding-agent sessions to owned worktrees, branches,
allowed filesystem operations, and protected execution. It manages local ownership, transition safety, coordination,
and recoverability. A repository may be used without an external orchestrator, GitHub, or a Control Server.

Nawabari owns local identity/binding; safe worktree provisioning and termination; intrinsic Git mutation safety;
explicit access-policy enforcement; claim conflicts and atomic handoff; runtime materialization and process ownership;
local state persistence/reconciliation; bounded evidence; and local operator control surfaces.

Nawabari does not own semantic dependency analysis, task decomposition, scheduling, model selection, prompts,
Issue/PR governance, review/merge authorization, remote control planes, cloud jobs, distributed coordination,
VM/OS/SSH/UID provisioning, or remote account management. Consuming an upstream scope does not make Nawabari its issuer.
Observing a physical merge conflict does not authorize choosing a semantic winner or automatically merging changes.
Executing a verifier does not make Nawabari the authority for test selection or business acceptance.

## Trust actors and capability boundaries

The trusted host operator owns the machine/user context and may invoke local CLI or authenticated operator control.
The protected payload is constrained by its session policy and must not receive the machine-wide Control capability.
The host kernel, host-side enforcement components, approved tool material, and operator are trusted foundations.
An unconfined process with the operator's ambient privileges, or host root, is outside the claimed sandbox boundary.

Caller identity/capability, current authority evidence, and explicit approval of a destructive effect are independent.
Knowing a session ID, reading a fresh snapshot, or supplying a preview is not caller authentication.
Control Server credential delivery follows [Q1](decisions/2026-09-27-target-architecture.md) without changing inherited
network semantics. A filesystem-protected process may still reach local network services.

## Machine and repository model

A local repository authority is scoped by the canonical Git common directory, shared by that clone's worktrees.
A remote URL or provider repository ID is not a machine-global ownership namespace. Separate clones remain separate
local authorities, even when their remote identity is equal. A provider identity in an external scope is validated as
provenance and bound to the local session; it does not relocate persistence to GitHub.

One active session owns one worktree and one mutable branch; no two active owners share either physical worktree or branch.
Default/integration worktrees and protected branches are not ordinary mutable agent-session resources.
Multiple sessions may coordinate the same logical repository-relative path in distinct owned worktrees under the
explicit [claim contract](resource-coordination.md), not by sharing physical working directories.

At most one optional Control Server runs per machine/user context and routes multiple repositories.
Each repository retains its own state, lock, lifecycle, filesystem policy, runtime ownership, and claim generations.
There is no cross-repository atomic transaction, global claim store, remote repository discovery, or scheduler.
The machine catalog contains only validated locators and availability, never authoritative domain snapshots.

## Lifetime and failures

CLI calls are bounded invocations; TUI and server processes are control/presentation lifetimes.
Sessions and durable ownership outlive these callers. Each execution has its own process lifetime and durable identity.
Stopping or restarting the server changes listener/credential state, not session semantics or ownership.
Durable execution means recoverable ownership and release evidence, not a promise to replay jobs or persist terminal output.

Missing repository locators, missing worktree paths, old timestamps, unavailable kernel evidence, and server shutdown
never independently authorize ownership release or destructive cleanup. Reconciliation preserves the distinction
between durable intent, current physical facts, and a permitted recovery action.

Evidence behind the scope: [#365](https://github.com/yohn-jp/nawabari/issues/365),
[#400](https://github.com/yohn-jp/nawabari/issues/400), [#403](https://github.com/yohn-jp/nawabari/issues/403),
and [#664](https://github.com/yohn-jp/nawabari/issues/664). Their old execution plans are not new dispatch authority.
