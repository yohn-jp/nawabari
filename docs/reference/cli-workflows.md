# Current CLI workflows

Classification: usage reference for the implementation at `3f814154c6ba9509ae9a1a15db41c890fc02271c`.
Use installed `--help --json` and `capabilities --json` for exact schemas/options. The
[accepted architecture](../architecture/index.md) is the design authority; its pending corrections are not new CLI commands.

## Discovery and creation

```bash
nawabari capabilities --json
nawabari doctor --json
nawabari session create --help --json
nawabari session create --branch feature/example --json
```

Use the returned `session_id` and owned worktree, not guessed identifiers or the integration worktree, for agent mutations.
Default placement is beneath the reported `managed_worktree_root`; obtain it through `status --json`.
The current default is `<repository-parent>/.nawabari/worktrees`. Explicit new worktrees normally live under that root;
the existing compatibility path for an absolute direct child of the repository parent is not removed by this documentation.
Never interpret a colliding path/branch as permission to adopt another owner.

Initial resource/mode pairs are explicit and repeatable. Creation without pairs is supported; claim enforcement is off
unless `--enforce-claims` is selected. Explicit enforcement preserves required own-claim strength and canonical conflicts.
Initial ownership and claims commit together; an ordinary known failure must not leave a falsely usable partial session.

```bash
nawabari session create --branch feature/claimed --enforce-claims \
  --resource README.md --mode write --json
nawabari session claims --session "$session_id" --json
```

## Bounded working sets and auxiliary state

Supply both versioned artifacts for bounded bootstrap. Their repository identity and immutable base revision must agree.
Execution scope is the maximum; candidate entries describe need. Unknown fields and invalid provenance fail validation.
The exact artifact grammar is owned by [working-set parsers](../../src/working-set.ts), not a copied second schema here.
The [pre-adoption full artifact example](https://github.com/yohn-jp/nawabari/blob/3f814154c6ba9509ae9a1a15db41c890fc02271c/README.md#working-set-artifacts)
is retained as a version-bound reference; substitute real identity, revision, and authorization digest.

```bash
nawabari session create --base main --execution-scope-file execution-scope.json \
  --candidate-working-set-file candidate-working-set.json --json
nawabari session show --session "$session_id" --json
nawabari session scope expand --help --json
nawabari session scope expand --session "$session_id" --repository "$repository_id" \
  --repository-host "$repository_host" --revision "$working_set_revision" \
  --execution-scope-file execution-scope.json --path src/new-context.ts \
  --operation READONLY --reason 'Needed for current task' --json
```

Read `working_set.revision` before expansion. This is a working-set CAS value, not a Git SHA or claim generation.
A grant changes the set/revision/history; stale revision or different provenance rejects without widening authority.
Q2's consistent claims-off bounded mutation is an accepted correction, not a claim that every current expansion path
already applies it. READONLY remains distinct from mutation in both current and target contracts.

Auxiliary state is explicit durable repository-local copy, not arbitrary ignored-file discovery or runtime projection.

```bash
auxiliary_state='{"source":{"kind":"repository-local","path":".codegraph/ignored"},"target":{"kind":"managed-worktree","path":".codegraph/ignored"},"mode":"copy","durability":"durable"}'
nawabari session create --branch feature/auxiliary --auxiliary-state "$auxiliary_state" --json
```

Do not copy tracked-source shadows, host paths, sockets, PID files, or process-local state through this capability.

## Claims and Git mutation

```bash
nawabari session claim --session "$session_id" --resource README.md --mode exclusive-write --json
nawabari authorize --session "$session_id" --operation source-write --resource README.md --json
nawabari evidence snapshot --session "$session_id" --json
nawabari checkpoint --session "$session_id" --json
nawabari commit --session "$session_id" --message 'Update README' --resource README.md --json
nawabari push --session "$session_id" --remote origin --branch feature/example \
  --resource README.md --create-upstream --json
```

Run operations in the returned owned worktree. Branch/path values above must match the selected session.
Authorization checks do not persist grants or prevent a host process from editing outside Nawabari.
`guard` without an operation checks physical ownership; `authorize` checks the named operation and resources.
`guard --operation` remains the supported combined compatibility surface.
`--all-claimed` resolves qualifying claim-covered Git-changed paths; it is not a bypass or an implicit broad resource grant.
Claim updates/releases consume the current returned claim generation rather than an invented numeric constant.
For handoff, inspect the destination's current scope first; handoff does not expand it or auto-release a healthy owner.

## Close, explicit discard, and reconciliation

```bash
nawabari session inspect --session "$session_id" --schema-version 2 --json
nawabari session close --session "$session_id" --json
nawabari session discard --session "$session_id" --preview --json
```

Close refuses dirty/unintegrated/ambiguous ownership or unsafe runtime state.
For squash/rebase integration, an exact `--integrated-revision` is independently verified, not accepted as an assertion.
Only an explicit abandonment decision authorizes `session discard --session "$session_id" --json`.
Preview/confirmation and final effect binding remain subject to the documented current implementation gaps.

When a blocker supplies the owning session and a safe physical reconciliation action:

```bash
nawabari session inspect --session "$owner_session_id" --schema-version 2 --json
nawabari session reconcile --session "$owner_session_id" --apply --json
nawabari gc --dry-run --json
nawabari doctor --json
```

Use the reported blocking owner, not the waiting requester. A healthy competing owner is not stale merely because it blocks.
Retry the original operation only after successful authorized recovery. Doctor/GC observation does not silently repair.
Do not hand-edit registry state or use raw worktree deletion as supported recovery.

## Uncertain results

For `REGISTRY_DURABILITY_UNCERTAIN`, re-read the identified session/claims before retrying.
An exact established bootstrap is inspected through `bootstrap_retry.next_action`; unrelated ownership is never adopted.
Failed bootstrap actions remain non-ready and are not replayed automatically.
A lost HTTP response, absent output, or missing event in bounded history does not prove an effect absent.
Use operation-specific receipt/reconciliation semantics. A server request ID or dispatcher cache is not a universal
restart-safe exactly-once guarantee.
