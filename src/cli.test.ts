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
  SessionDiagnostic,
  SessionDiagnosticOptions,
  SessionDiscardResult,
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
  assert.deepEqual(response.optional_options, ["--branch", "--worktree", "--worktree-root", "--base", "--label"]);
  assert.deepEqual(response.defaults, {
    "--branch": "nawabari/session/<session_id>",
    "--worktree": "<managed_worktree_root>/<repository>-<session_id>",
    "--worktree-root": "resolved repository-local root",
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
      "session inspect",
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
      "session discard",
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
      "--worktree-root",
      "--base",
      "--label",
      "--session",
      "--integrated-revision",
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
    session_targeting: {
      canonical: "--session <id>",
      positional_alias: "<session-id> as the first argument after a session-scoped subcommand",
      commands: ["show", "inspect", "claim", "claims", "release", "update", "close", "discard"],
      ambiguity: "supplying both positional and --session is rejected",
      discard_requires_explicit_target: true,
    },
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

// Regression (#125 dogfood): passing a visible session `label` to
// `--session` produced a bare INVALID_SESSION_ID even though the label
// uniquely identified the active record to a human. `--session` stays
// machine-ID based (the label is never accepted as identity), but a unique
// active-label match must expose the canonical session_id as a bounded,
// non-authoritative hint.
test("an invalid --session value that uniquely matches an active label exposes a canonical session_id hint", async () => {
  const labeled: SessionRecord = {
    ...sampleSession,
    session_id: "0190f1e0-0000-7000-8000-0000000000aa",
    label: "fix-lint",
  };
  const backend = backendForTests({
    getSession: async (_context, sessionId) =>
      failure(new DomainError("INVALID_SESSION_ID", `Invalid session ID: ${sessionId}`, { sessionId })),
    listSessions: async (_context) => success({ sessions: [labeled] }),
  });

  const jsonOutput = capture();
  const jsonExitCode = await runCli(["session", "show", "--session", "fix-lint", "--json"], {
    backend,
    io: jsonOutput.io,
  });
  assert.equal(jsonExitCode, 3);
  const response = JSON.parse(jsonOutput.stdout[0]) as {
    ok: boolean;
    code: string;
    details: {
      sessionId: string;
      session_label_query: string;
      session_label_match: string;
      session_id_hint: string;
      safe_actions: string[];
    };
  };
  assert.equal(response.ok, false);
  assert.equal(response.code, "INVALID_SESSION_ID");
  assert.equal(response.details.sessionId, "fix-lint");
  assert.equal(response.details.session_label_query, "fix-lint");
  assert.equal(response.details.session_label_match, "unique");
  assert.equal(response.details.session_id_hint, labeled.session_id);
  assert.deepEqual(response.details.safe_actions, ["retry-with-session-id-hint"]);

  // Human and JSON derive from the identical enriched DomainError.
  const humanOutput = capture();
  const humanExitCode = await runCli(["session", "show", "--session", "fix-lint"], { backend, io: humanOutput.io });
  assert.equal(humanExitCode, 3);
  const humanText = humanOutput.stderr.join("\n");
  assert.match(humanText, /code: INVALID_SESSION_ID/u);
  assert.match(humanText, /session_label_match: unique/u);
  assert.match(humanText, new RegExp(`session_id_hint: ${labeled.session_id}`, "u"));
});

test("ambiguous or absent label matches for an invalid --session value do not guess a session_id", async () => {
  const first: SessionRecord = { ...sampleSession, session_id: "0190f1e0-0000-7000-8000-0000000000bb", label: "dup" };
  const second: SessionRecord = { ...sampleSession, session_id: "0190f1e0-0000-7000-8000-0000000000cc", label: "dup" };
  const ambiguousBackend = backendForTests({
    getSession: async (_context, sessionId) =>
      failure(new DomainError("INVALID_SESSION_ID", `Invalid session ID: ${sessionId}`, { sessionId })),
    listSessions: async (_context) => success({ sessions: [first, second] }),
  });
  const ambiguousOutput = capture();
  const ambiguousExit = await runCli(["session", "show", "--session", "dup", "--json"], {
    backend: ambiguousBackend,
    io: ambiguousOutput.io,
  });
  assert.equal(ambiguousExit, 3);
  const ambiguousResponse = JSON.parse(ambiguousOutput.stdout[0]) as {
    details: { session_label_match: string; session_label_match_count: number; session_id_hint?: string };
  };
  assert.equal(ambiguousResponse.details.session_label_match, "ambiguous");
  assert.equal(ambiguousResponse.details.session_label_match_count, 2);
  assert.equal(ambiguousResponse.details.session_id_hint, undefined);

  const noMatchBackend = backendForTests({
    getSession: async (_context, sessionId) =>
      failure(new DomainError("INVALID_SESSION_ID", `Invalid session ID: ${sessionId}`, { sessionId })),
    listSessions: async (_context) => success({ sessions: [sampleSession] }),
  });
  const noMatchOutput = capture();
  const noMatchExit = await runCli(["session", "show", "--session", "no-such-label", "--json"], {
    backend: noMatchBackend,
    io: noMatchOutput.io,
  });
  assert.equal(noMatchExit, 3);
  const noMatchResponse = JSON.parse(noMatchOutput.stdout[0]) as {
    details: { session_label_match: string; session_id_hint?: string };
  };
  assert.equal(noMatchResponse.details.session_label_match, "none");
  assert.equal(noMatchResponse.details.session_id_hint, undefined);
});

test("session inspect forwards --session and --integrated-revision to the diagnostic backend", async () => {
  let receivedOptions: SessionDiagnosticOptions | null = null;
  const diagnosticResult: SessionDiagnostic = {
    schema_version: 1,
    session_id: sampleSession.session_id,
    repository: sampleSession.repository,
    worktree: sampleSession.worktree,
    branch: sampleSession.branch,
    session: sampleSession,
    claims: [],
    physical_state: "healthy",
    close_readiness: "ready",
    cleanup_readiness: "not_due",
    result_state: "complete",
    idempotent: false,
    blockers: [],
    safe_actions: ["close-session"],
    integration_evidence: { supplied: false },
  };
  const backend = backendForTests({
    sessionDiagnostic: async (_context: SessionContext, options: SessionDiagnosticOptions) => {
      receivedOptions = options;
      return success(diagnosticResult);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    ["session", "inspect", "--session", sampleSession.session_id, "--integrated-revision", "deadbeef", "--json"],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.deepEqual(receivedOptions, {
    session_id: sampleSession.session_id,
    integrated_revision: "deadbeef",
  });
  assert.deepEqual(JSON.parse(output.stdout[0]), {
    ok: true,
    command: "session inspect",
    ...diagnosticResult,
  });
});

test("session-scoped commands accept one consistent positional target and discard requires it", async () => {
  let discardedSessionId: string | null = null;
  const discardedResult: SessionDiscardResult = {
    schema_version: 1,
    operation: "discard",
    session: { ...sampleSession, state: "closed", terminal_operation: "discard", discarded_head: "a".repeat(40) },
    final_state: "closed",
    previous_head: "a".repeat(40),
    worktree_path: sampleSession.worktree,
    branch_name: sampleSession.branch,
    worktree_removed: true,
    branch_removed: true,
    released_claims: [],
    released_claim_count: 0,
    released_claims_truncated: false,
    idempotent: false,
  };
  const backend = backendForTests({
    discardSession: async (_context: SessionContext, sessionId: string) => {
      discardedSessionId = sessionId;
      return success(discardedResult);
    },
  });
  const output = capture();
  const positionalExit = await runCli(["session", "discard", sampleSession.session_id, "--json"], {
    backend,
    io: output.io,
  });
  assert.equal(positionalExit, 0);
  assert.equal(discardedSessionId, sampleSession.session_id);
  assert.deepEqual(JSON.parse(output.stdout[0]), { ok: true, command: "session discard", ...discardedResult });

  const missingOutput = capture();
  const missingExit = await runCli(["session", "discard", "--json"], { backend, io: missingOutput.io });
  assert.equal(missingExit, 2);
  assert.equal(JSON.parse(missingOutput.stdout[0]).code, "MISSING_ARGUMENT");

  const ambiguousOutput = capture();
  const ambiguousExit = await runCli(
    ["session", "discard", sampleSession.session_id, "--session", sampleSession.session_id, "--json"],
    { backend, io: ambiguousOutput.io },
  );
  assert.equal(ambiguousExit, 2);
  assert.equal(JSON.parse(ambiguousOutput.stdout[0]).code, "INVALID_ARGUMENT");
});

test("discard help JSON makes explicit targeting and destructive semantics discoverable", async () => {
  const output = capture();
  const exitCode = await runCli(["session", "discard", "--help", "--json"], { io: output.io });
  assert.equal(exitCode, 0);
  const response = JSON.parse(output.stdout[0]);
  assert.deepEqual(response.required_options, ["--session"]);
  assert.match(response.usage, /<session-id>\|--session <id>/u);
  assert.ok(response.notes.some((note: string) => note.includes("exactly one target form")));
});

test("all session target aliases carry the same positional session identity", async () => {
  const seen: string[] = [];
  const backend = backendForTests({
    getSession: async (_context: SessionContext, sessionId: string) => {
      seen.push(`show:${sessionId}`);
      return success(sampleSession);
    },
    sessionDiagnostic: async (_context: SessionContext, options: SessionDiagnosticOptions) => {
      seen.push(`inspect:${options.session_id}`);
      return success({
        schema_version: 1,
        session_id: sampleSession.session_id,
        repository: sampleSession.repository,
        worktree: sampleSession.worktree,
        branch: sampleSession.branch,
        session: sampleSession,
        claims: [],
        physical_state: "healthy",
        close_readiness: "ready",
        cleanup_readiness: "not_due",
        result_state: "complete",
        idempotent: false,
        blockers: [],
        safe_actions: ["close-session"],
        integration_evidence: { supplied: false },
      } satisfies SessionDiagnostic);
    },
    closeSession: async (_context: SessionContext, options) => {
      seen.push(`close:${options.session_id}`);
      return success({ session: sampleSession, worktree_removed: true, branch_removed: true });
    },
    claimResources: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      seen.push(`claim:${options.session_id}`);
      return success({ session: sampleSession, claims: [], added: [], released: [], idempotent: false });
    },
    updateClaims: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      seen.push(`update:${options.session_id}`);
      return success({ session: sampleSession, claims: [], added: [], released: [], idempotent: false });
    },
    listClaims: async (_context: SessionContext, sessionId: string | null) => {
      seen.push(`claims:${sessionId}`);
      return success({ claims: [] });
    },
    releaseClaims: async (_context: SessionContext, options) => {
      seen.push(`release:${options.session_id}`);
      return success({ session_id: options.session_id ?? "", released: [], remaining: [], idempotent: false });
    },
  });
  const commands = [
    ["session", "show", sampleSession.session_id, "--json"],
    ["session", "inspect", sampleSession.session_id, "--json"],
    ["session", "claim", sampleSession.session_id, "--resource", "a.txt", "--mode", "read", "--json"],
    ["session", "update", sampleSession.session_id, "--resource", "a.txt", "--mode", "read", "--json"],
    ["session", "claims", sampleSession.session_id, "--json"],
    ["session", "release", sampleSession.session_id, "--json"],
    ["session", "close", sampleSession.session_id, "--json"],
  ];
  for (const command of commands) {
    const output = capture();
    assert.equal(await runCli(command, { backend, io: output.io }), 0, output.stderr.join("\n"));
  }
  assert.deepEqual(seen, [
    `show:${sampleSession.session_id}`,
    `inspect:${sampleSession.session_id}`,
    `claim:${sampleSession.session_id}`,
    `update:${sampleSession.session_id}`,
    `claims:${sampleSession.session_id}`,
    `release:${sampleSession.session_id}`,
    `close:${sampleSession.session_id}`,
  ]);
});

test("session inspect fails closed with BACKEND_UNAVAILABLE when the backend does not implement diagnostics", async () => {
  const backend = backendForTests();
  const output = capture();
  const exitCode = await runCli(["session", "inspect", "--json"], { backend, io: output.io });

  assert.equal(exitCode, 4);
  const response = JSON.parse(output.stdout[0]) as { ok: boolean; code: string; command: string };
  assert.equal(response.ok, false);
  assert.equal(response.code, "BACKEND_UNAVAILABLE");
  assert.equal(response.command, "session inspect");
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

test("session create rejects --worktree combined with --worktree-root before touching the backend", async () => {
  let backendCalled = false;
  const backend = backendForTests({
    createSession: async (_context: SessionContext, _options: SessionCreateOptions) => {
      backendCalled = true;
      return success(sampleSession);
    },
  });

  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "create", "--worktree", "/tmp/exact", "--worktree-root", "/tmp/root"],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(backendCalled, false);
});

test("session create forwards --worktree-root to the backend as the caller-selected root", async () => {
  let observedOptions: SessionCreateOptions | null = null;
  const backend = backendForTests({
    createSession: async (_context: SessionContext, options: SessionCreateOptions) => {
      observedOptions = options;
      return success(sampleSession);
    },
  });

  const exitCode = await runCli(["--json", "session", "create", "--worktree-root", "/managed/root"], {
    backend,
    io: capture().io,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(observedOptions, {
    branch: null,
    worktree: null,
    worktree_root: "/managed/root",
    base: null,
    label: null,
  });
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

test("session update fails closed when --session interrupts a pending --resource before its --mode", async () => {
  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "update", "--resource", "src/a.ts", "--session", sampleSession.session_id, "--mode", "write"],
    { backend: backendForTests(), io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string; details: { option: string } };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(response.details.option, "--session");
});

test("session update fails closed when --repository interrupts a pending --resource before its --mode", async () => {
  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "update", "--resource", "src/a.ts", "--repository", "/tmp/repo", "--mode", "write"],
    { backend: backendForTests(), io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string; details: { option: string } };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(response.details.option, "--repository");
});

test("session update accepts --session/--repository placed outside a pending --resource/--mode pair", async () => {
  let observedOptions: ClaimResourcesOptions | null = null;
  const claims = [sampleClaim("src/a.ts", "write")];
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
      "session",
      "update",
      "--session",
      sampleSession.session_id,
      "--repository",
      "/tmp/repo",
      "--resource",
      "src/a.ts",
      "--mode",
      "write",
    ],
    { backend, io: capture().io },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: "/tmp/repo",
    claims: [{ resource: "src/a.ts", mode: "write" }],
  });
});

test("session claim submits exactly one --resource/--mode pair", async () => {
  let observedOptions: ClaimResourcesOptions | null = null;
  const claims = [sampleClaim("src/a.ts", "write")];
  const result: ClaimResourcesResult = {
    session: sampleSession,
    claims,
    added: claims,
    released: [],
    idempotent: false,
  };
  const backend = backendForTests({
    claimResources: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      observedOptions = options;
      return success(result);
    },
  });

  const exitCode = await runCli(
    ["--json", "session", "claim", "--session", sampleSession.session_id, "--resource", "src/a.ts", "--mode", "write"],
    { backend, io: capture().io },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: null,
    claims: [{ resource: "src/a.ts", mode: "write" }],
  });
});

test("session claim rejects a second --resource/--mode pair instead of silently taking the last one", async () => {
  let claimResourcesCalled = false;
  const backend = backendForTests({
    claimResources: async () => {
      claimResourcesCalled = true;
      return success({
        session: sampleSession,
        claims: [],
        added: [],
        released: [],
        idempotent: false,
      } as ClaimResourcesResult);
    },
  });

  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "claim",
      "--resource",
      "src/a.ts",
      "--mode",
      "read",
      "--resource",
      "src/b.ts",
      "--mode",
      "write",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string; details: { pair_count: number } };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(response.details.pair_count, 2);
  assert.equal(claimResourcesCalled, false, "the backend must never see a silently-collapsed multi-pair claim");
});

test("resource claim alias rejects a second --resource/--mode pair instead of silently taking the last one", async () => {
  let claimResourcesCalled = false;
  const backend = backendForTests({
    claimResources: async () => {
      claimResourcesCalled = true;
      return success({
        session: sampleSession,
        claims: [],
        added: [],
        released: [],
        idempotent: false,
      } as ClaimResourcesResult);
    },
  });

  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "resource",
      "claim",
      "--resource",
      "src/a.ts",
      "--mode",
      "read",
      "--resource",
      "src/b.ts",
      "--mode",
      "write",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string };
  assert.equal(response.code, "INVALID_ARGUMENT");
  assert.equal(claimResourcesCalled, false, "the backend must never see a silently-collapsed multi-pair claim");
});

test("session claim rejects a --mode supplied before its --resource", async () => {
  const output = capture();
  const exitCode = await runCli(["--json", "session", "claim", "--mode", "write", "--resource", "src/a.ts"], {
    backend: backendForTests(),
    io: output.io,
  });

  assert.equal(exitCode, 2);
  const response = JSON.parse(output.stdout[0]) as { code: string };
  assert.equal(response.code, "INVALID_ARGUMENT");
});

test("session claim still requires both --resource and --mode", async () => {
  const missingMode = capture();
  const missingModeExit = await runCli(
    ["--json", "session", "claim", "--session", sampleSession.session_id, "--resource", "src/a.ts"],
    { backend: backendForTests(), io: missingMode.io },
  );
  assert.equal(missingModeExit, 2);
  assert.equal((JSON.parse(missingMode.stdout[0]) as { code: string }).code, "MISSING_ARGUMENT");

  const missingResource = capture();
  const missingResourceExit = await runCli(["--json", "session", "claim", "--mode", "write"], {
    backend: backendForTests(),
    io: missingResource.io,
  });
  assert.equal(missingResourceExit, 2);
  assert.equal((JSON.parse(missingResource.stdout[0]) as { code: string }).code, "INVALID_ARGUMENT");
});

test("resource update --help exposes the same option contract as session update", async () => {
  const sessionOutput = capture();
  await runCli(["session", "update", "--help", "--json"], { io: sessionOutput.io });
  const resourceOutput = capture();
  await runCli(["resource", "update", "--help", "--json"], { io: resourceOutput.io });

  const sessionHelp = JSON.parse(sessionOutput.stdout[0]) as {
    options: Array<{ name: string }>;
    optional_options: string[];
  };
  const resourceHelp = JSON.parse(resourceOutput.stdout[0]) as {
    help_for: string;
    options: Array<{ name: string }>;
    optional_options: string[];
  };

  assert.equal(resourceHelp.help_for, "resource update");
  assert.deepEqual(
    resourceHelp.options.map((option) => option.name).sort(),
    sessionHelp.options.map((option) => option.name).sort(),
  );
  assert.ok(resourceHelp.options.some((option) => option.name === "--session"));
  assert.ok(resourceHelp.options.some((option) => option.name === "--repository"));
  assert.ok(resourceHelp.optional_options.includes("--session"));
  assert.ok(resourceHelp.optional_options.includes("--repository"));
});

test("capabilities --json exposes a machine-readable multi-claim replacement contract", async () => {
  const output = capture();
  const exitCode = await runCli(["capabilities", "--json"], { io: output.io });

  assert.equal(exitCode, 0);
  const response = JSON.parse(output.stdout[0]) as {
    capabilities: Array<{
      id: string;
      commands: string[];
      claim_set_replacement?: {
        commands: string[];
        atomic: boolean;
        pairing: string;
        idempotent_retry: boolean;
        unchanged_on_rejection: boolean;
      };
    }>;
  };

  const resourceClaims = response.capabilities.find((capability) => capability.id === "resource-claims");
  assert.ok(resourceClaims, "resource-claims capability must be discoverable");
  assert.deepEqual(resourceClaims?.claim_set_replacement, {
    commands: ["session update", "resource update"],
    atomic: true,
    pairing: "adjacent-resource-mode",
    idempotent_retry: true,
    unchanged_on_rejection: true,
  });

  const lifecycle = response.capabilities.find((capability) => capability.id === "session-lifecycle");
  assert.ok(lifecycle, "session-lifecycle capability must be discoverable");
  assert.equal("claim_set_replacement" in lifecycle, false);
  const discard = response.capabilities.find((capability) => capability.id === "session-discard");
  assert.ok(discard, "session-discard capability must be discoverable");
  assert.ok(discard?.commands.includes("session discard"));
});
