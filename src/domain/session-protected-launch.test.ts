import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { success } from "./errors.js";
import {
  compileSessionEnvironment,
  materializeSessionRuntimeDirectories,
  type CompiledSessionEnvironment,
} from "./session-environment.js";
import { reserveExecution, type SessionExecutionRecord } from "./session-execution-record.js";
import {
  launchProtectedSessionExecution,
  type SessionProtectedLaunchDependencies,
  type SessionProtectedLaunchInput,
} from "./session-protected-launch.js";
import { compileSandboxSeccompProfile, sandboxSeccompProfileMetadata } from "./sandbox.js";
import type { SandboxExecutionRequest } from "./sandbox.js";
import type { SandboxInvocation } from "./sandbox-launcher.js";
import { validateWorktreeRuntimeProfile, type ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

function profileInput(): Record<string, unknown> {
  return {
    id: "standard-shell",
    version: "1",
    materialSelection: { profiles: ["base"], operations: [] },
    filesystem: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["tmp/**"],
      delete: ["tmp/**"],
      deny: [".git/**"],
      immutable: [".git/**"],
    },
    tools: [{ entrypoint: "bash", provider: { id: "fhs", requirement_id: "bash-runtime" } }],
    shell: { entrypoint: "bash" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "session", data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
    execution: {
      policy: {
        mode: "strict",
        host_visibility: "default-deny",
        compatibility: "disabled",
        unrestricted_host_fallback: "forbidden",
      },
      processTracking: "required",
    },
  };
}

function makeInput(root: string): {
  readonly input: SessionProtectedLaunchInput;
  readonly profile: ResolvedWorktreeRuntimeProfile;
  readonly environment: CompiledSessionEnvironment;
  readonly record: SessionExecutionRecord;
} {
  const profileResult = compileSessionEnvironment(profileInput(), {
    session_id: "session-1",
    execution_id: "execution-1",
    session_root: path.join(root, "session"),
    execution_root: path.join(root, "execution"),
    owner_uid: typeof process.getuid === "function" ? process.getuid() : 0,
    owner_gid: typeof process.getgid === "function" ? process.getgid() : 0,
  });
  assert.equal(profileResult.ok, true);
  if (profileResult.ok !== true) throw new Error("invalid profile environment fixture");

  const validatedProfile = validateWorktreeRuntimeProfile(profileInput());
  assert.equal(validatedProfile.ok, true);
  if (validatedProfile.ok !== true) throw new Error("invalid profile fixture");
  const profile: ResolvedWorktreeRuntimeProfile = validatedProfile.value;
  const recordResult = reserveExecution({
    session_id: "session-1",
    execution_id: "execution-1",
    profile_digest: "upper-profile-digest",
    filesystem_token: "filesystem-token",
    runtime_epoch: 19,
    boot_id: "boot-1",
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(recordResult.ok, true);
  if (recordResult.ok !== true) throw new Error("invalid execution fixture");

  const request = {
    session_id: "session-1",
    cgroups: { required: true, execution_id: "execution-1" },
  } as unknown as SandboxExecutionRequest;
  const input = {
    profile,
    compiled_environment: profileResult.value,
    request,
    command: { command: "bash", args: ["-lc", "printf protected"] },
    admission: {
      session_id: "session-1",
      execution_id: "execution-1",
      current: {
        lifecycle: "active" as const,
        launch_permitted: true,
        profile_token: "profile-token",
        profile_revision: 1,
        filesystem_token: "filesystem-token",
        filesystem_revision: 1,
        generation: 1,
        epoch: 19,
      },
      expected: {
        lifecycle: "active" as const,
        launch_permitted: true,
        profile_token: "profile-token",
        profile_revision: 1,
        filesystem_token: "filesystem-token",
        filesystem_revision: 1,
        generation: 1,
        epoch: 19,
      },
    },
    starting_record: recordResult.value,
    supervisor: {
      trusted: { entrypoint: "/opt/nawabari-supervisor/index.js", cwd: "/opt/nawabari-supervisor" },
    },
  } satisfies SessionProtectedLaunchInput;
  return { input, profile, environment: profileResult.value, record: recordResult.value };
}

function invocation(): SandboxInvocation {
  const seccomp = compileSandboxSeccompProfile("x64");
  assert.equal(seccomp.ok, true);
  if (seccomp.ok !== true) throw new Error("invalid seccomp fixture");
  return {
    executable: "/usr/bin/bwrap",
    args: ["--clearenv", "--", "bash", "-lc", "printf protected"],
    cwd: "/tmp/worktree",
    env: { PATH: "/nawabari/bin", HOME: "/home/nawabari", TMPDIR: "/tmp" },
    seccomp_profile: seccomp.value,
    seccomp_profile_metadata: sandboxSeccompProfileMetadata(),
    landlock: { abi: null, state: "reduced-defense", rule_count: 0 },
  };
}

function dependencies(
  events: string[],
  records: SessionExecutionRecord[],
  expectedStdio: NonNullable<SessionProtectedLaunchInput["stdio"]> = ["ignore", "pipe", "pipe"],
): SessionProtectedLaunchDependencies {
  return {
    materializeSessionRuntimeDirectories: (manifest) => {
      events.push("materialize");
      return materializeSessionRuntimeDirectories(manifest);
    },
    compileSandboxInvocation: () => {
      events.push("compile");
      return success(invocation());
    },
    runSessionLaunchSupervisor: async (packet) => {
      events.push("supervisor");
      assert.deepEqual(packet.payload.stdio.slice(0, 3), expectedStdio);
      assert.equal(packet.payload.stdio[3], packet.payload.seccomp_fd);
      await packet.durability?.mark_attached?.({
        contract_id: "nawabari.session-launch-supervisor.v1",
        session_id: "session-1",
        execution_id: "execution-1",
        supervisor_pid: 4242,
        cgroup_scope: null,
        epoch: 19,
      });
      await packet.durability?.record_release_attempt?.({
        contract_id: "nawabari.session-launch-supervisor.v1",
        session_id: "session-1",
        execution_id: "execution-1",
        supervisor_pid: 4242,
        cgroup_scope: null,
        epoch: 19,
        operation: "release-attempt",
      });
      assert.equal(await packet.durability?.revalidate_epoch?.(), true);
      return success({
        contract_id: "nawabari.session-launch-supervisor.v1",
        schema_version: 1,
        status: "completed" as const,
        started: true,
        retryable: false,
        result: { exit_code: 0, signal: null, stdout: "protected", stderr: "", duration_ms: 1 },
        session_id: "session-1",
        execution_id: "execution-1",
        epoch: 19,
        supervisor_pid: 4242,
        cgroup_scope: null,
      });
    },
    persist_execution: async (record) => {
      events.push(record.state);
      records.push(record as SessionExecutionRecord);
    },
    read_process_starttime: (pid) => {
      assert.equal(pid, 4242);
      return "9001";
    },
    read_runtime_epoch: () => 19,
  };
}

test("protected launch persists every gate in order and records actual worker ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-launch-"));
  try {
    const { input } = makeInput(root);
    const events: string[] = [];
    const records: SessionExecutionRecord[] = [];
    const result = await launchProtectedSessionExecution(input, dependencies(events, records));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.supervisor.status, "completed");
    assert.equal(result.value.execution.state, "exited");
    assert.equal(result.value.result?.stdout, "protected");
    assert.deepEqual(events, ["starting", "materialize", "compile", "supervisor", "attached", "attached", "exited"]);
    assert.equal(records[1]?.supervisor_starttime, "9001");
    assert.equal(records[2]?.release_attempt?.outcome, "unresolved");
    assert.match(records[2]?.release_attempt?.reason ?? "", /pre-GO/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected launch propagates caller-selected interactive stdio", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-launch-"));
  try {
    const { input: baseInput } = makeInput(root);
    const stdio = ["inherit", "inherit", "inherit"] as const;
    const input = { ...baseInput, stdio } satisfies SessionProtectedLaunchInput;
    const result = await launchProtectedSessionExecution(input, dependencies([], [], stdio));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (result.ok) assert.equal(result.value.supervisor.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid protected stdio topology fails before starting durability or materialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-launch-"));
  try {
    const { input } = makeInput(root);
    const invalid = { ...input, stdio: ["inherit", "invalid", "pipe"] } as unknown as SessionProtectedLaunchInput;
    const events: string[] = [];
    const result = await launchProtectedSessionExecution(invalid, dependencies(events, []));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("admission denial returns the existing no-start shape before materialization or persistence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-launch-"));
  try {
    const { input } = makeInput(root);
    const denied = {
      ...input,
      admission: { ...input.admission, current: { ...input.admission.current, launch_permitted: false } },
    } satisfies SessionProtectedLaunchInput;
    let calls = 0;
    const deps = dependencies([], []);
    const result = await launchProtectedSessionExecution(denied, {
      ...deps,
      materializeSessionRuntimeDirectories: () => {
        calls += 1;
        throw new Error("must not materialize");
      },
      persist_execution: async () => {
        calls += 1;
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.supervisor.status, "not-started");
    assert.equal(result.value.supervisor.reason, "admission-denied");
    assert.equal(result.value.execution.state, "starting");
    assert.equal(calls, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("starting durability failure suppresses materialization", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-launch-"));
  try {
    const { input } = makeInput(root);
    let materialized = false;
    const deps = dependencies([], []);
    const result = await launchProtectedSessionExecution(input, {
      ...deps,
      persist_execution: async () => {
        throw new Error("durability unavailable");
      },
      materializeSessionRuntimeDirectories: (manifest) => {
        materialized = true;
        return materializeSessionRuntimeDirectories(manifest);
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "REGISTRY_DURABILITY_UNCERTAIN");
    assert.equal(materialized, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
