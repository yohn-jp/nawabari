import assert from "node:assert/strict";
import test from "node:test";

import { deriveCgroupScopeName } from "./cgroups-v2.js";
import { DomainError, failure, success } from "./errors.js";
import {
  enterSessionConsole,
  launchManagedSessionCommand,
  listSessionProcesses,
  sessionConsolePrompt,
  type SessionConsoleRunner,
} from "./session-console.js";
import type { SessionBackend, SessionContext, SessionRecord } from "./session.js";
import { recordExecutionState, reserveExecution, type SessionExecutionRecord } from "./session-execution-record.js";
import type { SessionRuntimeProjection } from "./runtime-projection.js";

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

const context: SessionContext = { cwd: session.worktree };

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

function projection(options: { readonly bashVersion?: string } = {}): SessionRuntimeProjection {
  return {
    contract_id: "nawabari.session-runtime-projection.v1",
    schema_version: 1,
    policy: {
      mode: "strict",
      host_visibility: "default-deny",
      compatibility: "disabled",
      unrestricted_host_fallback: "forbidden",
    },
    profile: { id: "console-profile", version: "7" },
    requirements: [{ id: "bash-runtime", kind: "runtime", name: "bash", version: options.bashVersion ?? ">=5" }],
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
}

function readyProbe() {
  return {
    platform: () => "linux",
    uid: () => 1000,
    gid: () => 1000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => true,
    hasLandlock: () => false,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
  };
}

function executionRecord(state: "starting" | "attached" | "unresolved" = "starting"): SessionExecutionRecord {
  const reserved = reserveExecution({
    session_id: session.session_id,
    execution_id: "execution-console-1",
    profile_digest: "a".repeat(64),
    filesystem_token: "filesystem-console-1",
    runtime_epoch: 7,
    boot_id: "boot-console-1",
    now: "2026-09-21T00:00:00.000Z",
  });
  if (!reserved.ok) throw reserved.error;
  if (state === "starting") return reserved.value;
  const attached = recordExecutionState(reserved.value, {
    state: "attached",
    supervisor: { pid: 4123, starttime: "9001" },
    now: "2026-09-21T00:00:01.000Z",
  });
  if (!attached.ok) throw attached.error;
  if (state === "unresolved") {
    const unresolved = recordExecutionState(attached.value, {
      state: "unresolved",
      now: "2026-09-21T00:00:02.000Z",
    });
    if (!unresolved.ok) throw unresolved.error;
    return unresolved.value;
  }
  return attached.value;
}

test("prompt contains only the selected session and effective revision", () => {
  assert.equal(sessionConsolePrompt(session.session_id, 7), `nawabari[${session.session_id}@7]$ `);
  assert.equal(sessionConsolePrompt(session.session_id, "profile-7").includes("agent"), false);
});

test("enter reserves execution before protected interactive launch and keeps session open", async () => {
  const persisted: SessionExecutionRecord[] = [];
  const launched: { requestSession: string; command: string; args: readonly string[]; interactive: boolean }[] = [];
  const runner: SessionConsoleRunner = async (request, command, options) => {
    launched.push({
      requestSession: request.session_id,
      command: command.command,
      args: command.args ?? [],
      interactive: options.interactive === true,
    });
    return success({ exit_code: 0, signal: null, stdout: "", stderr: "", duration_ms: 2 });
  };
  const result = await enterSessionConsole(context, backend(), {
    session_id: session.session_id,
    runtime_projection: projection(),
    sandbox_probe: readyProbe(),
    execution_id: "execution-console-1",
    boot_id: "boot-console-1",
    runtime_epoch: 7,
    now: () => "2026-09-21T00:00:01.000Z",
    sandbox_runner: runner,
    persist_execution: async (record) => {
      persisted.push(record as SessionExecutionRecord);
    },
  });

  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(launched, [
    {
      requestSession: session.session_id,
      command: "/nawabari/bin/bash",
      args: ["--noprofile", "--norc"],
      interactive: true,
    },
  ]);
  assert.deepEqual(
    persisted.map((record) => record.state),
    ["starting", "exited"],
  );
  assert.equal(result.value.cwd, session.worktree);
  assert.equal(result.value.execution.state, "exited");
  assert.equal(result.value.session_closed, false);
  assert.equal(result.value.prompt, `nawabari[${session.session_id}@7]$ `);
});

test("entry fails closed before launch when the execution writer is absent", async () => {
  let launches = 0;
  const result = await enterSessionConsole(context, backend(), {
    session_id: session.session_id,
    runtime_projection: projection(),
    sandbox_probe: readyProbe(),
    sandbox_runner: async () => {
      launches += 1;
      return failure(new DomainError("SANDBOX_EXECUTION_FAILED", "unexpected"));
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "REGISTRY_DURABILITY_UNCERTAIN");
  assert.equal(launches, 0);
});

test("entry rejects a non-canonical Bash requirement version before launch", async () => {
  let launches = 0;
  const result = await enterSessionConsole(context, backend(), {
    session_id: session.session_id,
    runtime_projection: projection({ bashVersion: "4" }),
    sandbox_probe: readyProbe(),
    sandbox_runner: async () => {
      launches += 1;
      return success({ exit_code: 0, signal: null, stdout: "", stderr: "", duration_ms: 1 });
    },
    persist_execution: async () => undefined,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
  assert.equal(launches, 0);
});

test("process inspection proves boot, PID generation, and cgroup identity", async () => {
  const record = executionRecord("attached");
  const result = await listSessionProcesses(context, backend(), {
    session_id: session.session_id,
    read_executions: () => [record],
    identity_reader: {
      read_boot_id: () => record.boot_id,
      read_process_starttime: () => record.supervisor_starttime ?? "0",
      read_process_cgroup: () => "/nawabari/foreign-scope",
    },
    observe_owned_execution: () =>
      success({
        contract_id: "nawabari.session-process-observation.v1" as const,
        session_id: record.session_id,
        execution_id: record.execution_id,
        boot_id: record.boot_id,
        state: "active" as const,
        cgroups: null,
      }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.processes.length, 1);
  assert.equal(result.value.processes[0]?.observation.classification, "different-cgroup");

  const matched = await listSessionProcesses(context, backend(), {
    session_id: session.session_id,
    read_executions: () => [record],
    identity_reader: {
      read_boot_id: () => record.boot_id,
      read_process_starttime: () => record.supervisor_starttime ?? "0",
      read_process_cgroup: () => `/nawabari/${deriveCgroupScopeName(record.cgroup_identity)}`,
    },
    observe_owned_execution: () =>
      success({
        contract_id: "nawabari.session-process-observation.v1" as const,
        session_id: record.session_id,
        execution_id: record.execution_id,
        boot_id: record.boot_id,
        state: "active" as const,
        cgroups: null,
      }),
  });
  assert.equal(matched.ok, true);
  if (matched.ok) assert.equal(matched.value.processes[0]?.observation.matches, true);
});

test("process inspection retains cgroup observation for unresolved executions", async () => {
  const record = executionRecord("unresolved");
  const observedRecords: Parameters<
    NonNullable<Parameters<typeof listSessionProcesses>[2]["observe_owned_execution"]>
  >[0][] = [];
  const result = await listSessionProcesses(context, backend(), {
    session_id: session.session_id,
    read_executions: () => [record],
    identity_reader: {
      read_boot_id: () => record.boot_id,
      read_process_starttime: () => record.supervisor_starttime ?? "0",
      read_process_cgroup: () => `/nawabari/${deriveCgroupScopeName(record.cgroup_identity)}`,
    },
    observe_owned_execution: (ownedRecord) => {
      observedRecords.push(ownedRecord);
      return success({
        contract_id: "nawabari.session-process-observation.v1" as const,
        session_id: record.session_id,
        execution_id: record.execution_id,
        boot_id: record.boot_id,
        state: "empty" as const,
        cgroups: null,
      });
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(observedRecords.length, 1);
  assert.equal(observedRecords[0]?.cgroups?.identity.execution_id, record.execution_id);
  assert.equal(result.value.processes[0]?.cgroups?.state, "empty");
});

test("managed command path fails closed before launch when cgroups are unavailable", async () => {
  let persisted = 0;
  const managedBackend = {
    getSessionManagedRuntime: async (_context: SessionContext, sessionId: string, executionId?: string) =>
      success({
        runtime_epoch: 7,
        registry_revision: 11,
        claim_set_generation: 3,
        admission: {
          kind: "session-admission" as const,
          schema_version: 1 as const,
          session_id: sessionId,
          admission: "open" as const,
          runtime_epoch: 7,
        },
        profile: { digest: "a".repeat(64) },
        runtime_environment_identity: {
          session_id: sessionId,
          execution_id: executionId ?? "unused",
          session_root: "/private/session-home",
          execution_root: "/private/execution",
          owner_uid: 1000,
          owner_gid: 1000,
        },
      }),
    listClaims: async () => success({ claims: [], claim_set_generation: 3 }),
    persistSessionExecution: async () => {
      persisted += 1;
      return failure(new DomainError("REGISTRY_DURABILITY_UNCERTAIN", "unexpected persistence"));
    },
    readSessionRuntimeEpoch: () => 7,
  } as unknown as SessionBackend;

  const result = await launchManagedSessionCommand(context, managedBackend, {
    session_id: session.session_id,
    command: { command: "/nawabari/bin/node", args: ["-e", "process.exit(0)"] },
    sandbox_probe: { hasCgroupsV2: () => false } as unknown as import("./sandbox.js").SandboxProbe,
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  assert.equal(persisted, 0);
});

test("managed interactive entry fails closed when the protected producer cannot preserve terminal input", async () => {
  let runnerCalls = 0;
  const managedBackend = {
    ...backend(),
    getSessionManagedRuntime: async () =>
      success({
        runtime_epoch: 7,
        registry_revision: 11,
        claim_set_generation: 3,
        admission: {
          kind: "session-admission" as const,
          schema_version: 1 as const,
          session_id: session.session_id,
          admission: "open" as const,
          runtime_epoch: 7,
        },
        profile: { digest: "a".repeat(64) },
      }),
  } as unknown as SessionBackend;

  const result = await enterSessionConsole(context, managedBackend, {
    session_id: session.session_id,
    persist_execution: async () => undefined,
    sandbox_runner: async () => {
      runnerCalls += 1;
      return success({ exit_code: 0, signal: null, stdout: "", stderr: "", duration_ms: 1 });
    },
  });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  assert.equal(runnerCalls, 0);
});
