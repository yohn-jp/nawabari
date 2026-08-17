#!/bin/sh
# Controlled/fake stand-in for bubblewrap, used only by
# src/domain/sandbox-launcher.test.ts. It creates no namespace, mount, or
# other isolation: it forwards the argv that follows the first "--"
# separator straight to exec. Installing it at a fixed, CI-declared path
# lets the launcher's own argv-construction, topology-validation, and
# output/timeout-bounding logic be exercised deterministically regardless
# of whether real bubblewrap happens to be present on the host.
#
# This script is never consulted by production code and must never be
# treated as evidence of real bubblewrap sandbox isolation. The dedicated
# test that proves real isolation (private root/tmp/proc view, dropped
# capabilities, etc.) is gated on genuine bubblewrap discovery and skips
# itself when bubblewrap is unavailable rather than substituting this stub.
set -eu
while [ "$#" -gt 0 ]; do
  arg=$1
  shift
  if [ "$arg" = "--" ]; then
    exec "$@"
  fi
done
echo "sandbox-launcher-test-stub: no -- separator found in argv" >&2
exit 1
