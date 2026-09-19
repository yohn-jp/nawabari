# AGENTS.md — Shared coding-agent execution contract

This is the shared execution contract for repositories that inherit this file. Product architecture and exact machine behavior belong to the accepted Issue, repository-local executable authorities, and live repository/GitHub state.

Core rule: implement only the accepted gap; read only what can change the next decision; stop once the requested lifecycle is complete.

## 1. Authority and scope

- Latest explicit user instruction and the accepted Issue define intent, scope, and requested lifecycle.
- A governed Implementation Issue is an execution contract. When it already specifies architecture decision, expected write-set, invariants, acceptance criteria, validation, base, branch, or lifecycle, treat those decisions as settled. Do not redesign, re-audit, or rediscover them unless evidence shows a concrete contradiction or blocker.
- Executable policy, schema, validators, workflows, rulesets, tests, and live Inari guidance define exact machine behavior.
- Live repository/GitHub state defines volatile facts such as current `main`, Issue/PR state, branch/base identity, CI state, and merged work.
- Repository-local extensions belong only in `.github/agent-governance/repository-overlay.md` when present. Do not turn synchronized `AGENTS.md` or `CLAUDE.md` into a second local authority.
- Design/review/analysis-only work is read-only unless mutation is explicitly requested.
- A newly noticed out-of-scope problem is reported, not implemented.
- Never invent missing requirements or broaden scope for cleanup, refactors, documentation, compatibility layers, future extensibility, or “while here” work.

## 2. Bounded implementation path

For a governed bounded implementation, use this default path:

`contract → target evidence → edit → focused validation → final validation → requested lifecycle`

- Start from files, symbols, tests, commands, and dependencies explicitly named by the Issue or prompt.
- The expected write-set is the initial implementation boundary. Do not search for alternative ownership merely to reconfirm an already-decided architecture.
- Expand beyond the named target only for a concrete direct dependency, unresolved acceptance condition, safety/security concern, failing validation, or blocker.
- If expansion changes the expected write-set materially, state the reason before editing outside it.
- Once evidence is sufficient to implement, implement. Do not continue research for confidence.
- Preserve existing architecture, naming, authority boundaries, and public contracts unless the accepted work explicitly changes them.

## 3. Read discipline

Use the narrowest sufficient evidence:

1. facts already supplied by the user/Issue
2. exact indexed or structural query for a named question
3. exact target symbol/file
4. direct dependency or relevant test
5. broader source/history only when a concrete unresolved question requires it

Rules:

- No repository-wide scan merely for orientation. Do not use unbounded `find`, `tree`, `rg --files`, broad grep, full-log dumps, full multi-file diffs, or equivalent “understand the repo” passes unless the task itself requires them.
- “For understanding”, “just in case”, “related code”, and “one more check” are not sufficient reasons to read.
- Structural/indexed search is for locating a named symbol, caller/callee, dependency, or test surface. Once the required target set is known, stop querying it.
- If a structural query fails because an index is unavailable, fall back only to the smallest direct source reads needed; do not replace one failed query with broad grep.
- Once the minimal required file set is known, prefer one coherent full-file read when the file is reasonably sized over repeated fragmented reads that reconstruct the same context.
- Use bounded ranges only when the file is large and the required region is already known.
- Batch independent known reads/state checks when supported.
- Do not reread unchanged evidence or rerun unchanged discovery commands for confidence.
- History, blame, related Issues, comments, architecture archaeology, and broad docs require a named unresolved question.
- For bounded implementation, the normal pre-edit budget is one live-state/preflight batch plus one target-evidence batch. Exceed it only for a concrete dependency, ambiguity, safety concern, validation failure, or blocker.
- If a guard rejects a read as too broad, narrow it. Never evade the guard with an equivalent tool or command.

## 4. First sufficient implementation

Choose the first solution that satisfies acceptance criteria without weakening correctness, security, compatibility, accessibility, or an explicit architecture contract:

1. no change if behavior already satisfies the request
2. delete or simplify
3. reuse an existing repository primitive/pattern
4. use language/platform native capability
5. use an already-installed dependency
6. add the minimum new machinery

- Complexity requires evidence. Hypothetical future needs are not evidence.
- Prefer smaller coherent diffs, fewer files/dependencies, and smaller public surface.
- Do not add an interface, factory, adapter, wrapper, layer, configuration point, fallback, migration path, or extension point for one current caller unless scope or architecture requires it.
- Do not scaffold future work.
- Do not duplicate canonical helpers, implementations, validators, or authorities.
- Guard denials are execution boundaries. Never weaken guards, validation, tests, assertions, or security controls merely to make a change pass.

## 5. Git and isolation

- Never create, modify, delete, stage, or commit implementation changes directly on `main` or `master`.
- Use the supplied task branch/worktree when one exists. Otherwise create/use the governed Issue/task branch and isolated worktree.
- If already inside the correct worktree, keep using it.
- Do not overwrite, reset, stash, or commit unrelated existing changes.
- If branch/worktree creation reports collision, stale base, ownership conflict, or guard failure, report the exact blocker; do not bypass it.
- Epic branches are integration branches, not implementation leaves. Child work uses dedicated branches/worktrees and the governed parent/base relationship.

## 6. Validation and review

- The Issue's validation and acceptance criteria are authoritative when specified.
- During implementation, run the minimum focused test/check that proves the changed behavior, regression, contract, or security boundary.
- Do not add tests for hypothetical future behavior or as a “just in case” expansion.
- Run full required verification only after the write-set stabilizes and focused validation passes.
- Rerun a check only after a result-affecting change.
- Never call an unexecuted, pending, hung, unavailable, stale, or environment-blocked check `passed`.
- Remote CI and local validation are separate evidence. Green CI does not replace semantic, scope, architecture, security, or current-base review.
- Review compares the actual diff and tests against the accepted Issue, surrounding architecture, error paths, regressions, scope, and current CI. Do not create new requirements during review.
- If reviewing multiple PRs, inspect every requested target before claiming the set is reviewed. Re-evaluate after relevant base/head changes.

## 7. Complete exactly the requested lifecycle

Do not stop at diagnosis, planning, tests, or commit when the user requested further execution and the next governed step is available. Do not continue beyond the requested phase.

- local-only: complete requested local work; commit only when requested/required; stop
- standalone Issue/PR: branch/worktree → implement → validate → commit → push → Ready for review PR → verify metadata once → stop
- Epic: tracking Epic → integration branch/Draft PR → bounded child Issues/branches/worktrees → child PRs → governed integration/certification
- Draft PRs are used only when requested, required by policy, or serving as the Epic integration tracker.
- Never merge, close, force-push, bypass governance, or alter review state unless explicitly authorized.
- Do not keep polling CI/review bots unless monitoring is requested.
- Long-running work is awaited, not duplicated. Never launch a second validation because the first is still running.

## 8. Inari and runtime governance

- Inari is canonical for governed Issue, PR, template, normalization, and lifecycle operations when supported.
- Before guessing Inari behavior, consult the smallest relevant `inari skill <scenario>`. Do not repeat generic discovery once guidance is known unless state changes or a command fails.
- If the user explicitly prohibits an Inari capability or names an unavailable one, do not probe it.
- Live Inari skill output and `.github/inari/**` define exact behavior. If governance validation fails, repair the exact semantic/template violation rather than routing around it.
- Do not silently substitute raw `gh` for an Inari-governed operation. Use a fallback only when Inari is unavailable/outside its surface and state that fallback.
- Runtime profiles adapt execution/delegation only; they do not bypass scope, isolation, routing, validation, Inari, or guards.
- `sol-luna-orchestrated`: Sol orchestrates/integrates; Luna owns bounded leaves. Parallelize independent leaves.
- `luna-worker`: one bounded implementation leaf; no orchestration takeover.
- `claude-code-autonomous`: preserve the requested top-level autonomous session; supported subagents may handle independent work while the primary session reconciles/integrates.
- `codex-scoped`: one bounded implementation authority by default.

## 9. Communication and truthfulness

- Do not narrate an action immediately before performing it.
- Report only a material result, blocker, changed plan, irreversible risk, or information needed for a decision.
- State each fact once. Do not restate the request, Issue, diff, test output, or status unless it changed or the user asks.
- Remove filler, pleasantries, motivational language, decorative headings, rhetorical transitions, and hedging that does not represent real uncertainty.
- Prefer short active sentences and exact technical nouns.
- Quote only the shortest decisive error/output fragment unless full output is requested.
- Human-facing Issues, PRs, commits, docs, and review comments remain readable professional prose. Compression removes redundancy, not precision.
- Report actual state, not expected state. Never say `done`, `passed`, `reviewed`, `merged`, or equivalent without supporting evidence.
- If one target is blocked, continue independent targets where allowed and report the exact blocker.
- When evidence disproves an assumption, correct the plan immediately instead of defending stale state.
