#!/usr/bin/env bash
# Mottainai execution-fixture adapter for Nawabari #150.
#
# This adapter supplies only a preselected unprivileged UID view.  It does not
# interpret task, policy, credential, session, worktree, or Git semantics.
# The caller owns those semantics and passes one concrete command after `--`.
set -eu

uid=""
root=""
cwd=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --uid)
      [ "$#" -ge 2 ] || { echo "--uid requires a value" >&2; exit 2; }
      uid="$2"
      shift 2
      ;;
    --root)
      [ "$#" -ge 2 ] || { echo "--root requires a value" >&2; exit 2; }
      root="$2"
      shift 2
      ;;
    --cwd)
      [ "$#" -ge 2 ] || { echo "--cwd requires a value" >&2; exit 2; }
      cwd="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    *)
      echo "unexpected runner option: $1" >&2
      exit 2
      ;;
  esac
done

case "$uid" in
  ''|*[!0-9]*) echo "UID must be numeric" >&2; exit 2 ;;
esac
[ "$uid" -ge 1000 ] || { echo "UID must be unprivileged" >&2; exit 2; }
[ -n "$root" ] || { echo "--root is required" >&2; exit 2; }
[ -n "$cwd" ] || { echo "--cwd is required" >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "a command is required after --" >&2; exit 2; }

# The outer root is mounted back at its exact path so caller-selected absolute
# repository/worktree paths remain authoritative.  Protected execution itself
# is still established by the packed Nawabari `session run` route.
exec bwrap \
  --die-with-parent \
  --unshare-user \
  --uid "$uid" \
  --gid "$uid" \
  --ro-bind / / \
  --bind "$root" "$root" \
  --dev /dev \
  --proc /proc \
  --chdir "$cwd" \
  -- "$@"
