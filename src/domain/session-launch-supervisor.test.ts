import assert from "node:assert/strict";
import { test } from "node:test";

import { success } from "./errors.js";
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
      cleanup_scope: () => success({ removed: true }),
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
  assert.deepEqual(events, ["attached", "epoch", "release-attempt", "go", "wait"]);
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
