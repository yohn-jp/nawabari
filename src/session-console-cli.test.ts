import assert from "node:assert/strict";
import test from "node:test";

import { success } from "./domain/errors.js";
import { parseSessionConsoleCommand, executeSessionConsoleCommand } from "./session-console-cli.js";
import type { SessionBackend, SessionContext, SessionRecord } from "./domain/session.js";
import type { SessionRuntimeProjection } from "./domain/runtime-projection.js";

const session: SessionRecord = {
  schema_version: 1,
  session_id: "0190f1e0-0000-7000-8000-000000000454",
  repository: "/tmp/nawabari-repository",
  worktree: "/tmp/nawabari-worktree",
  branch: "feat/session-console",
  state: "active",
  created_at: "2026-09-21T00:00:00.000Z",
  updated_at: "2026-09-21T00:00:00.000Z",
};

const projection: SessionRuntimeProjection = {
  contract_id: "nawabari.session-runtime-projection.v1",
  schema_version: 1,
  policy: {
    mode: "strict",
    host_visibility: "default-deny",
    compatibility: "disabled",
    unrestricted_host_fallback: "forbidden",
  },
  profile: { id: "console-profile", version: "7" },
  requirements: [{ id: "bash-runtime", kind: "runtime", name: "bash", version: ">=5" }],
  filesystem: [
    {
      source: "/nix/store/pinned-bash",
      target: "/runtime/bash",
      access_mode: "read-only",
      provenance: "runtime-profile",
    },
  ],
  executables: [
    {
      name: "bash",
      target: "/runtime/bash/bin/bash",
      provider: { id: "nix-bash-runtime-provider", requirement_id: "bash-runtime" },
      provenance: "runtime-profile",
    },
  ],
};

function backend(): SessionBackend {
  return {
    getSession: async () => success(session),
    guard: async () =>
      success({
        allowed: true,
        code: "ALLOWED" as const,
        repository: session.repository,
        worktree: session.worktree,
        branch: session.branch,
        session_id: session.session_id,
        owner_session_id: session.session_id,
        requested_session_id: session.session_id,
        state: "active" as const,
        details: {},
      }),
  } as unknown as SessionBackend;
}

test("session-console parser requires an explicit session and preserves policy", () => {
  const parsed = parseSessionConsoleCommand([
    "session",
    "enter",
    "--session",
    session.session_id,
    "--runtime-policy",
    "strict",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.command, "session enter");
    assert.equal(parsed.value.session_id, session.session_id);
    assert.equal(parsed.value.runtime_policy?.mode, "strict");
  }
  const missing = parseSessionConsoleCommand(["session", "processes"]);
  assert.equal(missing.ok, false);
  const unsupported = parseSessionConsoleCommand(["session", "processes", "--runtime-policy", "strict"]);
  assert.equal(unsupported.ok, false);
});

test("session-console CLI delegates enter to the protected domain surface", async () => {
  const persisted: string[] = [];
  let interactive = false;
  const result = await executeSessionConsoleCommand(
    { cwd: session.worktree } satisfies SessionContext,
    ["session", "enter", "--session", session.session_id],
    {
      backend: backend(),
      runtime_projection: projection,
      sandbox_probe: {
        platform: () => "linux",
        uid: () => 1000,
        gid: () => 1000,
        hasBubblewrap: () => true,
        hasNamespaceSupport: () => true,
        hasCgroupsV2: () => true,
        hasLandlock: () => false,
        hasSeccomp: () => true,
        hasCapabilities: () => true,
      },
      sandbox_runner: async (_request, _command, options) => {
        interactive = options.interactive === true;
        return success({ exit_code: 0, signal: null, stdout: "", stderr: "", duration_ms: 1 });
      },
      persist_execution: async (record) => {
        persisted.push(record.state);
      },
    },
  );
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(interactive, true);
  assert.deepEqual(persisted, ["starting", "exited"]);
});
