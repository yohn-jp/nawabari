# Filesystem and isolation

Normative owner: effective permission, path safety, and enforcement composition. Revision: [NAWABARI-TA-1](index.md).
[Implementation status](implementation-status.md) distinguishes adopted corrections from implemented behavior.

## Inputs and one final decision

Worktree ownership identifies the managed mutation root; it is not permission to read/write every path.
An upstream execution scope supplies a maximum and provenance. A candidate working set supplies semantic need, not permission.
The approved effective working set records what this session may currently see/do within that maximum.
A selected immutable Worktree Runtime Profile supplies runtime/filesystem ceilings. Claims supply coordination and, when
explicitly enabled, an additional authorization requirement. Deny, immutable areas, and isolation invariants remain binding.

Compute one operation-level permission decision from the applicable inputs. Inputs narrow each other; do not union unrelated
authority. Repository, runtime/package material, infrastructure/private Git, temporary state, and auxiliary state are explicit
capability domains, not interchangeable path sets. A required but unavailable input is unknown/denied, not an omitted ceiling.
An intentionally absent optional boundary in an existing supported mode is distinct from a failed authority read.

Validation, policy decision, finite-path compilation, and descriptor-bound physical revalidation are separate stages.
Converge duplicated decisions in `filesystem-policy-decision.ts` and `filesystem-policy.ts` without removing necessary
stage-specific validation or the exact-operation backend's representability checks.
Mounts, runtime projection, and Landlock rules consume this result; they do not mint additional permission.

## Working-set establishment and expansion

Bind external artifacts to matching repository identity and immutable session base revision.
A required candidate outside authorization produces an explicit unsatisfiable outcome; do not silently remove it.
Store the approved effective set, provenance, revision, and expansion history through the repository state boundary.
Expansion is an explicit path/operation request with current working-set CAS and the same governing provenance.
No expansion may enlarge the upstream maximum, selected profile ceiling, or deny boundary.
Candidate files/symbols/tests are evidence of need; Nawabari does not become their semantic dependency analyzer.

Under accepted Q2, claims-off also applies to bounded mutation/expansion: no own claim or claim strength is required solely
for that operation. Claims-on retains canonical own-claim strength requirements. In both modes, ownership, profile,
upstream scope, effective working set, deny/immutable areas, and applicable conflicts remain enforced.
READONLY expansion never grants WRITE, CREATE, or DELETE. A claim does not grant an expansion by itself.
A scope expansion changes future execution preparation; it does not retroactively enlarge an already running sandbox.

## Operation granularity

READONLY reads permitted content; WRITE changes permitted existing content; CREATE and DELETE control namespace mutations.
Do not derive CREATE/DELETE from ordinary WRITE or grant broad parent-directory mutation to approximate one exact operation.
RENAME requires current source and destination identities and the applicable source-removal/destination-creation rules.
Directory/namespace and supported-glob semantics must be explicit and deterministic; unsupported selectors fail closed.
Deny overrides allow, and immutable paths remain non-mutable even when another input includes them.

The exact-operation backend handles supported typed CREATE/DELETE/RENAME requests that ordinary runtime rules cannot
safely represent. Unsupported operations are rejected; documentation does not introduce an implicit replace operation.
A helper's exit success, observed physical effect, current authority, and durable completed receipt are different facts.
Retain durable reservation, current pre-I/O validation, owned-runtime quiescence, and final locked reconciliation.

## Physical enforcement and evidence

bubblewrap owns namespace/mount visibility; Landlock narrows access where required/available by the selected contract.
They consume the same authorized policy. Strict execution is default-deny for unspecified repository/host material and
must not restore broad worktree RW, host PATH/HOME, or a different materializer after a failure.
A path string or earlier lstat does not prove the identity of a later-opened file.
Metadata and bytes used as one authority fact must refer to the same no-follow opened object, with bounded content and
fresh identity checks. Retain traversal, symlink, containment, hardlink-ambiguity, and worktree ownership defenses.

Policy reduction, claim release, handoff, and park fence new admission and prove owned runtime quiescence before final
mutation. A generation change does not revoke an existing Landlock rule in a live process.
Running executions retain their original policy witness; diagnostics must not report them as using a newer policy.

## Auxiliary and private state

Auxiliary state is an explicit, allowlisted repository-local durable copy into the managed worktree.
It cannot shadow tracked content, discover arbitrary ignored files, expose host home, or import sockets/PIDs/process logs.
Its declaration/materialization is distinct from SessionRuntimeProjection and cannot silently change runtime visibility.
Session-private Git configuration and caller-approved hooks are explicit runtime material, not ambient host configuration.
Git evidence still describes the real worktree. Out-of-policy changes are bounded diagnostics, never retroactive approval.

## Required proof

Use one corpus covering path domains, selectors, deny, each operation, claims-on/off, bounded/unbounded sessions, and unknown
inputs. Verify stale expansion CAS, runtime policy witness stability, exact-operation cut points, and no unsafe replay.
Real supported-system tests must prove enforcement, not only the shape of generated mount arguments.

Anchors: [working set](../../src/working-set.ts), [effective policy](../../src/domain/filesystem-policy.ts),
[profile conjunction](../../src/domain/filesystem-policy-decision.ts),
[typed operations](../../src/domain/worktree-file-operation.ts), and
[filesystem design #402](https://github.com/yohn-jp/nawabari/issues/402).
