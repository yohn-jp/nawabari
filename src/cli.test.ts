import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { success } from "./domain/errors.js";
import type {
  SessionBackend,
  SessionCloseResult,
  SessionContext,
  SessionCreateOptions,
  SessionRecord,
} from "./domain/session.js";
import { unavailableCapabilities } from "./domain/session.js";
import type { CliIO } from "./presentation.js";

const sampleSession: SessionRecord = {
  schema_version: 1,
  session_id: "0190f1e0-0000-7000-8000-000000000001",
  repository: "/tmp/example-repository",
  worktree: "/tmp/example-worktree",
  branch: "feat/example",
  state: "active",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
};

function capture(): { stdout: string[]; stderr: string[]; io: CliIO } {
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

function backendForTests(overrides: Partial<SessionBackend> = {}): SessionBackend {
  const closeResult: SessionCloseResult = {
    session: sampleSession,
    worktree_removed: true,
    branch_removed: true,
  };
  return {
    createSession: async (_context: SessionContext, _options: SessionCreateOptions) => success(sampleSession),
    resolveCurrentSession: async (_context: SessionContext) => success(sampleSession),
    getSession: async (_context: SessionContext, _sessionId: string) => success(sampleSession),
    guard: async (_context: SessionContext) =>
      success({
        allowed: true,
        code: "ALLOWED" as const,
        repository: sampleSession.repository,
        worktree: sampleSession.worktree,
        branch: sampleSession.branch,
        session_id: sampleSession.session_id,
        owner_session_id: sampleSession.session_id,
        requested_session_id: null,
        state: sampleSession.state,
        details: {},
      }),
    listSessions: async (_context: SessionContext) => success({ sessions: [sampleSession] }),
    status: async (_context: SessionContext) =>
      success({
        repository: sampleSession.repository,
        current_session: sampleSession,
        sessions: [sampleSession],
        capabilities: unavailableCapabilities(),
      }),
    closeSession: async (_context: SessionContext) => success(closeResult),
    garbageCollect: async (_context: SessionContext) => success({ apply: false, candidates: [], cleaned: [] }),
    ...overrides,
  };
}

test("--help exits 0 and prints the nawabari usage", async () => {
  const output = capture();
  const exitCode = await runCli(["--help"], { io: output.io });

  assert.equal(exitCode, 0);
  assert.match(output.stdout.join("\n"), /Usage: nawabari/);
  assert.equal(output.stderr.length, 0);
});

test("JSON help separates global, session, and garbage-collection options", async () => {
  const output = capture();
  const exitCode = await runCli(["--help", "--json"], { io: output.io });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    ok: true,
    command: "help",
    usage: "Usage: nawabari <command> [options]",
    commands: [
      "session create",
      "session id",
      "session show",
      "session list",
      "session claim",
      "session update",
      "session claims",
      "session release",
      "resource claim",
      "resource update",
      "resource list",
      "resource release",
      "session close",
      "authorize",
      "checkpoint",
      "commit",
      "push",
      "status",
      "guard",
      "gc",
      "doctor",
      "capabilities",
    ],
    options: ["--json", "--help", "--version"],
    session_options: [
      "--branch",
      "--worktree",
      "--base",
      "--label",
      "--session",
      "--resource",
      "--mode",
      "--claim-id",
      "--repository",
    ],
    authorization_options: ["--session", "--operation", "--resource"],
    checkpoint_options: ["--session"],
    commit_options: ["--session", "--message", "--resource"],
    push_options: [
      "--session",
      "--resource",
      "--remote",
      "--branch",
      "--remote-branch",
      "--force",
      "--create-upstream",
    ],
    gc_options: ["--apply", "--dry-run"],
  });
});

test("no arguments prints help and exits with the usage code", async () => {
  const output = capture();
  const exitCode = await runCli([], { io: output.io });

  assert.equal(exitCode, 2);
  assert.match(output.stdout.join("\n"), /session create/);
});

test("unknown commands expose a stable JSON error without decoration", async () => {
  const output = capture();
  const exitCode = await runCli(["bogus", "--json"], { io: output.io });

  assert.equal(exitCode, 2);
  assert.equal(output.stderr.length, 0);
  assert.equal(output.stdout.length, 1);
  const response = JSON.parse(output.stdout[0]) as {
    ok: boolean;
    code: string;
    command: string;
    details: { command: string };
  };
  assert.deepEqual(response, {
    ok: false,
    command: "bogus",
    code: "UNKNOWN_COMMAND",
    message: "Unknown command: bogus.",
    details: { command: "bogus" },
  });
});

test("state commands reject honestly when the current directory is not a Git repository", async () => {
  const output = capture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-not-a-repository-"));
  try {
    const exitCode = await runCli(["session", "id", "--json"], { io: output.io, cwd: directory });

    assert.equal(exitCode, 3);
    assert.equal(output.stderr.length, 0);
    const response = JSON.parse(output.stdout[0]) as {
      ok: boolean;
      code: string;
      command: string;
      details: { cwd: string };
    };
    assert.equal(response.ok, false);
    assert.equal(response.code, "NOT_GIT_REPOSITORY");
    assert.equal(response.command, "session id");
    assert.equal(response.details.cwd, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("session id resolves from the current worktree without an explicit id", async () => {
  let receivedContext: SessionContext | null = null;
  const backend = backendForTests({
    resolveCurrentSession: async (context) => {
      receivedContext = context;
      return success(sampleSession);
    },
  });
  const output = capture();
  const exitCode = await runCli(["session", "id", "--json"], {
    backend,
    cwd: "/tmp/owned-worktree",
    io: output.io,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(receivedContext, { cwd: "/tmp/owned-worktree" });
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    ok: true,
    command: "session id",
    session_id: sampleSession.session_id,
  });
});

test("capabilities discovery is available outside a Git repository and exposes the standalone contract", async () => {
  const output = capture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-capabilities-"));
  try {
    const exitCode = await runCli(["capabilities", "--json"], {
      cwd: directory,
      io: output.io,
      version: "test-version",
    });

    assert.equal(exitCode, 0);
    assert.equal(output.stderr.length, 0);
    const response = JSON.parse(output.stdout[0] ?? "") as {
      ok: boolean;
      command: string;
      contract_id: string;
      package_version: string;
      dependencies: { mottainai: boolean; github: boolean; gh: boolean; network: boolean };
      capabilities: Array<{ id: string; commands: string[] }>;
    };
    assert.equal(response.ok, true);
    assert.equal(response.command, "capabilities");
    assert.equal(response.contract_id, "nawabari.standalone-execution.v1");
    assert.equal(response.package_version, "test-version");
    assert.deepEqual(response.dependencies, {
      local_git: true,
      network: false,
      github: false,
      gh: false,
      mottainai: false,
      llm: false,
      agent_runtime: false,
    });
    assert.ok(response.capabilities.some((capability) => capability.commands.includes("commit")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("JSON version discovery includes the standalone contract identifier", async () => {
  const output = capture();
  const exitCode = await runCli(["--version", "--json"], { io: output.io, version: "test-version" });

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    ok: true,
    command: "version",
    version: "test-version",
    contract_id: "nawabari.standalone-execution.v1",
    contract_schema_version: 1,
  });
});

test("human and JSON modes present the same backend status result", async () => {
  const backend = backendForTests();
  const jsonOutput = capture();
  const humanOutput = capture();

  assert.equal(await runCli(["status", "--json"], { backend, io: jsonOutput.io }), 0);
  assert.equal(await runCli(["status"], { backend, io: humanOutput.io }), 0);

  const json = JSON.parse(jsonOutput.stdout[0]) as {
    current_session: { session_id: string; branch: string };
  } & Record<string, unknown>;
  assert.equal(json.current_session.session_id, sampleSession.session_id);
  assert.match(humanOutput.stdout.join("\n"), new RegExp(sampleSession.session_id));
  assert.match(humanOutput.stdout.join("\n"), new RegExp(sampleSession.branch));
  assert.match(humanOutput.stdout.join("\n"), /  current_session:\n    schema_version: 1/u);
  assert.match(humanOutput.stdout.join("\n"), /  sessions:\n    - schema_version: 1/u);
  assert.doesNotMatch(humanOutput.stdout.join("\n"), /\{"schema_version"/u);
});

test("human session create, show, and close output avoids inline structured JSON", async () => {
  for (const arguments_ of [
    ["session", "create"],
    ["session", "show"],
    ["session", "close"],
  ]) {
    const output = capture();
    const exitCode = await runCli(arguments_, { backend: backendForTests(), io: output.io });

    assert.equal(exitCode, 0);
    const text = output.stdout.join("\n");
    assert.match(text, /schema_version: 1/u);
    assert.match(text, /session_id: 0190f1e0-0000-7000-8000-000000000001/u);
    assert.doesNotMatch(text, /\{"schema_version"/u);
    assert.doesNotMatch(text, /\[object Object\]/u);
  }
});
