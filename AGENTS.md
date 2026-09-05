# AGENTS.md — Shared coding-agent execution contract

This file is the minimal execution contract for coding agents across repositories that inherit this shared configuration.
It is not a project encyclopedia. Product architecture and exact governance rules belong to their executable, machine-readable, or repository-specific authorities and are read only when the current task requires them.

## 1. Scope is closed by default

- The user request and accepted Issue define task scope.
- Do not add adjacent features, cleanup, refactors, documentation, or follow-up work unless required to satisfy that scope.
- If the prompt or Issue already identifies the relevant file, symbol, failure, or validation command, start there. Do not rediscover known facts.
- When evidence is sufficient to implement or decide, stop exploring and act.
- A newly noticed out-of-scope problem is reported, not implemented.

## 2. Implementation never happens on the protected default branch

- Never create, modify, delete, stage, or commit implementation changes on `main` or `master`.
- Use the task branch/worktree already supplied by the environment or task when one exists.
- Otherwise create or use an appropriate Issue/task branch and isolated worktree according to the repository's executable policy and available tooling.
- If already inside the correct Issue/task worktree, keep using it; do not create another one.
- Do not overwrite, reset, stash, or commit unrelated existing changes.
- If branch/worktree creation or policy enforcement reports a collision, stale base, ownership conflict, or guard failure, report the exact blocker. Do not repair governed workflow state by bypassing the authority that rejected it.

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

## 5. Implement the smallest coherent change

- Preserve existing architecture, naming, authority boundaries, and public contracts unless the task explicitly changes them.
- Prefer one coherent implementation over speculative abstractions.
- Do not create a new Markdown authority when code, config, schema, validator, or workflow already owns the rule.
- Do not weaken tests, assertions, security boundaries, or validation merely to make a change pass.
- Guard denials are execution boundaries. Do not disable, bypass, rewrite, or work around a guard unless the task explicitly changes that guard or policy.

## 6. Validation is evidence, not ritual

- If the task/Issue specifies validation commands, use those commands. Do not first survey testing documentation.
- If validation is unspecified, choose the smallest existing command that directly covers the changed scope; inspect package/workflow metadata only when needed to identify it.
- Run targeted tests during implementation. Run the required final validation once after relevant mutations are complete.
- Rerun validation only after a change that can affect its result.
- Do not call an unexecuted, pending, hung, unavailable, or environment-blocked check "passed".
- Remote CI and local validation are separate evidence.

## 7. Complete the requested lifecycle

Do not stop at diagnosis, planning, or a partial implementation when the user requested execution and the next lifecycle step is available.

Before completion, use bounded checks only, such as:

```text
git status --short
git diff --stat
git diff --check
```

Inspect only specific changed hunks when a final code check is needed. Do not print the complete diff again merely for confidence.

Then finish the requested lifecycle:

- local-only request: complete the requested local work, commit when required, report, stop.
- implementation request with Issue/PR lifecycle: branch/worktree → implement → validate → commit → push → create a **Ready for review** PR → verify metadata once → stop.
- A PR is draft only when the user explicitly requests a draft or repository policy requires one.
- Do not keep monitoring CI or review bots unless the user explicitly asks for monitoring in the current task.

## 8. Context is runtime-owned

- Keep only task identity, current phase, changed files, decisions, blockers, validation evidence, and next action necessary to resume work.
- Do not search for a compaction command/tool or treat compaction as task work.
- If the runtime compacts context, resume from existing task state and changed files; do not repeat repository orientation or reread unchanged evidence.

## 9. Inari is the canonical path for governed GitHub operations

- For governed Issue, PR, template, normalization, and related lifecycle operations, use Inari when that surface is supported.
- Before guessing Inari flags, command sequences, template fields, recovery steps, or workflow behavior, consult `inari skill` or the relevant `inari skill <scenario>`.
- Live Inari skill output and repository governance schema such as `.github/inari/**` are authoritative for exact behavior. Do not duplicate leaf-command flags or static playbooks here.
- Do not silently substitute raw `gh` for an operation that Inari governs.
- Raw `gh` is appropriate only for operations outside Inari's governed surface or when Inari is unavailable. When falling back because Inari is unavailable, state that fallback explicitly.

## 10. Authority and precedence

- User instruction and accepted Issue define intent and scope.
- Executable policy, schema, validators, workflows, and tests define exact machine behavior when relevant.
- Repository-specific `AGENTS.md` or equivalent may refine this shared contract for local architecture or execution constraints without weakening higher-order governance.
- This file defines shared execution discipline only.
- If a guard blocks an action, that block is authoritative for the run unless the task explicitly changes the guard policy.
