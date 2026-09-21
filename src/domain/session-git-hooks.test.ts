import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  GOVERNED_HOOK_EVENTS,
  SANDBOX_SERIALIZATION_KEY,
  SESSION_GIT_DISABLED_HOOKS_PATH,
  SESSION_GIT_HOOKS_PATH,
  materializeSessionGitConfig,
  resolveSessionHookSet,
  runGovernedHook,
  serializeSessionGitConfig,
  type GovernedHookRunner,
  type SessionHookSet,
} from "./session-git-hooks.js";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";

function profile(hooks: "disabled" | "governed" = "governed"): Record<string, unknown> {
  return {
    contract_id: "nawabari.worktree-runtime-profile.v1",
    schema_version: 1,
    id: "test-profile",
    version: "1",
    materialSelection: { profiles: ["base"], operations: [] },
    filesystem: { readOnly: [], write: [], create: [], delete: [], deny: [], immutable: [] },
    tools: [
      {
        entrypoint: "node",
        provider: { id: "node", requirement_id: "node-runtime" },
      },
    ],
    shell: { entrypoint: "node" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "session", data: "session", state: "session" },
      tmp: "execution",
    },
    git: {
      config: "session-private",
      globalConfig: "excluded",
      credentialHelpers: "disabled",
      hooks,
    },
    execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
  };
}

function executableFixture(): { root: string; source: string; digest: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-git-hooks-"));
  const source = path.join(root, "hook.sh");
  fs.writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.chmodSync(source, 0o700);
  const digest = createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  return { root, source, digest };
}

function providerMaterial(fixture: ReturnType<typeof executableFixture>): Record<string, unknown> {
  return {
    kind: "provider",
    provider: { id: "nawabari-hook", requirement_id: "nawabari-hook-runtime" },
    source: fixture.source,
    target: "/nawabari/bin/nawabari-hook",
    digest: fixture.digest,
  };
}

test("materializes only the private allowlist and preserves identity precedence per key", () => {
  const result = materializeSessionGitConfig(profile(), {
    repository_local_name: "Local Author",
    repository_local_email: null,
    host_global_name: "Global Author",
    host_global_email: "global@example.invalid",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.config, {
    "core.hooksPath": SESSION_GIT_HOOKS_PATH,
    "user.name": "Local Author",
    "user.email": "global@example.invalid",
  });
  assert.equal(result.value.identity_source.name, "repository-local");
  assert.equal(result.value.identity_source.email, "host-global");
  assert.equal(result.value.global_config, "excluded");
  assert.equal(result.value.system_config, "excluded");
  assert.equal(result.value.credential_helpers, "disabled");
});

test("disabled hooks explicitly point at the inert path and do not require material", () => {
  const result = materializeSessionGitConfig(profile("disabled"), {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.config["core.hooksPath"], SESSION_GIT_DISABLED_HOOKS_PATH);
  const hooks = resolveSessionHookSet(profile("disabled"), { not: "trusted" });
  assert.equal(hooks.ok, true);
  if (hooks.ok) {
    assert.equal(hooks.value.mode, "disabled");
    assert.deepEqual(hooks.value.hooks, []);
  }
});

test("governed hooks resolve all canonical events from digest-pinned provider material", () => {
  const fixture = executableFixture();
  try {
    const result = resolveSessionHookSet(profile(), {
      ...providerMaterial(fixture),
      events: [...GOVERNED_HOOK_EVENTS].reverse(),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.mode, "governed");
    assert.deepEqual(
      result.value.hooks.map((hook) => hook.event),
      [...GOVERNED_HOOK_EVENTS].sort(),
    );
    assert.equal(result.value.hooks[0]?.command, "/nawabari/bin/nawabari-hook");
    assert.deepEqual(result.value.hooks[0]?.argv, [result.value.hooks[0]?.event]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("changed or mismatched provider bytes are rejected before hook admission", () => {
  const fixture = executableFixture();
  try {
    const mismatched = resolveSessionHookSet(profile(), { ...providerMaterial(fixture), digest: "0".repeat(64) });
    assert.equal(mismatched.ok, false);
    fs.appendFileSync(fixture.source, "changed\n");
    const stale = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(stale.ok, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("tracked blob paths are repository-relative and cannot escape", () => {
  const fixture = executableFixture();
  try {
    const result = resolveSessionHookSet(profile(), {
      kind: "tracked-blob",
      path: "../hook.sh",
      source: fixture.source,
      target: "/nawabari/worktree/hook.sh",
      digest: fixture.digest,
    });
    assert.equal(result.ok, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("governed execution is direct, deterministic, and passes stdin without shell interpolation", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const calls: Array<{ command: string; argv: readonly string[]; options: Record<string, unknown> }> = [];
    const runner: GovernedHookRunner = (command, argv, options) => {
      calls.push({ command, argv, options: options as unknown as Record<string, unknown> });
      return { pid: 1, output: [null, "ok", ""], stdout: "ok", stderr: "", status: 0, signal: null, error: undefined };
    };
    const result = runGovernedHook("pre-push", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      stdin: "refs/heads/main\n",
      argv: ["--bounded"],
      environment: { GIT_TERMINAL_PROMPT: "0" },
      runner,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, "/nawabari/bin/nawabari-hook");
    assert.deepEqual(calls[0]?.argv, ["pre-push", "--bounded"]);
    assert.equal(calls[0]?.options.shell, false);
    assert.equal(calls[0]?.options.input, "refs/heads/main\n");
    const env = calls[0]?.options.env as NodeJS.ProcessEnv;
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.NAWABARI_HOOK_EVENT, "pre-push");
    assert.equal(env.PATH, "/nawabari/bin");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("protected execution environment keys cannot be overridden by hook context", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    let spawned = false;
    const result = runGovernedHook("pre-commit", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      environment: { PATH: "/tmp/ambient", GIT_CONFIG_GLOBAL: "/tmp/global" },
      runner: () => {
        spawned = true;
        throw new Error("must not run");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROFILE_INVALID");
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("execution rejects forged hook commands and argv even when the outer set looks canonical", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    let spawned = false;
    const runner: GovernedHookRunner = () => {
      spawned = true;
      throw new Error("must not run");
    };
    const forgedCommand = {
      ...resolved.value,
      hooks: resolved.value.hooks.map((hook, index) =>
        index === 0 ? { ...hook, command: "/nawabari/bin/forged" } : hook,
      ),
    };
    const commandResult = runGovernedHook("pre-commit", {
      hook_set: forgedCommand as unknown as SessionHookSet,
      session_id: "session-1",
      cwd: "/tmp",
      runner,
    });
    assert.equal(commandResult.ok, false);
    if (!commandResult.ok) assert.equal(commandResult.error.code, "RUNTIME_PROFILE_AMBIGUOUS");
    const forgedArgv = {
      ...resolved.value,
      hooks: resolved.value.hooks.map((hook, index) =>
        index === 0 ? { ...hook, argv: [hook.event, "--forged"] } : hook,
      ),
    };
    const argvResult = runGovernedHook("pre-commit", {
      hook_set: forgedArgv as unknown as SessionHookSet,
      session_id: "session-1",
      cwd: "/tmp",
      runner,
    });
    assert.equal(argvResult.ok, false);
    if (!argvResult.ok) assert.equal(argvResult.error.code, "RUNTIME_PROFILE_INVALID");
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a held registry lock or nested hook rejects before spawning", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    let spawned = false;
    const runner: GovernedHookRunner = () => {
      spawned = true;
      return { pid: 1, output: [null, "", ""], stdout: "", stderr: "", status: 0, signal: null, error: undefined };
    };
    const locked = runGovernedHook("pre-commit", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      registry_lock_held: true,
      runner,
    });
    assert.equal(locked.ok, false);
    if (!locked.ok) assert.equal(locked.error.code, "LOCK_CONTENTION");
    const nested = runGovernedHook("pre-commit", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      hook_depth: 1,
      runner,
    });
    assert.equal(nested.ok, false);
    if (!nested.ok) assert.equal(nested.error.code, "LOCK_CONTENTION");
    assert.equal(spawned, false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hook failure is reported without turning post-checkout into ownership transfer", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), { ...providerMaterial(fixture), events: ["post-checkout"] });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    const runner: GovernedHookRunner = () => ({
      pid: 1,
      output: [null, "observed", "denied"],
      stdout: "observed",
      stderr: "denied",
      status: 1,
      signal: null,
      error: undefined,
    });
    const result = runGovernedHook("post-checkout", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      runner,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "GIT_OPERATION_FAILED");
      assert.equal(result.error.details?.event, "post-checkout");
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("material mutation after resolution fails closed at execution", () => {
  const fixture = executableFixture();
  try {
    const resolved = resolveSessionHookSet(profile(), providerMaterial(fixture));
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    fs.appendFileSync(fixture.source, "mutation\n");
    const result = runGovernedHook("pre-commit", {
      hook_set: resolved.value,
      session_id: "session-1",
      cwd: "/tmp",
      runner: () => {
        throw new Error("must not run");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_PROFILE_AMBIGUOUS");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("session Git config serializes under the sandbox document key", () => {
  const result = materializeSessionGitConfig(profile(), {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const serialized = serializeSessionGitConfig(result.value);
  assert.equal(serialized.ok, true);
  if (!serialized.ok) return;
  const document = JSON.parse(serialized.value) as Record<string, unknown>;
  assert.deepEqual(Object.keys(document), [SANDBOX_SERIALIZATION_KEY]);
  assert.equal((document[SANDBOX_SERIALIZATION_KEY] as Record<string, unknown>).contract_id, result.value.contract_id);
});

test("session Git config serialization rejects arbitrary keys and top-level fields", () => {
  const result = materializeSessionGitConfig(profile(), {});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const forbiddenKey = {
    ...result.value,
    config: { ...result.value.config, "credential.helper": "!ambient-helper" },
  };
  assert.equal(serializeSessionGitConfig(forbiddenKey).ok, false);
  const extraField = { ...result.value, arbitrary: "not part of the contract" };
  assert.equal(serializeSessionGitConfig(extraField).ok, false);
});
