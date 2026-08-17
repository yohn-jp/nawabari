import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { DomainError, failure, success } from "./domain/errors.js";
import type {
  ClaimResourcesOptions,
  ClaimResourcesResult,
  ResourceClaim,
  SessionBackend,
  SessionCloseResult,
  SessionContext,
  SessionCreateOptions,
  SessionRecord,
} from "./domain/session.js";
import { unavailableCapabilities } from "./domain/session.js";
import { discoverSandboxRuntimeLayout } from "./domain/sandbox.js";
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

  assert.equal(exitCode, 0, output.stderr.join("\\n") || output.stdout.join("\\n"));
  assert.match(output.stdout.join("\n"), /Usage: nawabari/);
  assert.equal(output.stderr.length, 0);
});

test("session run resolves the existing session authority and preserves command argv after --", async () => {
  const output = capture();
  let observedCommand: string[] = [];
  const exitCode = await runCli(
    ["--json", "session", "run", "--session", sampleSession.session_id, "--", "printf", "--json"],
    {
      cwd: sampleSession.worktree,
      backend: backendForTests(),
      io: output.io,
      sandboxProbe: {
        platform: () => "linux",
        uid: () => 1000,
        gid: () => 1000,
        hasBubblewrap: () => true,
        hasNamespaceSupport: () => true,
        hasCgroupsV2: () => false,
        hasLandlock: () => false,
        hasSeccomp: () => true,
        hasCapabilities: () => true,
      },
      sandboxRuntimeLayout: discoverSandboxRuntimeLayout(),
      sandboxRunner: async (_request, command) => {
        observedCommand = [command.command, ...(command.args ?? [])];
        return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 });
      },
    },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n") || output.stdout.join("\n"));
  assert.deepEqual(observedCommand, ["printf", "--json"]);
  assert.deepEqual(JSON.parse(output.stdout[0] ?? ""), {
    ok: true,
    command: "session run",
    exit_code: 0,
    signal: null,
    stdout: "ok",
    stderr: "",
    duration_ms: 1,
  });
});

test("session run does not interpret a child --json argument as a Nawabari global option", async () => {
  const output = capture();
  const exitCode = await runCli(["session", "run", "--session", sampleSession.session_id, "--", "printf", "--json"], {
    cwd: sampleSession.worktree,
    backend: backendForTests(),
    io: output.io,
    sandboxProbe: {
      platform: () => "linux",
      uid: () => 1000,
      gid: () => 1000,
      hasBubblewrap: () => true,
      hasNamespaceSupport: () => true,
      hasCgroupsV2: () => false,
      hasLandlock: () => false,
      hasSeccomp: () => true,
      hasCapabilities: () => true,
    },
    sandboxRuntimeLayout: discoverSandboxRuntimeLayout(),
    sandboxRunner: async (_request, command) => {
      assert.deepEqual([command.command, ...(command.args ?? [])], ["printf", "--json"]);
      return success({ exit_code: 0, signal: null, stdout: "ok", stderr: "", duration_ms: 1 });
    },
  });

  assert.equal(exitCode, 0, output.stderr.join("\n") || output.stdout.join("\n"));
  assert.match(output.stdout[0] ?? "", /^session run: ok/);
});

test("command-specific help is projected from one spec and marks session create options accurately", async () => {
  const output = capture();
  const exitCode = await runCli(["session", "create", "--help", "--json"], { io: output.io });

  assert.equal(exitCode, 0);
  const response = JSON.parse(output.stdout[0] ?? "") as {
    command: string;
    help_for: string;
    required_options: string[];
    optional_options: string[];
    defaults: Record<string, string>;
    options: Array<{ name: string; required: boolean; default?: string; description?: string }>;
  };
  assert.equal(response.command, "help");
  assert.equal(response.help_for, "session create");
  assert.deepEqual(response.required_options, []);
  assert.deepEqual(response.optional_options, ["--branch", "--worktree", "--base", "--label"]);
  assert.deepEqual(response.defaults, {
    "--branch": "nawabari/session/<session_id>",
    "--worktree": "<managed_worktree_root>/<repository>-<session_id>",
    "--base": "HEAD",
    "--label": "omitted",
  });
  assert.equal(
    response.options.every((option) => option.required === false),
    true,
  );
  const worktreeOption = response.options.find((option) => option.name === "--worktree");
  assert.ok(worktreeOption, "--worktree option should exist");
  assert.equal(worktreeOption.default, "<managed_worktree_root>/<repository>-<session_id>");
  assert.match(worktreeOption.description ?? "", /worktree/iu);
});

test("resource list help displays only resource-list options and does not inherit session-list options", async () => {
  const output = capture();
  const exitCode = await runCli(["resource", "list", "--help", "--json"], { io: output.io });

  assert.equal(exitCode, 0);
  const response = JSON.parse(output.stdout[0] ?? "") as {
    command: string;
    help_for: string;
    optional_options: string[];
    options: Array<{ name: string }>;
  };
  assert.equal(response.command, "help");
  assert.equal(response.help_for, "resource list");
  assert.ok(response.optional_options.includes("--session"));
  assert.ok(!response.optional_options.includes("--all"), "resource list should not advertise --all");
  assert.ok(!response.optional_options.includes("--history"), "resource list should not advertise --history");
  assert.ok(response.options.some((option) => option.name === "--session"));
  assert.ok(!response.options.some((option) => option.name === "--all"));
  assert.ok(!response.options.some((option) => option.name === "--history"));
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
      "session run",
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
      "evidence snapshot",
      "diff",
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
      "--repository",
      "--claim-id",
    ],
    authorization_options: ["--session", "--operation", "--resource"],
    checkpoint_options: ["--session"],
    commit_options: ["--session", "--message", "--resource", "--message-pattern"],
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
      dependencies: {
        mottainai: boolean;
        github: boolean;
        gh: boolean;
        network: boolean;
        local_git: boolean;
        llm: boolean;
        agent_runtime: boolean;
      };
      capabilities: Array<{ id: string; commands: string[]; failure_codes: string[] }>;
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
    const lifecycle = response.capabilities.find((capability) => capability.commands.includes("session create"));
    assert.ok(lifecycle?.failure_codes.includes("INVALID_SESSION_ID"));
    assert.ok(lifecycle?.failure_codes.includes("INVALID_BASE_REF"));
    const authorization = response.capabilities.find((capability) => capability.commands.includes("authorize"));
    assert.ok(authorization?.failure_codes.includes("INSUFFICIENT_CLAIM_MODE"));
    const evidence = response.capabilities.find((capability) => capability.commands.includes("evidence snapshot"));
    assert.ok(evidence?.commands.includes("diff"));
    assert.ok(evidence?.failure_codes.includes("GIT_OUTPUT_LIMIT"));
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

function sampleClaim(resource: string, mode: "read" | "write" | "exclusive-write"): ResourceClaim {
  return {
    schema_version: 2,
    claim_id: `claim-${resource}-${mode}`,
    session_id: sampleSession.session_id,
    repository: sampleSession.repository,
    worktree: sampleSession.worktree,
    resource,
    mode,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
  };
}

test("session update submits one atomic claims[] transaction built from repeated --resource/--mode pairs", async () => {
  let observedOptions: ClaimResourcesOptions | null = null;
  const claims = [sampleClaim("src/a.ts", "exclusive-write"), sampleClaim("src/b.ts", "exclusive-write")];
  const result: ClaimResourcesResult = {
    session: sampleSession,
    claims,
    added: claims,
    released: [],
    idempotent: false,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      observedOptions = options;
      return success(result);
    },
  });

  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "update",
      "--session",
      sampleSession.session_id,
      "--resource",
      "src/a.ts",
      "--mode",
      "exclusive-write",
      "--resource",
      "src/b.ts",
      "--mode",
      "exclusive-write",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n") || output.stdout.join("\n"));
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: null,
    claims: [
      { resource: "src/a.ts", mode: "exclusive-write" },
      { resource: "src/b.ts", mode: "exclusive-write" },
    ],
  });
  const response = JSON.parse(output.stdout[0]) as { claims: ResourceClaim[] };
  assert.equal(response.claims.length, 2);
});

test("resource update alias submits the same multi-claim transaction as session update", async () => {
  let observedOptions: ClaimResourcesOptions | null = null;
  const claims = [sampleClaim("src/a.ts", "read"), sampleClaim("src/b.ts", "write")];
  const result: ClaimResourcesResult = {
    session: sampleSession,
    claims,
    added: claims,
    released: [],
    idempotent: false,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      observedOptions = options;
      return success(result);
    },
  });

  const exitCode = await runCli(
    [
      "--json",
      "resource",
      "update",
      "--resource",
      "src/a.ts",
      "--mode",
      "read",
      "--resource",
      "src/b.ts",
      "--mode",
      "write",
    ],
    { backend, io: capture().io },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(observedOptions, {
    session_id: null,
    repository: null,
    claims: [
      { resource: "src/a.ts", mode: "read" },
      { resource: "src/b.ts", mode: "write" },
    ],
  });
});

test("session update rejects a conflicting desired claim set without touching the backend twice", async () => {
  const backend = backendForTests({
    updateClaims: async () =>
      failure(
        new DomainError("CONTRADICTORY_CLAIM", "Request contains overlapping claims with different modes", {
          resource: "src/a.ts",
        }),
      ),
  });

  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "update",
      "--session",
      sampleSession.session_id,
      "--resource",
      "src/a.ts",
      "--mode",
      "write",
      "--resource",
      "src/a.ts",
      "--mode",
      "exclusive-write",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 3);
  const response = JSON.parse(output.stdout[0]) as { ok: boolean; code: string };
  assert.deepEqual(response, {
    ok: false,
    command: "session update",
    code: "CONTRADICTORY_CLAIM",
    message: "Request contains overlapping claims with different modes",
    details: { resource: "src/a.ts" },
  });
});

test("session update requires at least one --resource/--mode pair", async () => {
  const output = capture();
  const exitCode = await runCli(["--json", "session", "update", "--session", sampleSession.session_id], {
    backend: backendForTests(),
    io: output.io,
  });

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string };
  assert.equal(response.code, "MISSING_ARGUMENT");
});

test("session update rejects a --resource that is not immediately followed by its own --mode", async () => {
  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "update", "--resource", "src/a.ts", "--resource", "src/b.ts", "--mode", "write"],
    { backend: backendForTests(), io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string; details: { option: string } };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(response.details.option, "--resource");
});

test("session update rejects a --mode that is not immediately preceded by its own --resource", async () => {
  const output = capture();
  const exitCode = await runCli(["--json", "session", "update", "--mode", "write", "--resource", "src/a.ts"], {
    backend: backendForTests(),
    io: output.io,
  });

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string; details: { option: string } };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(response.details.option, "--mode");
});

test("session update rejects a trailing --resource left without a matching --mode", async () => {
  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "update", "--resource", "src/a.ts", "--mode", "write", "--resource", "src/b.ts"],
    { backend: backendForTests(), io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string };
  assert.equal(response.code, "MISSING_ARGUMENT");
});
