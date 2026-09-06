import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "../cli.js";
import type { CliIO } from "../presentation.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  compileSandboxInvocation,
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  sandboxDoctorReport,
} from "./sandbox.js";

/**
 * This is an opt-in integration conformance test for the canonical Mottainai
 * NixOS Runtime fixture.  It is deliberately not a substitute sandbox: the
 * default CLI dependencies and the production launcher are used unchanged.
 * Set the marker only from the fixture's unprivileged repository principal;
 * ordinary Linux/package verification keeps this test skipped.
 */
const NIXOS_RUNTIME_CONFORMANCE = "1";

type JsonRecord = Record<string, unknown>;

type CapturedCli = {
  readonly exit_code: number;
  readonly response: JsonRecord;
  readonly stderr: readonly string[];
};

function capture(): { readonly stdout: string[]; readonly stderr: string[]; readonly io: CliIO } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
  };
}

async function invoke(cwd: string, arguments_: readonly string[]): Promise<CapturedCli> {
  const output = capture();
  const exitCode = await runCli(["--json", ...arguments_], { cwd, io: output.io });
  assert.equal(output.stderr.length, 0, output.stderr.join("\n"));
  assert.equal(output.stdout.length, 1, output.stdout.join("\n"));
  const response = JSON.parse(output.stdout[0] as string) as JsonRecord;
  assert.equal(response.ok, true, JSON.stringify(response));
  return { exit_code: exitCode, response, stderr: output.stderr };
}

function stringField(response: JsonRecord, field: string): string {
  const value = response[field];
  assert.equal(typeof value, "string", `${field} must be a string: ${JSON.stringify(response)}`);
  return value as string;
}

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-nixos-runtime-"));
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari NixOS Conformance"], repository);
  runGit(["config", "user.email", "nixos-conformance@nawabari.invalid"], repository);
  runGit(["config", "commit.gpgsign", "false"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture-only\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "fixture"], repository);
  return repository;
}

function runGit(arguments_: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...arguments_], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}

function removeWorktree(repository: string, worktree: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktree], repository);
  } catch {
    // Fixture cleanup below remains bounded when the session was never created.
  }
  fs.rmSync(worktree, { recursive: true, force: true });
}

async function cleanupSession(cwd: string, sessionId: string): Promise<void> {
  const output = capture();
  await runCli(["--json", "session", "close", "--session", sessionId], { cwd, io: output.io });
}

test("canonical NixOS Runtime runs representative workloads through the protected session route", async (t) => {
  if (process.env.NAWABARI_NIXOS_RUNTIME_CONFORMANCE !== NIXOS_RUNTIME_CONFORMANCE) {
    t.skip("set NAWABARI_NIXOS_RUNTIME_CONFORMANCE=1 in the canonical NixOS Runtime fixture");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("protected execution is Linux-only");
    return;
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("the conformance fixture must run as its unprivileged repository principal");
    return;
  }

  const layout = discoverSandboxRuntimeLayout();
  assert.notEqual(layout.nix_store, null, "NixOS /nix/store is required by the fixture");
  assert.notEqual(layout.nix_current_system, null, "NixOS /run/current-system is required by the fixture");
  assert.equal(layout.usr, null, "NixOS must not fall back to a broad /usr mount");
  assert.equal(layout.bin, null, "NixOS must not fall back to a broad /bin mount");
  assert.equal(layout.lib, null, "NixOS must not fall back to a broad /lib mount");
  assert.equal(layout.lib64, null, "NixOS must not fall back to a broad /lib64 mount");

  const doctor = sandboxDoctorReport(defaultSandboxProbe);
  assert.equal(doctor.platform_supported, true);
  assert.equal(doctor.ready, true, JSON.stringify(doctor));
  assert.equal(doctor.network_mode, "inherited");

  const repository = createRepository();
  const firstWorktree = path.join(repository, "nawabari", "worktrees", "first");
  const secondWorktree = path.join(repository, "nawabari", "worktrees", "second");
  let firstSession: string | null = null;
  let secondSession: string | null = null;
  try {
    const first = await invoke(repository, [
      "session",
      "create",
      "--branch",
      "compat/first",
      "--worktree",
      firstWorktree,
    ]);
    assert.equal(first.exit_code, 0);
    firstSession = stringField(first.response, "session_id");
    const second = await invoke(repository, [
      "session",
      "create",
      "--branch",
      "compat/second",
      "--worktree",
      secondWorktree,
    ]);
    assert.equal(second.exit_code, 0);
    secondSession = stringField(second.response, "session_id");

    // Inspect the exact request consumed by the same #145 launcher used by
    // `session run`; this proves the fixture did not add an outer-Runtime bind.
    const backend = new LocalSessionBackend();
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: firstWorktree },
      { session_id: firstSession, enforce: true },
      defaultSandboxProbe,
      layout,
    );
    assert.equal(request.ok, true, request.ok ? "" : request.error.message);
    if (!request.ok) return;
    const compiled = compileSandboxInvocation(request.value, { command: "true" });
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (!compiled.ok) return;
    assert.equal(compiled.value.args.includes("--unshare-net"), false);
    for (const broadPath of ["/usr", "/bin", "/lib", "/lib64"]) {
      assert.equal(compiled.value.args.includes(broadPath), false, `unexpected broad FHS path: ${broadPath}`);
    }
    const injectedBroadPath = compileSandboxInvocation(
      {
        ...request.value,
        filesystem: { ...request.value.filesystem, system_paths: [...request.value.filesystem.system_paths, "/usr"] },
      },
      { command: "true" },
    );
    assert.equal(injectedBroadPath.ok, false);
    if (!injectedBroadPath.ok) assert.equal(injectedBroadPath.error.code, "SANDBOX_TOPOLOGY_INVALID");

    const firstId = await invoke(firstWorktree, ["session", "id"]);
    assert.equal(firstId.exit_code, 0);
    assert.equal(stringField(firstId.response, "session_id"), firstSession);
    const status = await invoke(firstWorktree, ["status"]);
    assert.equal(status.exit_code, 0);
    const checkpoint = await invoke(firstWorktree, ["checkpoint", "--session", firstSession]);
    assert.equal(checkpoint.exit_code, 0);

    const protectedPath = await invoke(firstWorktree, [
      "session",
      "run",
      "--session",
      firstSession,
      "--",
      "sh",
      "-ceu",
      [
        'test "$HOME" = /home/nawabari',
        'test "$TMPDIR" = /tmp',
        "test -d /nix/store",
        "test -d /run/current-system",
        "test ! -e /usr",
        "test ! -e /etc/nixos",
        'mkdir -p "$HOME/.cache" "$HOME/.nawabari"',
        'printf private > "$HOME/.cache/first-marker"',
        'printf shared > "$HOME/.nawabari/shared-marker"',
      ].join("; "),
    ]);
    assert.equal(protectedPath.exit_code, 0);
    assert.equal(protectedPath.response.exit_code, 0, JSON.stringify(protectedPath.response));

    const workloads: readonly (readonly [string, readonly string[]])[] = [
      ["git", ["git", "status", "--short"]],
      ["shell/core", ["sh", "-ceu", "printf shell-ok; printf ' %s' \"$(printf core-ok)\""]],
      ["node", ["node", "-e", "process.stdout.write('node-ok')"]],
      ["pnpm", ["pnpm", "--version"]],
      ["rust/cargo", ["cargo", "--version"]],
      ["python", ["python3", "-c", "print('python-ok', end='')"]],
      ["python/uv", ["uv", "--version"]],
      [
        "compiler/subprocess",
        [
          "sh",
          "-ceu",
          'printf \'%s\\n\' \'#include <stdio.h>\' \'int main(void){puts("compiler-ok");}\' | cc -x c -o "$TMPDIR/nawabari-child" -; "$TMPDIR/nawabari-child"; rm -f "$TMPDIR/nawabari-child"',
        ],
      ],
      [
        "long-lived-agent-like-cli",
        ["sh", "-ceu", "node -e 'setTimeout(() => process.stdout.write(\"long-lived-ok\"), 40)'"],
      ],
    ];
    for (const [name, command] of workloads) {
      const result = await invoke(firstWorktree, ["session", "run", "--session", firstSession, "--", ...command]);
      assert.equal(result.exit_code, 0, `${name}: ${JSON.stringify(result.response)}`);
      assert.equal(result.response.exit_code, 0, `${name}: ${JSON.stringify(result.response)}`);
    }

    const secondHome = await invoke(secondWorktree, [
      "session",
      "run",
      "--session",
      secondSession,
      "--",
      "sh",
      "-ceu",
      [
        'test "$HOME" = /home/nawabari',
        'test ! -e "$HOME/.cache/first-marker"',
        'test "$(cat "$HOME/.nawabari/shared-marker")" = shared',
      ].join("; "),
    ]);
    assert.equal(secondHome.exit_code, 0, JSON.stringify(secondHome.response));
    assert.equal(secondHome.response.exit_code, 0, JSON.stringify(secondHome.response));

    const firstConcurrent = invoke(firstWorktree, [
      "session",
      "run",
      "--session",
      firstSession,
      "--",
      "sh",
      "-ceu",
      `test ! -e /tmp/second-marker; printf first > /tmp/first-marker; sleep 0.1; test ! -e /tmp/second-marker`,
    ]);
    const secondConcurrent = invoke(secondWorktree, [
      "session",
      "run",
      "--session",
      secondSession,
      "--",
      "sh",
      "-ceu",
      `test ! -e /tmp/first-marker; printf second > /tmp/second-marker; sleep 0.1; test ! -e /tmp/first-marker`,
    ]);
    const concurrent = await Promise.all([firstConcurrent, secondConcurrent]);
    for (const result of concurrent) {
      assert.equal(result.exit_code, 0, JSON.stringify(result.response));
      assert.equal(result.response.exit_code, 0, JSON.stringify(result.response));
    }
  } finally {
    if (firstSession !== null) await cleanupSession(repository, firstSession);
    if (secondSession !== null) await cleanupSession(repository, secondSession);
    removeWorktree(repository, firstWorktree);
    removeWorktree(repository, secondWorktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
