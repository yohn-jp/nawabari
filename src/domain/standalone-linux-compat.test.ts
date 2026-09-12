import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { LocalSessionBackend } from "./session-backend.js";
import {
  buildExplicitCompatibilityRuntimeProjection,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  type SandboxExecutionRequest,
} from "./sandbox.js";

type SessionFixture = {
  readonly id: string;
  readonly branch: string;
  readonly worktree: string;
  readonly request: SandboxExecutionRequest;
};

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function createRepository(): { readonly repository: string; readonly remote: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-standalone-linux-"));
  const remote = `${repository}-remote.git`;
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari Compatibility"], repository);
  runGit(["config", "user.email", "compatibility@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "standalone Linux compatibility\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return { repository, remote };
}

function removeWorktree(repository: string, worktree: string): void {
  runGit(["worktree", "remove", "--force", worktree], repository);
}

function expectSuccess<T extends { readonly ok: boolean }>(
  result: T,
  label: string,
): asserts result is T & { ok: true } {
  assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
}

async function createProtectedSession(
  backend: LocalSessionBackend,
  repository: string,
  suffix: string,
): Promise<SessionFixture> {
  const worktree = `${repository}-${suffix}`;
  const created = await backend.createSession(
    { cwd: repository },
    { branch: `feature/sandbox-${suffix}`, worktree, label: null, base: null },
  );
  expectSuccess(created, `create ${suffix}`);
  const runtimeLayout = discoverSandboxRuntimeLayout();
  const runtimeProjection = buildExplicitCompatibilityRuntimeProjection(runtimeLayout);
  expectSuccess(runtimeProjection, `compatibility projection ${suffix}`);
  const resolved = await resolveSandboxExecutionRequest(
    backend,
    { cwd: worktree },
    { session_id: created.value.session_id, enforce: true, runtime_projection: runtimeProjection.value },
  );
  expectSuccess(resolved, `resolve ${suffix}`);
  return {
    id: created.value.session_id,
    branch: created.value.branch,
    worktree,
    request: resolved.value,
  };
}

async function run(
  fixture: SessionFixture,
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await runSandboxedCommand(fixture.request, { command, args }, { timeout_ms: 30_000 });
  expectSuccess(result, `${command} ${args.join(" ")}`);
  assert.equal(
    result.value.exit_code,
    0,
    `${command} exited ${result.value.exit_code}: ${result.value.stdout}${result.value.stderr}`,
  );
  assert.equal(result.value.signal, null, `${command} terminated by ${result.value.signal}`);
  return result.value;
}

function capabilityUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "SANDBOX_CAPABILITY_UNAVAILABLE" || error.code === "SANDBOX_UNSUPPORTED_PLATFORM")
  );
}

test("standalone Linux runs development workloads through the exact protected profile", async (t) => {
  if (process.platform !== "linux") {
    t.skip("the canonical protected profile is Linux-only");
    return;
  }
  if (discoverSandboxRuntimeLayout().bubblewrap === null) {
    t.skip("bubblewrap is unavailable; no standalone protected evidence can be claimed");
    return;
  }

  const backend = new LocalSessionBackend();
  const { repository, remote } = createRepository();
  const hostSecret = `${repository}-host-secret`;
  const siblingSecret = `${repository}-sibling-secret`;
  const fixtures: SessionFixture[] = [];
  try {
    let first: SessionFixture;
    try {
      first = await createProtectedSession(backend, repository, "one");
    } catch (error: unknown) {
      if (capabilityUnavailable(error)) {
        t.skip(`protected profile unavailable: ${String((error as { code?: unknown }).code)}`);
        return;
      }
      throw error;
    }
    fixtures.push(first);
    fs.writeFileSync(hostSecret, "host-only\n");
    fs.mkdirSync(siblingSecret, { recursive: true });
    fs.writeFileSync(path.join(siblingSecret, "secret.txt"), "sibling-only\n");

    for (const fixture of fixtures) {
      assert.equal(fixture.request.contract_id, "nawabari.sandbox-execution.v1");
      assert.equal(fixture.request.enforce, true);
      assert.equal(fixture.request.network_mode, "inherited");
      assert.equal(fixture.request.filesystem.owned_worktree, fs.realpathSync.native(fixture.worktree));
      assert.equal(fixture.request.filesystem.user_tool_home, process.env.HOME ?? null);
      assert.ok(fixture.request.filesystem.runtime_paths.includes("/proc"));
      assert.ok(fixture.request.filesystem.runtime_paths.includes("/tmp"));
      assert.ok(fixture.request.filesystem.system_paths.includes("/etc/hosts"));
      assert.ok(!fixture.request.filesystem.system_paths.includes(process.env.HOME ?? ""));
    }

    const shell = await run(first, "sh", [
      "-ceu",
      [
        'test "$PWD" = "$1"',
        'test "$HOME" = "/home/nawabari"',
        'test "$XDG_CACHE_HOME" = "/home/nawabari/.cache"',
        'test ! -e "$2"',
        'test ! -e "$3/secret.txt"',
        'printf "protected shell\n" >> README.md',
        'printf "session-one-worktree\n" > session-one-view.txt',
        'printf "session-one-home\n" > "$HOME/session-one-home.txt"',
        'printf "session-one-cache\n" > "$XDG_CACHE_HOME/session-one-cache.txt"',
        'printf "shared-state\n" > "$HOME/.nawabari/shared-marker.txt"',
        "git status --porcelain=v1 --untracked-files=all",
        "git diff --no-ext-diff -- README.md",
        'printf "protected shell\n"',
      ].join(";"),
      "protected-shell",
      first.worktree,
      hostSecret,
      siblingSecret,
    ]);
    assert.match(shell.stdout, / M README\.md/u);
    assert.match(shell.stdout, /\?\? session-one-view\.txt/u);
    assert.match(shell.stdout, /protected shell/u);
    assert.equal(shell.stderr, "");

    const node = await run(first, "node", [
      "-e",
      "if (process.env.HOME !== '/home/nawabari') process.exit(1); require('node:fs').writeFileSync(process.env.HOME + '/node-marker.txt', 'node-ok'); process.stdout.write('node-ok')",
    ]);
    assert.equal(node.stdout, "node-ok");

    const pnpm = await run(first, "pnpm", ["--version"]);
    assert.match(pnpm.stdout.trim(), /^\d+\.\d+\.\d+$/u);

    const rust = await run(first, "sh", [
      "-ceu",
      'printf \'fn main() { println!("rust-ok"); }\n\' > "$HOME/main.rs"; rustc "$HOME/main.rs" -o "$HOME/rust-bin"; "$HOME/rust-bin"',
    ]);
    assert.equal(rust.stdout, "rust-ok\n");
    const cargo = await run(first, "cargo", ["--version"]);
    assert.match(cargo.stdout, /^cargo \d+/u);

    const python = await run(first, "python3", ["-c", "print('python-ok')"]);
    assert.equal(python.stdout, "python-ok\n");
    const uv = await run(first, "uv", ["--version"]);
    assert.match(uv.stdout, /^uv \d+/u);

    const compiler = await run(first, "sh", [
      "-ceu",
      'printf \'#include <stdio.h>\\nint main(void) { puts("compiler-ok"); }\\n\' > "$HOME/main.c"; cc "$HOME/main.c" -o "$HOME/c-bin"; "$HOME/c-bin"',
    ]);
    assert.equal(compiler.stdout, "compiler-ok\n");

    const longLived = await run(first, "node", ["-e", "setTimeout(() => process.stdout.write('agent-like-ok'), 80)"]);
    assert.equal(longLived.stdout, "agent-like-ok");

    const second = await createProtectedSession(backend, repository, "two");
    fixtures.push(second);
    assert.equal(second.request.contract_id, "nawabari.sandbox-execution.v1");
    assert.equal(second.request.enforce, true);
    assert.equal(second.request.network_mode, "inherited");

    const secondView = await run(second, "sh", [
      "-ceu",
      [
        'test -e "$HOME/.nawabari/shared-marker.txt"',
        'test ! -e "$HOME/session-one-home.txt"',
        'test ! -e "$XDG_CACHE_HOME/session-one-cache.txt"',
        'test ! -e "$1/session-one-view.txt"',
        'printf "session-two-home\n" > "$HOME/session-two-home.txt"',
        'printf "session-two-cache\n" > "$XDG_CACHE_HOME/session-two-cache.txt"',
        'printf "session-two\n"',
      ].join(";"),
      "session-two-isolation",
      first.worktree,
    ]);
    assert.equal(secondView.stdout, "session-two\n");

    const concurrent = await Promise.all([
      run(first, "sh", [
        "-ceu",
        'printf "first-process-view\n" > /tmp/session-view; test -f /tmp/session-view; sleep 0.15; cat /tmp/session-view',
      ]),
      run(second, "sh", [
        "-ceu",
        'printf "second-process-view\n" > /tmp/session-view; test -f /tmp/session-view; sleep 0.15; cat /tmp/session-view',
      ]),
    ]);
    assert.equal(concurrent[0].stdout, "first-process-view\n");
    assert.equal(concurrent[1].stdout, "second-process-view\n");

    fs.rmSync(path.join(first.worktree, "session-one-view.txt"), { force: true });
    const firstContext = { cwd: first.worktree };
    const claim = await backend.claimResources(firstContext, {
      session_id: first.id,
      claims: [{ resource: "README.md", mode: "exclusive-write" }],
    });
    expectSuccess(claim, "claim lifecycle resource");
    const checkpoint = await backend.checkpoint(firstContext, { session_id: first.id });
    expectSuccess(checkpoint, "checkpoint");
    assert.ok(checkpoint.value.paths.changed.includes("README.md"));
    const diff = await backend.repositoryDiff(firstContext, {
      session_id: first.id,
      paths: ["README.md"],
      include_patch: true,
      max_bytes: 8_192,
      max_hunks: 8,
    });
    expectSuccess(diff, "diff");
    assert.match(diff.value.patch ?? "", /protected shell/u);
    const commit = await backend.commit(firstContext, {
      session_id: first.id,
      message: "chore: record standalone compatibility evidence",
      resources: ["README.md"],
    });
    expectSuccess(commit, "commit");
    assert.match(commit.value.commit_sha, /^[0-9a-f]{40}$/u);
    runGit(["init", "--quiet", "--bare", remote], repository);
    runGit(["remote", "add", "origin", remote], repository);
    const pushed = await backend.push(firstContext, {
      session_id: first.id,
      resources: ["README.md"],
      remote: "origin",
      branch: first.branch,
      force: false,
      create_upstream: true,
    });
    expectSuccess(pushed, "push");
    assert.equal(pushed.value.remote, "origin");
    assert.equal(pushed.value.branch, first.branch);
    runGit(["merge", "--ff-only", first.branch], repository);
    const closed = await backend.closeSession(firstContext, { session_id: first.id });
    expectSuccess(closed, "close first session");
    assert.equal(closed.value.worktree_removed, true);

    const closedSecond = await backend.closeSession({ cwd: second.worktree }, { session_id: second.id });
    expectSuccess(closedSecond, "close second session");
    assert.equal(closedSecond.value.worktree_removed, true);
    assert.equal(fs.existsSync(remote), true);
  } finally {
    for (const fixture of fixtures) {
      try {
        removeWorktree(repository, fixture.worktree);
      } catch {
        // Cleanup below is sufficient when the lifecycle test already removed it.
      }
    }
    fs.rmSync(hostSecret, { force: true });
    fs.rmSync(siblingSecret, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
