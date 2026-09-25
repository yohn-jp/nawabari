import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createCgroupScope, readCgroupPopulation, type CgroupFileSystem } from "./cgroups-v2.js";
import { DomainError, failure, success } from "./errors.js";
import { decideExecutionAdmission, type ExecutionAdmissionReservation } from "./session-admission-decision.js";
import {
  runSessionLaunchSupervisor,
  serializeTrustedSupervisorGoMessage,
  type SessionLaunchSupervisorPacket,
  type TrustedSupervisorProcess,
} from "./session-launch-supervisor.js";

const baseFacts = {
  session_id: "session-1",
  execution_id: "execution-1",
  current: {
    lifecycle: "active" as const,
    launch_permitted: true,
    profile_token: "profile-token",
    profile_revision: 3,
    filesystem_token: "filesystem-token",
    filesystem_revision: 7,
    generation: 11,
    epoch: 19,
  },
  expected: {
    lifecycle: "active" as const,
    launch_permitted: true,
    profile_token: "profile-token",
    profile_revision: 3,
    filesystem_token: "filesystem-token",
    filesystem_revision: 7,
    generation: 11,
    epoch: 19,
  },
};

const admitted = decideExecutionAdmission(baseFacts);
assert.equal(admitted.ok, true);
if (!admitted.ok || !admitted.value.admitted) throw new Error("test admission fixture is invalid");
const reservation: ExecutionAdmissionReservation = admitted.value.reservation;

const payload = {
  executable: "/usr/bin/bwrap",
  args: ["--die-with-parent", "--", "node", "script.js"],
  cwd: "/tmp/worktree",
  env: { PATH: "/usr/bin", NAWABARI_SESSION_ID: "session-1" },
  stdio: ["ignore", "pipe", "pipe", 9] as ["ignore", "pipe", "pipe", number],
  seccomp_fd: 9,
};

const trusted = {
  entrypoint: "/opt/nawabari-supervisor/index.js",
  cwd: "/opt/nawabari-supervisor",
  env: { PATH: "/usr/bin", NODE_OPTIONS: "--require attacker.js" },
};

function cgroupFixture(): {
  readonly root: string;
  readonly filesystem: CgroupFileSystem;
  readonly cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-supervisor-test-"));
  const filesystem: CgroupFileSystem = {
    statSync: (file) => fs.statSync(file),
    realpathSync: (file) => fs.realpathSync.native(file),
    readFileSync: (file) => fs.readFileSync(file, "utf8"),
    writeFileSync: (file, value) => fs.writeFileSync(file, value, "utf8"),
    mkdirSync: (file, options) => {
      fs.mkdirSync(file, options);
      if (path.basename(file) === "nawabari") {
        fs.writeFileSync(path.join(file, "cgroup.subtree_control"), "+cpu +memory +pids\n", "utf8");
      }
      if (path.basename(file).startsWith("nawabari-")) {
        fs.writeFileSync(path.join(file, "cgroup.procs"), "", "utf8");
        fs.writeFileSync(path.join(file, "cgroup.events"), "populated 0\n", "utf8");
      }
    },
    rmdirSync: (file) => fs.rmSync(file, { recursive: true }),
  };
  fs.writeFileSync(path.join(root, "cgroup.controllers"), "cpu memory pids\n", "utf8");
  fs.writeFileSync(path.join(root, "cgroup.subtree_control"), "+cpu +memory +pids\n", "utf8");
  return { root, filesystem, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function fakeProcess(
  events: string[],
  waitResult: TrustedSupervisorProcess["wait"] extends () => Promise<infer T> ? T : never = { status: "completed" },
): TrustedSupervisorProcess {
  let go = false;
  return {
    pid: 4242,
    send_go: () => {
      events.push("go");
      go = true;
    },
    terminate: () => events.push("terminate"),
    wait: async () => {
      assert.equal(go, true, "supervisor must not be observed before GO");
      events.push("wait");
      return waitResult;
    },
  };
}

function packet(overrides: Partial<SessionLaunchSupervisorPacket> = {}): SessionLaunchSupervisorPacket {
  return {
    admission: reservation,
    trusted,
    payload,
    result_timeout_ms: 100,
    cgroup: {
      required: true,
      create_scope: () =>
        success({
          contract_id: "nawabari.cgroups-v2.v1" as const,
          root: "/sys/fs/cgroup",
          parent: "/sys/fs/cgroup/nawabari",
          path: "/sys/fs/cgroup/nawabari/scope",
          name: "scope",
          identity: { session_id: "session-1", execution_id: "execution-1" },
          limits: {},
        }),
      attach_process: (_scope, pid) => {
        assert.equal(pid, 4242);
        return success(null);
      },
      cleanup_scope: () =>
        success({
          removed: true,
          after_population: {
            state: "empty",
            populated: false,
            processes: [],
            events: { populated: 0 },
          },
        }),
    },
    ...overrides,
  };
}

test("attaches the supervisor, durably revalidates, and sends one GO before waiting for payload result", async () => {
  const events: string[] = [];
  const result = await runSessionLaunchSupervisor({
    ...packet(),
    process_factory: async (request) => {
      assert.equal(request.payload.stdio[3], 9);
      assert.equal(request.payload.seccomp_fd, 9);
      assert.equal(request.trusted.env?.NODE_OPTIONS, "--require attacker.js");
      const go = JSON.parse(serializeTrustedSupervisorGoMessage(request)) as {
        payload: { stdio: unknown[]; seccomp_fd: number };
      };
      assert.deepEqual(go.payload.stdio, ["ignore", "pipe", "pipe", 3]);
      assert.equal(go.payload.seccomp_fd, 3);
      return fakeProcess(events);
    },
    durability: {
      mark_attached: () => {
        events.push("attached");
      },
      revalidate_epoch: () => {
        events.push("epoch");
        return 19;
      },
      record_release_attempt: () => {
        events.push("release-attempt");
      },
    },
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.status, "completed");
  assert.equal(result.value.started, true);
  assert.deepEqual(events, ["attached", "epoch", "release-attempt", "epoch", "go", "wait"]);
});

test("default supervisor mode still cleans up its owned scope", async () => {
  const base = packet();
  let cleanupCalls = 0;
  const result = await runSessionLaunchSupervisor({
    ...base,
    cgroup: {
      ...base.cgroup,
      cleanup_scope: () => {
        cleanupCalls += 1;
        return success({
          removed: true,
          after_population: { state: "empty", populated: false, processes: [], events: { populated: 0 } },
        });
      },
    },
    process_factory: async () => fakeProcess([]),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.status, "completed");
  assert.equal(cleanupCalls, 1);
});

test("parent death before GO never starts the user payload", async () => {
  let factoryCalled = false;
  const result = await runSessionLaunchSupervisor({
    ...packet(),
    parent: { is_connected: () => false },
    process_factory: async () => {
      factoryCalled = true;
      return fakeProcess([]);
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "not-started");
    assert.equal(result.value.reason, "parent-disconnected-before-go");
    assert.equal(result.value.started, false);
  }
  assert.equal(factoryCalled, false);
});

test("retained supervisor scope is observable as empty after worker completion", async () => {
  const testFixture = cgroupFixture();
  try {
    const created = createCgroupScope(
      { session_id: "session-1", execution_id: "execution-1" },
      { root: testFixture.root, filesystem: testFixture.filesystem },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    const result = await runSessionLaunchSupervisor({
      ...packet(),
      cgroup: {
        required: true,
        retain_scope: true,
        root: testFixture.root,
        filesystem: testFixture.filesystem,
        create_scope: () => created,
      },
      process_factory: async () => ({
        pid: 4242,
        send_go: () => undefined,
        terminate: () => undefined,
        wait: async () => {
          fs.writeFileSync(path.join(created.value.path, "cgroup.procs"), "", "utf8");
          fs.writeFileSync(path.join(created.value.path, "cgroup.events"), "populated 0\n", "utf8");
          return { status: "completed" };
        },
      }),
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.status, "completed");
    assert.equal(result.value.cgroup_scope, created.value.name);
    assert.equal(readCgroupPopulation(created.value, testFixture.filesystem).state, "empty");
    assert.equal(fs.existsSync(created.value.path), true);
  } finally {
    testFixture.cleanup();
  }
});

test("retained supervisor scope remains observable after an uncertain worker result", async () => {
  let cleanupCalls = 0;
  const result = await runSessionLaunchSupervisor({
    ...packet({ result_timeout_ms: 10 }),
    cgroup: {
      ...packet().cgroup,
      retain_scope: true,
      cleanup_scope: () => {
        cleanupCalls += 1;
        return success({
          removed: true,
          after_population: { state: "empty", populated: false, processes: [], events: { populated: 0 } },
        });
      },
    },
    process_factory: async () => ({
      pid: 4242,
      send_go: () => undefined,
      terminate: () => undefined,
      wait: () => new Promise<never>(() => undefined),
    }),
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.status, "unresolved");
  assert.equal(result.value.reason, "timeout");
  assert.equal(result.value.cgroup_scope, "scope");
  assert.equal(cleanupCalls, 0);
});

test("retained supervisor scope remains observable after termination before GO", async () => {
  const events: string[] = [];
  let cleanupCalls = 0;
  const base = packet();
  const result = await runSessionLaunchSupervisor({
    ...base,
    cgroup: {
      ...base.cgroup,
      retain_scope: true,
      cleanup_scope: () => {
        cleanupCalls += 1;
        return success({
          removed: true,
          after_population: { state: "empty", populated: false, processes: [], events: { populated: 0 } },
        });
      },
    },
    process_factory: async () => fakeProcess(events),
    durability: { revalidate_epoch: () => false },
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.status, "not-started");
  assert.equal(result.value.reason, "stale-epoch");
  assert.equal(result.value.cgroup_scope, "scope");
  assert.deepEqual(events, ["terminate"]);
  assert.equal(cleanupCalls, 0);
});

test("a stale epoch terminates the attached supervisor without sending GO", async () => {
  const events: string[] = [];
  const result = await runSessionLaunchSupervisor({
    ...packet(),
    process_factory: async () => fakeProcess(events),
    durability: { revalidate_epoch: () => false },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "not-started");
    assert.equal(result.value.reason, "stale-epoch");
    assert.equal(result.value.started, false);
  }
  assert.deepEqual(events, ["terminate"]);
});

test("an epoch advanced by the durable release record cannot reach GO", async () => {
  const events: string[] = [];
  let observations = 0;
  const result = await runSessionLaunchSupervisor({
    ...packet(),
    process_factory: async () => fakeProcess(events),
    durability: {
      revalidate_epoch: () => {
        observations += 1;
        events.push("epoch");
        return observations === 1 ? 19 : 20;
      },
      record_release_attempt: () => {
        events.push("release-attempt");
      },
    },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "not-started");
    assert.equal(result.value.reason, "stale-epoch");
    assert.equal(result.value.started, false);
  }
  assert.deepEqual(events, ["epoch", "release-attempt", "epoch", "terminate"]);
});

test("parent death after GO is explicit unresolved and never retryable", async () => {
  const events: string[] = [];
  const result = await runSessionLaunchSupervisor({
    ...packet(),
    parent: { is_connected: () => true, wait_for_disconnect: Promise.resolve() },
    process_factory: async () => ({
      pid: 4242,
      send_go: () => {
        events.push("go");
      },
      terminate: () => {
        events.push("terminate");
      },
      wait: () => new Promise<never>(() => undefined),
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "unresolved");
    assert.equal(result.value.reason, "parent-disconnected-after-go");
    assert.equal(result.value.retryable, false);
  }
  assert.deepEqual(events, ["go", "terminate"]);
});

test("timeout after GO is unresolved without automatic replay", async () => {
  let sends = 0;
  const result = await runSessionLaunchSupervisor({
    ...packet({ result_timeout_ms: 10 }),
    process_factory: async () => ({
      pid: 4242,
      send_go: () => {
        sends += 1;
      },
      terminate: () => undefined,
      wait: () => new Promise<never>(() => undefined),
    }),
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "unresolved");
    assert.equal(result.value.reason, "timeout");
    assert.equal(result.value.retryable, false);
  }
  assert.equal(sends, 1);
});

test("timeout after GO surfaces cleanup failure without claiming resolution", async () => {
  const base = packet();
  const result = await runSessionLaunchSupervisor({
    ...base,
    cgroup: {
      ...base.cgroup,
      cleanup_scope: () =>
        failure(new DomainError("SANDBOX_CGROUP_CLEANUP_FAILED", "descendant remains in the supervisor scope.")),
    },
    process_factory: async () => ({
      pid: 4242,
      send_go: () => undefined,
      terminate: () => undefined,
      wait: () => new Promise<never>(() => undefined),
    }),
    result_timeout_ms: 10,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SANDBOX_CGROUP_CLEANUP_FAILED");
  assert.equal(result.error.details?.uncertainty, "timeout");
  assert.equal(result.error.details?.reason, "descendant remains in the supervisor scope.");
});

test("parent disconnect after GO surfaces a throwing cleanup callback", async () => {
  const base = packet();
  const result = await runSessionLaunchSupervisor({
    ...base,
    parent: { is_connected: () => true, wait_for_disconnect: Promise.resolve() },
    cgroup: {
      ...base.cgroup,
      cleanup_scope: () => {
        throw new Error("cleanup callback failed");
      },
    },
    process_factory: async () => ({
      pid: 4242,
      send_go: () => undefined,
      terminate: () => undefined,
      wait: () => new Promise<never>(() => undefined),
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SANDBOX_CGROUP_CLEANUP_FAILED");
  assert.equal(result.error.details?.uncertainty, "parent-disconnected-after-go");
  assert.equal(result.error.details?.reason, "cleanup callback failed");
});
