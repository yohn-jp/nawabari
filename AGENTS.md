# AGENTS.md — Shared coding-agent execution contract

This file is the minimal execution contract for coding agents across repositories that inherit this shared configuration.
It is not a project encyclopedia. Product architecture and exact governance rules belong to their executable, machine-readable, or repository-specific authorities and are read only when the current task requires them.

For multi-Issue/Epic work or runtime-specific orchestration, use the synchronized authorities under `.github/agent-governance/` when present. Their canonical sources are `yohn-jp/.github/docs/agent-change-workflow.md`, `yohn-jp/.github/docs/agent-runtime-profiles.md`, and `yohn-jp/.github/.github/agents/runtime-profiles.json`.

## 1. Scope is closed by default

- The latest explicit user request and accepted Issue define task intent, scope, and requested lifecycle.
- Do not add adjacent features, cleanup, refactors, documentation, or follow-up work unless required to satisfy that scope.
- A design/review/analysis-only request is read-only unless the user explicitly requests a mutation such as creating an Issue or PR.
- If the prompt or Issue already identifies the relevant file, symbol, failure, or validation command, start there. Do not rediscover known facts.
- Current repository/GitHub state overrides stale plans, memories, or earlier reports for volatile facts. Reconcile existing Issues, PRs, branches, worktrees, and current bases before creating duplicates or choosing an obsolete execution order.
- When evidence is sufficient to implement or decide, stop exploring and act.
- A newly noticed out-of-scope problem is reported, not implemented.
- Before write-capable implementation, establish a small implementation envelope: semantic outcome, expected write-set/derived files, dependencies/base, forbidden escalation, validation, and requested lifecycle end state. Reconcile the final diff to that envelope.

## 2. Implementation never happens on the protected default branch

- Never create, modify, delete, stage, or commit implementation changes on `main` or `master`.
- Use the task branch/worktree already supplied by the environment or task when one exists.
- Otherwise create or use an appropriate Issue/task branch and isolated worktree according to the repository's executable policy and available tooling.
- If already inside the correct Issue/task worktree, keep using it; do not create another one.
- Do not overwrite, reset, stash, or commit unrelated existing changes.
- If branch/worktree creation or policy enforcement reports a collision, stale base, ownership conflict, or guard failure, report the exact blocker. Do not repair governed workflow state by bypassing the authority that rejected it.
- An Epic branch is an integration branch, not an implementation leaf. Canonical Epic branches use `epic/<issue-number>-<slug>`; child implementation branches/worktrees target the parent Epic branch, while the Epic integration PR targets `main`.
- Do not infer an Epic child's base from naming alone when parent/Epic metadata or Inari semantics are available.

## 3. Read only what changes the next decision

Use the narrowest available evidence and stop at the first sufficient level:

1. explicit task/Issue facts already provided
2. exact indexed/structural query
3. exact symbol or bounded file range
4. broader raw source only when the first three are insufficient

Rules:

- No repository-wide scan merely for orientation.
- No unbounded `find`, `tree`, `rg --files`, full-log dump, full-PR JSON, or full multi-file diff unless the task specifically requires it and narrower evidence is insufficient.
- Do not read an unchanged file/result twice in the same decision state.
- Do not rerun an unchanged command merely for confidence.
- Structural search is a locator, not a second repository read. Once target symbols/files are known, stop querying it.
- If a guard rejects a read as too broad, narrow the path/range. Do not evade the rejection with an equivalent command or another tool.

## 4. Long-running commands are awaited, not polled

- Prefer a foreground command with a realistic timeout/yield for the expected operation.
- If the runtime returns a background process/session, do not repeatedly poll it with empty input.
- At most one deliberate follow-up wait is allowed when completion is reasonably expected. If it is still running, continue independent work or report it as pending; do not start a polling loop.
- Never launch duplicate copies of the same validation or benchmark because the first one is still running.
- During a multi-step operation, surface material phase progress and blockers; do not leave the user with a long silent execution while state materially changes.

## 5. Implement the smallest coherent change

- Preserve existing architecture, naming, authority boundaries, and public contracts unless the task explicitly changes them.
- Prefer one coherent implementation over speculative abstractions.
- Do not create a new Markdown authority when code, config, schema, validator, or workflow already owns the rule.
- Do not weaken tests, assertions, security boundaries, or validation merely to make a change pass.
- Guard denials are execution boundaries. Do not disable, bypass, rewrite, or work around a guard unless the task explicitly changes that guard or policy.
- Do not create speculative/no-op child Issues or branches merely because a preliminary plan listed them. Reconcile live state and create only artifacts required by the accepted lifecycle.
- Do not split one requested orchestrated/autonomous top-level session into several unrelated prompts unless dependencies or the user explicitly require that topology.

## 6. Validation and review are evidence, not ritual

- If the task/Issue specifies validation commands, use those commands. Do not first survey testing documentation.
- If validation is unspecified, choose the smallest existing command that directly covers the changed scope; inspect package/workflow metadata only when needed to identify it.
- Run targeted tests during implementation. Run the required final validation once after relevant mutations are complete.
- Rerun validation only after a change that can affect its result.
- Do not call an unexecuted, pending, hung, unavailable, stale, or environment-blocked check `passed`.
- Remote CI and local validation are separate evidence.
- Green CI is not a substitute for semantic, scope, architecture, security, or current-base review.
- If the user asks to review multiple PRs, enumerate the requested set and actually inspect every target before saying the set is reviewed. Report exact per-target findings/blockers rather than a blanket status unsupported by evidence.
- Review/merge evidence becomes stale when the relevant base/head changes; re-evaluate immediately before merge when requested.

## 7. Complete exactly the requested lifecycle

Do not stop at diagnosis, planning, or a partial implementation when the user requested execution and the next requested lifecycle step is available. Do not continue into implementation, merge, release, or monitoring when the user requested only an earlier phase.

Before completion, use bounded checks only, such as:

```text
git status --short
git diff --stat
git diff --check
```

Inspect only specific changed hunks when a final code check is needed. Do not print the complete diff again merely for confidence.

Then finish the requested lifecycle:

- local-only request: complete the requested local work, commit when required, report, stop.
- standalone implementation with Issue/PR lifecycle: branch/worktree → implement → validate → commit → push → create a **Ready for review** PR → verify metadata once → stop.
- Epic implementation: tracking Epic → Epic integration branch + Draft PR → child Issues → dedicated child branches/worktrees → child PRs to Epic → integration/certification according to executable policy. Do not implement the tracking Epic directly as a leaf.
- A PR is draft only when the user explicitly requests a draft, repository policy requires one, or it is the Epic integration PR used as an integration tracker.
- Do not force-merge or bypass governance merely to make progress. A merge request authorizes the governed merge lifecycle, not falsification of evidence or disabling protections.
- Do not keep monitoring CI or review bots unless the user explicitly asks for monitoring in the current task.

## 8. Context is runtime-owned

- Keep only task identity, current phase, changed files, decisions, blockers, validation evidence, and next action necessary to resume work.
- Do not search for a compaction command/tool or treat compaction as task work.
- If the runtime compacts context, resume from existing task state and changed files; do not repeat repository orientation or reread unchanged evidence.
- Do not ask the user to repeat a fact already supplied in the current task. Verify only volatile facts whose current state materially affects the decision.

## 9. Inari is the canonical path for governed GitHub operations

- For governed Issue, PR, template, normalization, and related lifecycle operations, use Inari when that surface is supported.
- Before guessing Inari flags, command sequences, template fields, recovery steps, or workflow behavior, consult `inari skill` or the relevant `inari skill <scenario>`.
- Live Inari skill output and repository governance schema such as `.github/inari/**` are authoritative for exact behavior. Do not duplicate leaf-command flags or static playbooks here.
- Do not silently substitute raw `gh` for an operation that Inari governs.
- Raw `gh` is appropriate only for operations outside Inari's governed surface or when Inari is unavailable. When falling back because Inari is unavailable, state that fallback explicitly.
- For Issue/PR bodies, prefer structured semantic inputs rendered/normalized by Inari. Do not hand-build shell-interpolated Markdown or escaped newline sequences when a governed structured path exists.
- If governance validation fails, repair the exact semantic/template violation. Do not route around the validator with a different issuance path.

## 10. Authority and precedence

- Latest explicit user instruction and the accepted Issue define intent, scope, and requested lifecycle.
- Executable policy, schema, validators, workflows, rulesets, and tests define exact machine behavior when relevant.
- Live repository/GitHub state is authoritative for volatile facts such as current `main`, existing PRs, branch/base identity, CI state, and what is already merged.
- `.github/agent-governance/repository-overlay.md` is the sole repository-local extension point; it may refine this shared contract for local architecture or execution constraints without weakening higher-order governance. Synchronized `AGENTS.md`/`CLAUDE.md` are organization-managed and must not be hand-patched into a second local authority (see `docs/github-metadata-inheritance.md`).
- Runtime profiles adapt delegation/execution only; they do not change semantic workflow governance.
- This file defines shared execution discipline only.
- If a guard blocks an action, that block is authoritative for the run unless the task explicitly changes the guard policy.

## 11. Runtime orchestration profiles

When runtime-specific orchestration matters, use `.github/agent-governance/runtime-profiles.json` and `.github/agent-governance/runtime-profiles.md` if synchronized into the repository.

Core expectations:

- `sol-luna-orchestrated`: Sol owns orchestration/integration; Luna owns scoped leaf implementation. Parallelism follows dependency/write-set independence. Sol may reconcile overlapping shared authority at integration, but does not absorb ordinary leaf work.
- `luna-worker`: one bounded leaf, dedicated worktree/branch, no orchestration takeover.
- `claude-code-autonomous`: preserve a requested single autonomous top-level session; use supported subagents internally for independent work while the primary session owns reconciliation/integration.
- `codex-scoped`: one bounded implementation authority by default; do not assume orchestration capabilities not exposed by the active runtime.

A runtime profile never authorizes bypass of Issue scope, worktree isolation, branch/base routing, Inari, validation, or repository guards.

## 12. Operational truthfulness

- Report actual state, not expected state.
- Never say `done`, `all reviewed`, `all merged`, `passed`, or equivalent unless the claimed set and evidence actually support it.
- If one requested target is blocked, continue independent targets rather than abandoning the whole queue, and report the exact blocker.
- Never create activity for appearance: no duplicate validation runs, no empty polling loops, no speculative artifact creation.
- When a prior assumption is disproven by repository evidence, correct the plan immediately and state the corrected fact instead of defending the stale assumption.
