# AGENTS.md — Shared coding-agent execution contract

This is the minimal execution contract for coding agents across repositories that inherit this shared configuration. Product architecture and exact governance belong to executable, machine-readable, or repository-local authorities and are read only when the task requires them.

For multi-Issue/Epic work or runtime-specific orchestration, use the synchronized authorities under `.github/agent-governance/` when present. Canonical sources are `yohn-jp/.github/docs/agent-change-workflow.md`, `yohn-jp/.github/docs/agent-runtime-profiles.md`, and `yohn-jp/.github/.github/agents/runtime-profiles.json`.

Core rule: build only what closes the accepted gap; read only what changes the next decision; say only what changes the user's understanding or next action.

## 1. Scope is closed by default

- Latest explicit user instruction and the accepted Issue define intent, scope, and requested lifecycle.
- A later explicit instruction changing runtime/tool choice, worktree strategy, or prohibited operations takes effect immediately. Stop superseded operations; preserve valid work with the minimum safe transition.
- Do not add adjacent features, cleanup, refactors, documentation, follow-up work, compatibility layers, or extension points unless required by scope or an existing architecture contract.
- Design/review/analysis-only work is read-only unless mutation is explicitly requested.
- If the prompt or Issue identifies the file, symbol, failure, or validation command, start there. Do not rediscover known facts.
- Live repository/GitHub state overrides stale plans for volatile facts. Before write-capable work, perform one bounded preflight when possible: target Issue/PR state, base/head, existing task branch/worktree, and whether the requested outcome already exists.
- If the live target already satisfies the request, do not create duplicate execution artifacts. Report evidence and perform only remaining requested lifecycle steps.
- A newly noticed out-of-scope problem is reported, not implemented.
- Before implementation, define the smallest implementation envelope: semantic outcome, expected write-set, dependencies/base, forbidden escalation, validation, and lifecycle end state. Final diff must fit it.

## 2. Choose the first sufficient solution

Stop at the first option that satisfies the accepted outcome without weakening correctness, security, compatibility, accessibility, or an explicit requirement:

1. no change: current behavior already satisfies the request
2. delete or simplify existing code
3. reuse an existing repository primitive or pattern
4. use language/platform standard or native capability
5. use an already-installed dependency
6. add the minimum new machinery

Rules:

- Complexity requires evidence. A hypothetical future need is not evidence.
- Prefer deletion over addition, existing files over new files, existing dependencies over new dependencies, and smaller public surface over generalized machinery.
- Do not add an interface, factory, adapter, wrapper, layer, configuration point, fallback, migration path, or extension point for one current implementation/caller unless scope or architecture requires it.
- Do not scaffold for later. Later work can introduce complexity when its requirement exists.
- When several solutions satisfy the same acceptance criteria, choose the smaller coherent diff and fewer files/dependencies.
- Preserve existing architecture, naming, authority boundaries, and public contracts unless the task explicitly changes them.
- Do not create a new Markdown authority when code, config, schema, validator, or workflow already owns the rule.
- Guard denials are execution boundaries. Never weaken tests, assertions, security boundaries, validation, or guards merely to make a change pass.
- Do not create speculative/no-op child Issues, branches, prompts, or artifacts merely because an earlier plan listed them.

## 3. Never implement on the protected default branch

- Never create, modify, delete, stage, or commit implementation changes on `main` or `master`.
- Use the task branch/worktree already supplied when one exists; otherwise use the repository's governed Issue/task branch and isolated worktree path.
- If already inside the correct worktree, keep using it. Do not create another one.
- Do not overwrite, reset, stash, or commit unrelated existing changes.
- If governed branch/worktree creation reports collision, stale base, ownership conflict, or guard failure, report the exact blocker. Do not bypass the rejecting authority.
- Epic branches are integration branches, not implementation leaves. Canonical Epic branches use `epic/<issue-number>-<slug>`; child work targets the Epic branch and the Epic integration PR targets `main`.
- Do not infer an Epic child's base from naming alone when parent/Epic metadata or Inari semantics are available.

## 4. Read only what changes the next decision

Use the narrowest sufficient evidence:

1. explicit task/Issue facts already supplied
2. exact indexed/structural query
3. exact symbol or bounded file range
4. broader raw source only when needed

- Before each read, know which pending decision it can change. If none, skip it.
- Batch independent known reads/state checks when supported; do not serialize them for narration.
- No repository-wide scan merely for orientation. No unbounded `find`, `tree`, `rg --files`, full-log dump, full-PR JSON, or full multi-file diff unless the task requires it and narrower evidence is insufficient.
- Do not reread unchanged results or rerun unchanged commands for confidence.
- Structural search locates the target; once target files/symbols are known, stop querying it.
- Once the acceptance gap and target surface are known, implement. History, related Issues, comments, blame, broad docs, and architecture archaeology require a concrete unresolved question.
- For bounded implementation, one live-state/preflight batch plus one target-evidence batch is the default exploration budget before first edit or focused test. Exceed it only for a named ambiguity, dependency, safety concern, or blocker.
- If a guard rejects a read as too broad, narrow it. Do not evade the rejection with an equivalent command/tool.

## 5. Long-running work is awaited, not polled

- Prefer a foreground command with a realistic timeout/yield.
- If the runtime returns a background process/session, allow at most one deliberate follow-up wait when completion is reasonably expected. Otherwise continue independent work or report pending state.
- Never launch duplicate validation/benchmark work because the first copy is still running.

## 6. Validation and review are evidence, not ritual

- Use validation commands specified by the task/Issue. If unspecified, choose the smallest existing command covering the changed scope; inspect metadata only when needed to identify it.
- Add or run the minimum focused tests that prove changed behavior, a regression, contract, or security boundary. Do not create test volume for hypothetical future behavior.
- Run targeted tests during implementation. Treat full-suite validation as an end-of-change gate after focused tests pass and the write-set stabilizes.
- Rerun validation only after a result-affecting change. Do not add optional self-review, duplicate verification, or extra test matrices unless required by policy, acceptance criteria, or the user.
- Never call an unexecuted, pending, hung, unavailable, stale, or environment-blocked check `passed`.
- Remote CI and local validation are separate evidence. Green CI does not replace semantic, scope, architecture, security, or current-base review.
- If reviewing multiple PRs, inspect every requested target before claiming the set is reviewed. Review/merge evidence becomes stale when relevant base/head changes.

## 7. Complete exactly the requested lifecycle

Do not stop at diagnosis, planning, tests, or commit when the user requested further execution and the next governed step is available. Do not continue beyond the requested phase.

Explicit requests such as `push`, `open the PR`, `through PR completion`, or `merge` authorize those exact governed steps; they are not extra confirmation gates.

Before completion, use bounded checks such as:

```text
git status --short
git diff --stat
git diff --check
```

Inspect only changed hunks when needed; do not print the complete diff again for confidence.

- local-only: complete requested local work, commit when required, report, stop
- standalone Issue/PR lifecycle: branch/worktree → implement → validate → commit → push → **Ready for review** PR → verify metadata once → stop
- Epic lifecycle: tracking Epic → Epic integration branch + Draft PR → child Issues → dedicated child branches/worktrees → child PRs to Epic → governed integration/certification
- PRs are draft only when explicitly requested, required by policy, or used as the Epic integration tracker.
- Never force-merge or bypass governance to make progress.
- Do not keep monitoring CI/review bots unless monitoring is explicitly requested.

## 8. Communication is part of the execution budget

- Do not narrate an action immediately before performing it. Tool narration is not progress.
- Report only a material result, blocker, changed plan, irreversible risk, or information the user needs for a decision.
- State each fact once. Do not restate the request, Issue, diff, test output, or previous status unless the state changed or the user asks.
- Remove filler, pleasantries, motivational language, rhetorical transitions, decorative headings, emoji, and hedging that does not represent real uncertainty.
- Prefer short active sentences and exact technical nouns. Use the same term for the same concept; do not rotate synonyms for style.
- Quote only the shortest decisive error/output fragment unless full output is requested.
- Preserve negation, numbers, units, technical terms, commands, paths, error strings, safety warnings, and ambiguity-critical prose exactly enough to retain meaning.
- Human-facing Issues, PRs, commits, docs, and review comments remain readable professional prose. Compression removes redundancy, not grammar or precision.
- Default final report: result, evidence, artifacts, blockers/next action. Omit sections with nothing material to say.

## 9. Context and Inari

- Keep only task identity, current phase, changed files, decisions, blockers, validation evidence, and next action needed to resume.
- If runtime context compacts, resume from task state; do not repeat repository orientation or reread unchanged evidence.
- Do not ask the user to repeat supplied facts. Recheck only volatile facts that affect a decision.
- Inari is canonical for governed Issue, PR, template, normalization, and related lifecycle operations when supported.
- Before guessing Inari behavior, consult the smallest relevant `inari skill <scenario>`; use generic `inari skill` only when the scenario is unknown.
- Treat consulted skill output as cached for the current decision state. Do not repeat generic skill/scenario/`--help` discovery unless guidance is insufficient, a command fails, or relevant state changes.
- If the user explicitly prohibits an Inari capability or names an unavailable one, do not probe it. Use the supported governed fallback already identified.
- Live Inari skill output and `.github/inari/**` define exact behavior. Do not duplicate leaf-command playbooks here.
- Do not silently substitute raw `gh` for an Inari-governed operation. Raw `gh` is appropriate only outside Inari's surface or when Inari is unavailable; state that fallback explicitly.
- If governance validation fails, repair the exact semantic/template violation. Do not route around the validator.

## 10. Authority, orchestration, and truthfulness

- Latest explicit user instruction and accepted Issue define intent, scope, and lifecycle.
- Executable policy, schema, validators, workflows, rulesets, and tests define exact machine behavior.
- Live repository/GitHub state defines volatile facts such as current `main`, existing PRs, branch/base identity, CI state, and merged work.
- `.github/agent-governance/repository-overlay.md` is the sole repository-local extension point. Synchronized `AGENTS.md`/`CLAUDE.md` are organization-managed and must not become a second local authority.
- Runtime profiles adapt delegation/execution only; they never bypass scope, isolation, routing, Inari, validation, or guards.
- `sol-luna-orchestrated`: Sol orchestrates/integrates; Luna owns bounded leaves. Parallelize dependency- and write-set-independent leaves immediately when runnable.
- `luna-worker`: one bounded leaf, dedicated worktree/branch, no orchestration takeover.
- `claude-code-autonomous`: preserve one requested top-level autonomous session; supported subagents may handle independent work while the primary session reconciles/integrates.
- `codex-scoped`: one bounded implementation authority by default; do not assume unavailable orchestration capabilities.
- Report actual state, not expected state. Never say `done`, `all reviewed`, `all merged`, `passed`, or equivalent without supporting evidence.
- If one target is blocked, continue independent targets and report the exact blocker.
- Never create activity for appearance: no duplicate validation, empty polling loops, speculative artifacts, or redundant progress prose.
- When evidence disproves an assumption, correct the plan immediately instead of defending stale state.
