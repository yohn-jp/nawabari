# GitPaw

GitPaw is the local command-line boundary for Git development-session state.
The executable is named `git-paw`, so Git discovers it as the `git paw`
external subcommand. GitPaw does not replace Git, orchestrate tasks, or call
GitHub.

## Install

```bash
npm install -g git-paw
```

## Usage

```bash
git paw --help
```

## CLI contract

All commands accept `--json`. JSON mode writes exactly one JSON document to
stdout and never writes human-readable decoration there. Successful responses
use this envelope:

```json
{
  "ok": true,
  "command": "session show",
  "session_id": "...",
  "state": "active"
}
```

Rejected responses use the same command name and a stable top-level `code`:

```json
{
  "ok": false,
  "command": "session id",
  "code": "BACKEND_UNAVAILABLE",
  "message": "...",
  "details": {}
}
```

Exit codes are stable: `0` is success, `2` is usage error, `3` is a domain
rejection, `4` means the requested backend capability is unavailable, `5`
means `doctor` found a local failure, and `70` is an unexpected internal
failure.

The initial command surface is:

```text
git paw session create [--branch <name>] [--worktree <path>] [--label <text>]
git paw session id
git paw session show [--session <id>]
git paw session list
git paw session close [--session <id>]
git paw status
git paw gc [--dry-run|--apply]
git paw doctor
```

`session id`, `session show`, and `session close` resolve the current session
from the command's working directory when `--session` is omitted. The CLI
does not prompt. The session registry, provisioning, lifecycle, and garbage
collection implementations are supplied through the `SessionBackend` domain
boundary. They are not present on the current `main` baseline, so those
commands return `BACKEND_UNAVAILABLE` rather than claiming a false success;
later backend work can be connected without changing the CLI contract.

`doctor` is implemented locally. It checks the Node.js runtime, Git
availability, repository/common-directory resolution, and the conventional
repository-scoped registry path `.git/gitpaw/registry.json` when present. A
missing registry is reported as `not_configured`, not as a successful session
state. `doctor` never requires GitHub, `gh`, a network, Mottainai, or a
particular agent runtime.

Human output and JSON output are two presentations of the same domain result;
JSON is the automation interface. GitPaw only governs operations routed
through its backend and cannot prevent a process with filesystem permission
from editing another worktree directly.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
