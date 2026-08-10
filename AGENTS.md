# AGENTS.md — Mottainai execution contract

This file is the minimal execution contract for coding agents in this repository.
It is not a project encyclopedia. Product architecture and exact governance rules belong to their executable or domain-specific authorities and are read only when the current task requires them.

## 1. Scope is closed by default

- The user request and the accepted Issue define the task scope.
- Do not add adjacent features, cleanup, refactors, documentation, or follow-up work unless required to satisfy that scope.
- If the prompt already identifies the relevant file, symbol, failure, or validation command, start there. Do not re-discover known facts.
- When the evidence is sufficient to implement or decide, stop exploring and act.
- A newly noticed out-of-scope problem is reported, not implemented.

## 2. Managed task/worktree only

- Never create, modify, delete, stage, or commit repository files on `main` or `master`.
- Mottainai implementation work uses its managed task entrypoint: `mottainai task start` (or the repository-local equivalent when explicitly supplied by the task).
- Use the canonical worktree path returned by that command. Do not construct the path yourself.
- Do not run `git worktree add` for Mottainai tasks. Do not call the internal `createWorktree` implementation directly. Do not manually create `.mottainai/worktrees/*`.
- If already inside the correct managed Issue worktree, keep using it; do not create another one.
- If task creation reports a collision, stale base, claimed task, or policy failure, stop and report that exact blocker. Do not repair workflow state by hand.
- Do not overwrite, reset, stash, or commit unrelated existing changes.

## 3. Read only what changes the next decision

Use the narrowest available evidence and stop at the first sufficient level:

1. explicit task/Issue facts already provided
2. exact indexed/structural query
3. exact symbol or bounded file range
4. broader raw source only when the first three are insufficient

Rules:

- No repository-wide scan as orientation.
- No unbounded `find`, `tree`, `rg --files`, full-log dump, full-PR JSON, or full multi-file diff.
- Do not read an unchanged file/result twice in the same decision state.
- Do not rerun an unchanged command merely for confidence.
- CodeGraph/structural search is a locator, not a second repository read. Once the target symbols/files are known, stop querying it.
- If a hook rejects a read as too broad, narrow the path/range. Do not evade the rejection with an equivalent command or another tool.

## 4. Long-running commands are awaited, not polled

- Prefer a foreground command with a realistic timeout/yield for the expected operation.
- If Codex returns a background process/session, do not repeatedly call `write_stdin` with empty input to check whether it finished.
- At most one deliberate follow-up wait is allowed when completion is reasonably expected. If it is still running, continue independent work or report it as pending; do not start a polling loop.
- Never launch duplicate copies of the same long-running validation or benchmark because the first one is still running.

## 5. Implement the smallest coherent change

- Preserve existing architecture, naming, authority boundaries, and public contracts unless the task explicitly changes them.
- Prefer one coherent implementation over speculative abstractions.
- Do not create a new Markdown authority when code/config/schema already owns the rule.
- Do not weaken tests, assertions, security boundaries, or validation merely to make the change pass.
- Hook denials are execution boundaries. Do not disable, bypass, rewrite, or work around a guard unless the user explicitly asks to change the guard itself.

## 6. Validation is evidence, not ritual

- If the task/Issue specifies validation commands, use those commands. Do not first survey testing documentation.
- If validation is unspecified, choose the smallest existing command that directly covers the changed scope; inspect `package.json` or the relevant workflow only if needed to identify it.
- Run targeted tests during implementation. Run the required final validation once after the relevant mutations are complete.
- Rerun a validation only after a change that can affect its result.
- Do not call an unexecuted, pending, hung, unavailable, or environment-blocked check "passed".
- Remote CI and local validation are separate evidence.

## 7. Completion is a terminal phase

Before completion, use bounded checks only:

```text
git status --short
git diff --stat
git diff --check
```

Inspect only specific changed hunks when a final code check is actually needed. Do not print the complete diff again.

Then finish the requested lifecycle:

- local-only request: commit if the task requires a commit, report, stop.
- PR request: commit → push → create a **Ready for review** PR → verify its metadata once → stop.
- A PR is draft only when the user explicitly requests a draft.
- Do not keep monitoring CI or review bots unless the user explicitly asks for that monitoring in the current task.

## 8. Context is runtime-owned

- Keep only the task identity, current phase, changed files, decisions, blockers, validation evidence, and next action necessary to resume work.
- Do not search for a compaction command/tool. Do not treat "compaction" as a task to perform.
- If the runtime compacts context, resume from existing task state and changed files; do not repeat repository orientation or reread unchanged evidence.

## 9. Precedence

- User instruction and accepted Issue define intent and scope.
- Executable policy, schema, validator, and tests define exact machine behavior when relevant to the task.
- This file defines execution discipline only.
- If a hook blocks an action, its block is authoritative for that run unless the user explicitly changes the guard policy.
