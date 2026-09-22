import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compileSessionEnvironment, materializeSessionRuntimeDirectories } from "./session-environment.js";
import { reserveExecution, type SessionExecutionRecord } from "./session-execution-record.js";
import { launchProtectedSessionExecution } from "./session-protected-launch.js";
import { compileSandboxInvocation } from "./sandbox-launcher.js";
import type { SandboxExecutionRequest } from "./sandbox.js";
import {
  SANDBOX_CONTRACT_ID,
  SANDBOX_CONTRACT_SCHEMA_VERSION,
  sandboxCapabilityBaseline,
  sandboxSeccompProfileMetadata,
} from "./sandbox.js";
import { STRICT_RUNTIME_POLICY, validateSessionRuntimeProjection } from "./runtime-projection.js";
import { validateWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";

function profileInput(): Record<string, unknown> {
  return {
    id: "integration-shell",
    version: "1",
    materialSelection: { profiles: ["base"], operations: [] },
    filesystem: { readOnly: [], write: [], create: [], delete: [], deny: [], immutable: [] },
    tools: [{ entrypoint: "node", provider: { id: "runtime", requirement_id: "node-runtime" } }],
    shell: { entrypoint: "node" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "session", data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
    execution: {
      policy: STRICT_RUNTIME_POLICY,
      processTracking: "required",
    },
  };
}

test("the protected compiler consumes the materialized environment and one canonical descriptor path", (t) => {
  const bwrap = "/run/current-system/sw/bin/bwrap";
  if (process.platform !== "linux" || !fs.existsSync(bwrap)) {
    t.skip("supported bubblewrap runtime is unavailable");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-integration-"));
  const repository = path.join(root, "repository");
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repository, ".git", "objects"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repository, ".git", "refs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  try {
    const upper = validateWorktreeRuntimeProfile(profileInput());
    assert.equal(upper.ok, true);
    if (!upper.ok) return;
    const compiled = compileSessionEnvironment(profileInput(), {
      session_id: "integration-session",
      execution_id: "integration-execution",
      session_root: path.join(root, "session"),
      execution_root: path.join(root, "execution"),
      owner_uid: typeof process.getuid === "function" ? process.getuid() : 0,
      owner_gid: typeof process.getgid === "function" ? process.getgid() : 0,
      term: "xterm-256color",
    });
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    const materialized = materializeSessionRuntimeDirectories(compiled.value.manifest);
    assert.equal(materialized.ok, true);
    if (!materialized.ok) return;

    const node = fs.realpathSync.native(process.execPath);
    const projection = validateSessionRuntimeProjection({
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "integration-material", version: "1" },
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
      filesystem: [
        {
          source: path.dirname(node),
          target: "/runtime/node",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
      ],
      executables: [
        {
          name: "node",
          target: "/runtime/node/node",
          provider: { id: "runtime", requirement_id: "node-runtime" },
          provenance: "runtime-profile",
        },
      ],
    });
    assert.equal(projection.ok, true);
    if (!projection.ok) return;

    const request = {
      schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
      contract_id: SANDBOX_CONTRACT_ID,
      enforce: true,
      session_id: "integration-session",
      repository,
      worktree: repository,
      branch: "main",
      network_mode: "inherited",
      sandbox_executable: bwrap,
      identity: { real_uid: null, real_gid: null, namespace_uid: 0, namespace_gid: 0 },
      git_identity: { host_global_name: null, host_global_email: null },
      filesystem: {
        owned_worktree: repository,
        home: path.join(repository, "legacy-home"),
        cache: path.join(repository, "legacy-cache"),
        persistent_home: path.join(repository, "persistent-home"),
        git_metadata: path.join(repository, "git-metadata"),
        git_objects: path.join(repository, ".git", "objects"),
        user_tool_paths: [],
        runtime_paths: [],
        system_paths: [],
      },
      required_capabilities: [],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_abi: null,
      landlock_state: "reduced-defense" as const,
      landlock_required: false,
      runtime_projection: projection.value,
      compiled_session_environment: compiled.value,
    } as SandboxExecutionRequest;

    const invocation = compileSandboxInvocation(request, { command: "node", args: ["--version"] });
    assert.equal(invocation.ok, true, invocation.ok ? "" : invocation.error.message);
    if (!invocation.ok) return;
    const args = invocation.value.args;
    assert.ok(args.includes("--setenv"));
    assert.ok(args.includes("XDG_STATE_HOME"));
    assert.ok(args.includes("/home/nawabari/.local/state"));
    assert.ok(args.includes("--bind"));
    assert.ok(args.includes(compiled.value.manifest.execution.tmp.path));
    assert.ok(args.includes("/tmp"));
    assert.ok(args.includes("--ro-bind"));
    assert.equal(args.includes("--tmpfs") && args[args.indexOf("--tmpfs") + 1] === "/tmp", false);
    assert.equal(invocation.value.env.SHELL, "/nawabari/bin/node");
    assert.equal(invocation.value.env.TERM, "xterm-256color");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the protected composition reaches the repaired worker on a supported runtime", async (t) => {
  const bwrap = "/run/current-system/sw/bin/bwrap";
  if (process.platform !== "linux" || !fs.existsSync(bwrap)) {
    t.skip("supported bubblewrap runtime is unavailable");
    return;
  }
  const workerArtifact = fileURLToPath(new URL("./session-launch-supervisor-worker.js", import.meta.url));
  if (!fs.existsSync(workerArtifact)) {
    t.skip("compiled trusted supervisor worker artifact is unavailable in the source test run");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-protected-worker-"));
  const repository = path.join(root, "repository");
  fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repository, ".git", "objects"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(repository, ".git", "refs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  try {
    const profile = profileInput();
    const upper = validateWorktreeRuntimeProfile(profile);
    assert.equal(upper.ok, true);
    if (!upper.ok) return;
    const compiled = compileSessionEnvironment(profile, {
      session_id: "worker-session",
      execution_id: "worker-execution",
      session_root: path.join(root, "session"),
      execution_root: path.join(root, "execution"),
      owner_uid: typeof process.getuid === "function" ? process.getuid() : 0,
      owner_gid: typeof process.getgid === "function" ? process.getgid() : 0,
    });
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    const materialized = materializeSessionRuntimeDirectories(compiled.value.manifest);
    assert.equal(materialized.ok, true);
    if (!materialized.ok) return;

    const node = fs.realpathSync.native(process.execPath);
    const projection = validateSessionRuntimeProjection({
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "integration-material", version: "1" },
      requirements: [{ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" }],
      filesystem: [
        {
          source: "/nix/store",
          target: "/nix/store",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
        {
          source: path.dirname(node),
          target: "/runtime/node",
          access_mode: "read-only",
          provenance: "runtime-profile",
        },
      ],
      executables: [
        {
          name: "node",
          target: "/runtime/node/node",
          provider: { id: "runtime", requirement_id: "node-runtime" },
          provenance: "runtime-profile",
        },
      ],
    });
    assert.equal(projection.ok, true);
    if (!projection.ok) return;
    const request = {
      schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
      contract_id: SANDBOX_CONTRACT_ID,
      enforce: true,
      session_id: "worker-session",
      repository,
      worktree: repository,
      branch: "main",
      network_mode: "inherited",
      sandbox_executable: bwrap,
      identity: { real_uid: null, real_gid: null, namespace_uid: 0, namespace_gid: 0 },
      git_identity: { host_global_name: null, host_global_email: null },
      filesystem: {
        owned_worktree: repository,
        home: path.join(repository, "legacy-home"),
        cache: path.join(repository, "legacy-cache"),
        persistent_home: path.join(repository, "persistent-home"),
        git_metadata: path.join(repository, "git-metadata"),
        git_objects: path.join(repository, ".git", "objects"),
        user_tool_paths: [],
        runtime_paths: [],
        system_paths: [],
      },
      required_capabilities: [],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_abi: null,
      landlock_state: "reduced-defense" as const,
      landlock_required: false,
      runtime_projection: projection.value,
    } as SandboxExecutionRequest;
    const reservation = reserveExecution({
      session_id: "worker-session",
      execution_id: "worker-execution",
      profile_digest: "worker-profile",
      filesystem_token: "worker-filesystem",
      runtime_epoch: 19,
      boot_id: "worker-boot",
      now: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(reservation.ok, true);
    if (!reservation.ok) return;
    const records: SessionExecutionRecord[] = [];
    const result = await launchProtectedSessionExecution(
      {
        profile: upper.value,
        compiled_environment: compiled.value,
        request: { ...request, cgroups: { required: true, execution_id: "worker-execution" } },
        command: { command: "node", args: ["-e", "process.stdout.write('worker-ok')"] },
        admission: {
          session_id: "worker-session",
          execution_id: "worker-execution",
          current: {
            lifecycle: "active",
            launch_permitted: true,
            profile_token: "worker-profile",
            profile_revision: 1,
            filesystem_token: "worker-filesystem",
            filesystem_revision: 1,
            generation: 1,
            epoch: 19,
          },
          expected: {
            lifecycle: "active",
            launch_permitted: true,
            profile_token: "worker-profile",
            profile_revision: 1,
            filesystem_token: "worker-filesystem",
            filesystem_revision: 1,
            generation: 1,
            epoch: 19,
          },
        },
        starting_record: reservation.value,
        supervisor: {
          trusted: { entrypoint: process.execPath, cwd: path.dirname(process.execPath) },
          result_timeout_ms: 30_000,
        },
      },
      {
        materializeSessionRuntimeDirectories,
        compileSandboxInvocation,
        runSessionLaunchSupervisor: (packet) =>
          import("./session-launch-supervisor.js").then(({ runSessionLaunchSupervisor }) =>
            runSessionLaunchSupervisor(packet),
          ),
        persist_execution: async (record) => {
          records.push(record as SessionExecutionRecord);
        },
        read_process_starttime: (pid) => {
          const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          const fields = raw
            .slice(raw.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/u);
          const starttime = fields[19];
          if (starttime === undefined) throw new Error(`worker starttime unavailable for ${pid}: ${raw.slice(0, 160)}`);
          return starttime;
        },
        read_runtime_epoch: () => 19,
      },
    );
    if (
      !result.ok &&
      (result.error.code === "SANDBOX_CAPABILITY_UNAVAILABLE" || result.error.code === "SANDBOX_UNSUPPORTED_PLATFORM")
    ) {
      t.skip(`platform evidence unavailable: ${result.error.code}`);
      return;
    }
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(result.value.supervisor.status, "completed");
    assert.equal(result.value.result?.stdout, "worker-ok");
    assert.equal(result.value.execution.state, "exited");
    assert.deepEqual(
      records.map((record) => record.state),
      ["starting", "attached", "attached", "exited"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
