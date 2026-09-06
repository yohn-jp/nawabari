# Protected execution benchmark

Issue #95 measures the cost of the canonical `session run` route. The
benchmark uses a disposable local Git repository and reports bounded
machine-readable JSON; repository files, user files, session IDs, and absolute
fixture paths are not included in the artifact.

## Reproduce

Build the package and run at least three samples on a Linux host where the
protected doctor report is ready:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run benchmark:protected-execution -- \
  --runs 5 --parallel 4 --output /tmp/nawabari-protected-execution.json
```

`--runs` is bounded to 3–100 and `--parallel` to 2–32. Every child command
has a 60-second timeout. The temporary fixture is removed after the run;
`--keep-temp` is available for local debugging and is never written to the
report.

The benchmark refuses to run unless `nawabari doctor --json` reports the
canonical protected profile as ready and `network_mode: "inherited"`. It does
not retry an unavailable or failed protected launch through an ambient path.

## Measurements

The report separates these dimensions:

- session/worktree provisioning (`session create`)
- first protected launch (`session run`)
- repeated protected launches on one session after one warm-up launch
- concurrent protected launches across independent sessions
- a protected child that exits with status 17
- explicit `session discard` cleanup, including cleanup after failure

Each serial phase has multiple samples. Parallel results include both each
launch and the concurrent batch duration. Summaries contain median, minimum,
maximum, and min–max spread. The report has no performance threshold and does
not define a universal SLA from one runner.

GNU `/usr/bin/time` is used when present to observe wall time, user CPU time,
system CPU time, and maximum resident set size. If it is unavailable, the
report says `wall-only` rather than inventing resource data. Protected results
also record whether the launcher returned cgroup accounting; the ordinary
profile does not request a cgroup scope, so `observed: false` is expected on
that path.

The `control_comparison_only` section runs the same bounded Node operation
directly in the fixture worktree. It is labelled `supported_fallback: false`,
is never selected after protected readiness or launch failure, and does not
alter Nawabari's production execution semantics.

## Architecture evidence

The report records the exact source commit, package/runtime identity, doctor
contract and capability state, and the observed `session run` route. The
fixture does not pull/build an OCI image, start a container daemon, create a
VM, or manage a package store per session. This is evidence for the measured
process/namespace-scale path; it is not a claim of a universal SLA or a
replacement for security and compatibility conformance.
