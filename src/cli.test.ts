import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runCli } from "./cli.js";
import { DomainError, failure, success } from "./domain/errors.js";
import type {
  ClaimDeltasOptions,
  ClaimDeltasResult,
  ClaimResourcesOptions,
  ClaimResourcesResult,
  ReleaseClaimsOptions,
  ReleaseClaimsResult,
  ResourceClaim,
  SessionBackend,
  SessionCloseOptions,
  SessionCloseResult,
  SessionContext,
  SessionCreateOptions,
  SessionDiagnostic,
  SessionDiagnosticOptions,
  SessionDiscardResult,
  SessionRecord,
  UpdateClaimsOptions,
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
    claim_set_generation: 0,
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
      "session mutate",
      "session transition",
      "session claims",
      "session release",
      "resource claim",
      "resource update",
      "resource mutate",
      "resource transition",
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
      "--if-generation",
      "--force",
      "--upsert-resource",
      "--release-resource",
      "--claim-id",
      "--fetch-remote",
      "--fetch-branch",
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
      commands: ["show", "inspect", "claim", "claims", "release", "update", "mutate", "transition", "close", "discard"],
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

test("session close forwards explicit integration fetch metadata and rejects incomplete fetch options", async () => {
  let receivedOptions: SessionCloseOptions | null = null;
  let closeCalls = 0;
  const backend = backendForTests({
    closeSession: async (_context: SessionContext, options: SessionCloseOptions) => {
      closeCalls += 1;
      receivedOptions = options;
      return success({ session: sampleSession, worktree_removed: true, branch_removed: true, claim_set_generation: 0 });
    },
  });
  const output = capture();
  const integratedRevision = "a".repeat(40);
  const exitCode = await runCli(
    [
      "session",
      "close",
      "--session",
      sampleSession.session_id,
      "--integrated-revision",
      integratedRevision,
      "--fetch-remote",
      "origin",
      "--fetch-branch",
      "main",
      "--json",
    ],
    { backend, io: output.io },
  );
  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.deepEqual(receivedOptions, {
    session_id: sampleSession.session_id,
    integrated_revision: integratedRevision,
    fetch_remote: "origin",
    fetch_branch: "main",
  });

  const incompleteOutput = capture();
  const incompleteExitCode = await runCli(["session", "close", "--fetch-remote", "origin", "--json"], {
    backend,
    io: incompleteOutput.io,
  });
  assert.equal(incompleteExitCode, 2);
  assert.equal(closeCalls, 1);
  assert.equal(JSON.parse(incompleteOutput.stdout[0]).code, "INVALID_ARGUMENT");
});

test("session close help distinguishes provider APIs from explicit Git remote fetch", async () => {
  const output = capture();
  const exitCode = await runCli(["session", "close", "--help", "--json"], { io: output.io });

  assert.equal(exitCode, 0);
  const response = JSON.parse(output.stdout[0] ?? "") as { notes: string[] };
  assert.ok(response.notes.some((note) => note.includes("never calls provider APIs")));
  assert.ok(response.notes.some((note) => note.includes("only explicit --fetch-remote/--fetch-branch")));
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
    claim_set_generation: 0,
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
      return success({ session: sampleSession, worktree_removed: true, branch_removed: true, claim_set_generation: 0 });
    },
    claimResources: async (_context: SessionContext, options: ClaimResourcesOptions) => {
      seen.push(`claim:${options.session_id}`);
      return success({
        session: sampleSession,
        claims: [],
        added: [],
        released: [],
        idempotent: false,
        claim_set_generation: 0,
      });
    },
    updateClaims: async (_context: SessionContext, options: UpdateClaimsOptions) => {
      seen.push(`update:${options.session_id}`);
      return success({
        session: sampleSession,
        claims: [],
        added: [],
        released: [],
        idempotent: false,
        claim_set_generation: 0,
      });
    },
    listClaims: async (_context: SessionContext, sessionId: string | null) => {
      seen.push(`claims:${sessionId}`);
      return success({ claims: [], claim_set_generation: 0 });
    },
    releaseClaims: async (_context: SessionContext, options) => {
      seen.push(`release:${options.session_id}`);
      return success({
        session_id: options.session_id ?? "",
        released: [],
        remaining: [],
        idempotent: false,
        claim_set_generation: 0,
      });
    },
  });
  const commands = [
    ["session", "show", sampleSession.session_id, "--json"],
    ["session", "inspect", sampleSession.session_id, "--json"],
    ["session", "claim", sampleSession.session_id, "--resource", "a.txt", "--mode", "read", "--json"],
    ["session", "update", sampleSession.session_id, "--resource", "a.txt", "--mode", "read", "--force", "--json"],
    ["session", "claims", sampleSession.session_id, "--json"],
    ["session", "release", sampleSession.session_id, "--all", "--force", "--json"],
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
    claim_set_generation: 0,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: UpdateClaimsOptions) => {
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
      "--force",
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
    force: true,
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
    claim_set_generation: 0,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: UpdateClaimsOptions) => {
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
      "--force",
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
    force: true,
  });
});

test("session mutate submits mixed ordered deltas in exactly one backend call", async () => {
  let invocations = 0;
  let observedOptions: ClaimDeltasOptions | null = null;
  const added = sampleClaim("src/a.ts", "read");
  const released = sampleClaim("src/old.ts", "write");
  const result: ClaimDeltasResult = {
    session: sampleSession,
    claims: [added],
    previous_claim_set_generation: 7,
    claim_set_generation: 8,
    added: [added],
    changed: [],
    released: [released],
    unchanged: [],
    idempotent: false,
  };
  const backend = backendForTests({
    applyClaimDeltas: async (_context: SessionContext, options: ClaimDeltasOptions) => {
      invocations += 1;
      observedOptions = options;
      return success(result);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "mutate",
      sampleSession.session_id,
      "--repository",
      sampleSession.repository,
      "--upsert-resource",
      "src/a.ts",
      "--mode",
      "read",
      "--release-resource",
      "src/old.ts",
      "--upsert-resource",
      "src/c.ts",
      "--mode",
      "exclusive-write",
      "--if-generation",
      "7",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n") || output.stdout.join("\n"));
  assert.equal(invocations, 1);
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: sampleSession.repository,
    deltas: [
      { kind: "upsert", resource: "src/a.ts", mode: "read" },
      { kind: "release", resource: "src/old.ts" },
      { kind: "upsert", resource: "src/c.ts", mode: "exclusive-write" },
    ],
    expected_claim_set_generation: 7,
  });
  const response = JSON.parse(output.stdout[0] ?? "") as ClaimDeltasResult & { command: string; ok: boolean };
  assert.equal(response.ok, true);
  assert.equal(response.command, "session mutate");
  assert.equal(response.claim_set_generation, 8);
});

test("resource mutate alias preserves the same delta semantics and force intent", async () => {
  let observedOptions: ClaimDeltasOptions | null = null;
  const backend = backendForTests({
    applyClaimDeltas: async (_context: SessionContext, options: ClaimDeltasOptions) => {
      observedOptions = options;
      return success({
        session: sampleSession,
        claims: [],
        previous_claim_set_generation: 0,
        claim_set_generation: 0,
        added: [],
        changed: [],
        released: [],
        unchanged: [{ kind: "release", resource: "src/a.ts" }],
        idempotent: true,
      } satisfies ClaimDeltasResult);
    },
  });
  const output = capture();
  const exitCode = await runCli(["--json", "resource", "mutate", "--release-resource", "src/a.ts", "--force"], {
    backend,
    io: output.io,
  });

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.deepEqual(observedOptions, {
    session_id: null,
    repository: null,
    deltas: [{ kind: "release", resource: "src/a.ts" }],
    force: true,
  });
  assert.equal((JSON.parse(output.stdout[0] ?? "") as { command: string }).command, "resource mutate");
});

test("session transition submits exactly one upsert delta and projects the typed result", async () => {
  let invocations = 0;
  let observedOptions: ClaimDeltasOptions | null = null;
  const changed = {
    resource: "src/a.ts",
    before: sampleClaim("src/a.ts", "read"),
    after: sampleClaim("src/a.ts", "write"),
  };
  const result: ClaimDeltasResult = {
    session: sampleSession,
    claims: [changed.after],
    previous_claim_set_generation: 7,
    claim_set_generation: 8,
    added: [],
    changed: [changed],
    released: [],
    unchanged: [],
    idempotent: false,
  };
  const backend = backendForTests({
    applyClaimDeltas: async (_context: SessionContext, options: ClaimDeltasOptions) => {
      invocations += 1;
      observedOptions = options;
      return success(result);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "transition",
      sampleSession.session_id,
      "--repository",
      sampleSession.repository,
      "--resource",
      "src/a.ts",
      "--mode",
      "write",
      "--if-generation",
      "7",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n") || output.stdout.join("\n"));
  assert.equal(invocations, 1);
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: sampleSession.repository,
    deltas: [{ kind: "upsert", resource: "src/a.ts", mode: "write" }],
    expected_claim_set_generation: 7,
  });
  const response = JSON.parse(output.stdout[0] ?? "") as ClaimDeltasResult & { command: string; ok: boolean };
  assert.equal(response.ok, true);
  assert.equal(response.command, "session transition");
  assert.deepEqual(response.changed, [changed]);
});

test("resource transition alias preserves force intent and canonical delta projection", async () => {
  let observedOptions: ClaimDeltasOptions | null = null;
  const backend = backendForTests({
    applyClaimDeltas: async (_context: SessionContext, options: ClaimDeltasOptions) => {
      observedOptions = options;
      return success({
        session: sampleSession,
        claims: [sampleClaim("README.md", "exclusive-write")],
        previous_claim_set_generation: 2,
        claim_set_generation: 3,
        added: [sampleClaim("README.md", "exclusive-write")],
        changed: [],
        released: [],
        unchanged: [],
        idempotent: false,
      } satisfies ClaimDeltasResult);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    ["--json", "resource", "transition", "--resource", "README.md", "--mode", "exclusive-write", "--force"],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.deepEqual(observedOptions, {
    session_id: null,
    repository: null,
    deltas: [{ kind: "upsert", resource: "README.md", mode: "exclusive-write" }],
    force: true,
  });
  const response = JSON.parse(output.stdout[0] ?? "") as { command: string; claims: ResourceClaim[] };
  assert.equal(response.command, "resource transition");
  assert.equal(response.claims[0]?.mode, "exclusive-write");
});

test("session transition accepts every public target mode", async () => {
  const observedModes: string[] = [];
  const backend = backendForTests({
    applyClaimDeltas: async (_context: SessionContext, options: ClaimDeltasOptions) => {
      const delta = options.deltas[0];
      if (delta?.kind === "upsert") observedModes.push(delta.mode);
      return success({
        session: sampleSession,
        claims: [],
        previous_claim_set_generation: observedModes.length - 1,
        claim_set_generation: observedModes.length,
        added: [],
        changed: [],
        released: [],
        unchanged: [],
        idempotent: false,
      } satisfies ClaimDeltasResult);
    },
  });

  for (const mode of ["read", "write", "exclusive-write"] as const) {
    const output = capture();
    const exitCode = await runCli(
      ["--json", "session", "transition", "--resource", "target.txt", "--mode", mode, "--force"],
      { backend, io: output.io },
    );
    assert.equal(exitCode, 0, output.stderr.join("\n"));
  }
  assert.deepEqual(observedModes, ["read", "write", "exclusive-write"]);
});

test("claim transition rejects malformed pair/concurrency grammar before backend invocation", async () => {
  let invocations = 0;
  const backend = backendForTests({
    applyClaimDeltas: async () => {
      invocations += 1;
      return failure(new DomainError("INTERNAL_ERROR", "backend should not be called"));
    },
  });
  const invalidCommands = [
    ["--resource", "src/a.ts", "--mode", "write"],
    ["--resource", "src/a.ts", "--mode", "write", "--force", "--if-generation", "1"],
    ["--resource", "src/a.ts", "--mode", "write", "--if-generation", "1", "--if-generation", "2"],
    ["--resource", "src/a.ts", "--mode", "write", "--force", "--force"],
    ["--mode", "write", "--resource", "src/a.ts", "--force"],
    ["--resource", "src/a.ts", "--repository", sampleSession.repository, "--mode", "write", "--force"],
    ["--resource", "src/a.ts", "--mode", "invalid", "--force"],
    ["--resource", "src/a.ts", "--mode", "write", "--resource", "src/b.ts", "--mode", "read", "--force"],
    ["--resource", "src/a.ts", "--session", sampleSession.session_id, "--mode", "write", "--force"],
    ["--resource", "src/a.ts", "--mode", "write", "--if-generation", "9007199254740992"],
  ];

  for (const arguments_ of invalidCommands) {
    const output = capture();
    const exitCode = await runCli(["--json", "session", "transition", ...arguments_], {
      backend,
      io: output.io,
    });
    assert.equal(exitCode, 2, arguments_.join(" "));
    const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; code: string };
    assert.equal(response.ok, false);
    assert.ok(["INVALID_ARGUMENT", "MISSING_ARGUMENT"].includes(response.code));
  }
  assert.equal(invocations, 0);
});

test("transition human and JSON help stay in parity for canonical and alias commands", async () => {
  const human = capture();
  const canonicalJson = capture();
  const aliasJson = capture();
  assert.equal(await runCli(["session", "transition", "--help"], { io: human.io }), 0);
  assert.equal(await runCli(["--json", "session", "transition", "--help"], { io: canonicalJson.io }), 0);
  assert.equal(await runCli(["--json", "resource", "transition", "--help"], { io: aliasJson.io }), 0);
  assert.match(human.stdout.join("\n"), /--resource <path-or-glob>.*--mode <read\|write\|exclusive-write>/su);
  assert.match(human.stdout.join("\n"), /--if-generation <non-negative-safe-int>/u);
  const canonical = JSON.parse(canonicalJson.stdout[0] ?? "") as {
    help_for: string;
    usage: string;
    options: Array<{ name: string }>;
    notes: string[];
  };
  const alias = JSON.parse(aliasJson.stdout[0] ?? "") as typeof canonical;
  assert.equal(canonical.help_for, "session transition");
  assert.equal(alias.help_for, "resource transition");
  assert.deepEqual(
    alias.options.map((candidate) => candidate.name),
    canonical.options.map((candidate) => candidate.name),
  );
  assert.equal(alias.usage.replace("resource transition", "session transition"), canonical.usage);
  assert.match(canonical.notes.join("\n"), /exactly one resource\/mode pair/iu);
});

test("claim delta malformed grammar and concurrency ambiguity fail before backend", async () => {
  let invocations = 0;
  const backend = backendForTests({
    applyClaimDeltas: async () => {
      invocations += 1;
      return failure(new DomainError("INTERNAL_ERROR", "backend should not be called"));
    },
  });
  const invalidCommands = [
    ["--upsert-resource", "src/a.ts", "--force"],
    ["--upsert-resource", "src/a.ts", "--session", sampleSession.session_id, "--mode", "read", "--force"],
    ["--upsert-resource", "src/a.ts", "--repository", sampleSession.repository, "--mode", "read", "--force"],
    ["--upsert-resource", "src/a.ts", "--if-generation", "1", "--mode", "read"],
    ["--mode", "read", "--release-resource", "src/a.ts", "--force"],
    ["--release-resource", "src/a.ts"],
    ["--upsert-resource", "src/a.ts", "--mode", "read"],
    ["--release-resource", "src/a.ts", "--force", "--force"],
    ["--release-resource", "src/a.ts", "--if-generation", "1", "--force"],
    ["--release-resource", "src/a.ts", "--if-generation", "1", "--if-generation", "2"],
    ["--upsert-resource", "src/a.ts", "--mode", "invalid", "--force"],
    ["--release-resource", "src/a.ts", "--if-generation", "not-an-integer"],
    ["--release-resource", "src/a.ts", "--if-generation", "-1"],
    ["--release-resource", "src/a.ts", "--if-generation", "9007199254740992"],
    ["--release-resource", "src/a.ts", "--force=unexpected"],
  ];

  for (const arguments_ of invalidCommands) {
    const output = capture();
    const exitCode = await runCli(["--json", "session", "mutate", ...arguments_], { backend, io: output.io });
    assert.equal(exitCode, 2, arguments_.join(" "));
    const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; code: string };
    assert.equal(response.ok, false);
    assert.ok(["INVALID_ARGUMENT", "MISSING_ARGUMENT"].includes(response.code));
  }
  assert.equal(invocations, 0);
});

test("claim delta backend unavailability is fail-closed after valid parsing", async () => {
  const output = capture();
  const exitCode = await runCli(["--json", "session", "mutate", "--release-resource", "src/a.ts", "--force"], {
    backend: backendForTests(),
    io: output.io,
  });
  assert.equal(exitCode, 4);
  const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; code: string; command: string };
  assert.deepEqual(response, {
    ok: false,
    command: "session mutate",
    code: "BACKEND_UNAVAILABLE",
    message: "Resource claim capability is not available.",
    details: { operation: "session mutate" },
  });
});

test("claim delta human and JSON help expose the same grammar for canonical and alias commands", async () => {
  const human = capture();
  const json = capture();
  const aliasJson = capture();
  assert.equal(await runCli(["session", "mutate", "--help"], { io: human.io }), 0);
  assert.equal(await runCli(["--json", "session", "mutate", "--help"], { io: json.io }), 0);
  assert.equal(await runCli(["--json", "resource", "mutate", "--help"], { io: aliasJson.io }), 0);
  const humanText = human.stdout.join("\n");
  assert.match(humanText, /--upsert-resource <path-or-glob>/u);
  assert.match(humanText, /--release-resource <path-or-glob>/u);
  assert.match(humanText, /--if-generation <non-negative-safe-int>/u);
  const canonical = JSON.parse(json.stdout[0] ?? "") as {
    help_for: string;
    usage: string;
    options: Array<{ name: string }>;
    notes: string[];
  };
  const alias = JSON.parse(aliasJson.stdout[0] ?? "") as typeof canonical;
  assert.equal(canonical.help_for, "session mutate");
  assert.equal(alias.help_for, "resource mutate");
  assert.equal(alias.usage.replace("resource mutate", "session mutate"), canonical.usage);
  assert.deepEqual(
    alias.options.map((option) => option.name),
    canonical.options.map((option) => option.name),
  );
  assert.deepEqual(alias.notes.slice(0, 2), canonical.notes.slice(0, 2));
});

test("selected release forwards repeated exact resources and CAS in one backend call", async () => {
  let invocations = 0;
  let observed: ReleaseClaimsOptions | null = null;
  const released = sampleClaim("src/a.ts", "write");
  const remaining = sampleClaim("src/keep.ts", "read");
  const backend = backendForTests({
    releaseClaims: async (_context: SessionContext, options: ReleaseClaimsOptions) => {
      invocations += 1;
      observed = options;
      const result: ReleaseClaimsResult = {
        session_id: sampleSession.session_id,
        released: [released],
        remaining: [remaining],
        idempotent: false,
        claim_set_generation: 8,
      };
      return success(result);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "release",
      sampleSession.session_id,
      "--resource",
      "src/a.ts",
      "--resource",
      "src/missing.ts",
      "--if-generation",
      "7",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.equal(invocations, 1);
  assert.deepEqual(observed, {
    session_id: sampleSession.session_id,
    resources: ["src/a.ts", "src/missing.ts"],
    claim_ids: null,
    all: false,
    expected_claim_set_generation: 7,
  });
  const response = JSON.parse(output.stdout[0] ?? "") as ReleaseClaimsResult & { command: string; ok: boolean };
  assert.equal(response.ok, true);
  assert.equal(response.command, "session release");
  assert.equal(response.released.length, 1);
  assert.equal(response.remaining.length, 1);
});

test("release human success projects the same selected result as JSON", async () => {
  const released = sampleClaim("src/a.ts", "write");
  const remaining = sampleClaim("src/keep.ts", "read");
  const backend = backendForTests({
    releaseClaims: async () =>
      success({
        session_id: sampleSession.session_id,
        released: [released],
        remaining: [remaining],
        idempotent: false,
        claim_set_generation: 8,
      } satisfies ReleaseClaimsResult),
  });
  const output = capture();
  const exitCode = await runCli(["session", "release", sampleSession.session_id, "--resource", "src/a.ts", "--force"], {
    backend,
    io: output.io,
  });

  assert.equal(exitCode, 0);
  const human = output.stdout.join("\n");
  assert.match(human, /^session release: ok/m);
  assert.match(human, /released:/u);
  assert.match(human, /src\/a\.ts/u);
  assert.match(human, /remaining:/u);
  assert.match(human, /src\/keep\.ts/u);
});

test("release human stale rejection projects the structured failure code and details", async () => {
  const stale = () =>
    failure<ReleaseClaimsResult>(
      new DomainError("STALE_CLAIM_SET", "Claim-set generation is stale.", {
        expectedClaimSetGeneration: 2,
        actualClaimSetGeneration: 3,
      }),
    );
  const backend = backendForTests({ releaseClaims: async () => stale() });
  const jsonOutput = capture();
  const humanOutput = capture();
  const jsonExitCode = await runCli(
    ["--json", "session", "release", sampleSession.session_id, "--all", "--if-generation", "2"],
    { backend, io: jsonOutput.io },
  );
  const humanExitCode = await runCli(
    ["session", "release", sampleSession.session_id, "--all", "--if-generation", "2"],
    { backend, io: humanOutput.io },
  );

  assert.equal(jsonExitCode, 3);
  assert.equal(humanExitCode, 3);
  const structured = JSON.parse(jsonOutput.stdout[0] ?? "") as {
    ok: boolean;
    code: string;
    details: { expectedClaimSetGeneration: number; actualClaimSetGeneration: number };
  };
  assert.equal(structured.ok, false);
  assert.equal(structured.code, "STALE_CLAIM_SET");
  const human = humanOutput.stderr.join("\n");
  assert.match(human, /session release: rejected/u);
  assert.match(human, new RegExp(`code: ${structured.code}`, "u"));
  assert.match(human, /expectedClaimSetGeneration: 2/u);
  assert.match(human, /actualClaimSetGeneration: 3/u);
});

test("explicit all release and resource alias preserve selector/concurrency semantics", async () => {
  let observed: ReleaseClaimsOptions | null = null;
  const backend = backendForTests({
    releaseClaims: async (_context: SessionContext, options: ReleaseClaimsOptions) => {
      observed = options;
      return success({
        session_id: sampleSession.session_id,
        released: [],
        remaining: [],
        idempotent: true,
        claim_set_generation: 7,
      } satisfies ReleaseClaimsResult);
    },
  });
  const output = capture();
  assert.equal(
    await runCli(["--json", "resource", "release", "--session", sampleSession.session_id, "--all", "--force"], {
      backend,
      io: output.io,
    }),
    0,
  );
  assert.deepEqual(observed, {
    session_id: sampleSession.session_id,
    resources: null,
    claim_ids: null,
    all: true,
    force: true,
  });
  const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; command: string; idempotent: boolean };
  assert.deepEqual(response, {
    ok: true,
    command: "resource release",
    session_id: sampleSession.session_id,
    released: [],
    remaining: [],
    idempotent: true,
    claim_set_generation: 7,
  });
});

test("repeated claim-id release remains one selector family and one backend call", async () => {
  let invocations = 0;
  let observed: ReleaseClaimsOptions | null = null;
  const backend = backendForTests({
    releaseClaims: async (_context: SessionContext, options: ReleaseClaimsOptions) => {
      invocations += 1;
      observed = options;
      return success({
        session_id: sampleSession.session_id,
        released: [],
        remaining: [],
        idempotent: true,
        claim_set_generation: 4,
      } satisfies ReleaseClaimsResult);
    },
  });
  const output = capture();
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "release",
      sampleSession.session_id,
      "--claim-id",
      "claim-a",
      "--claim-id",
      "claim-b",
      "--force",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.equal(invocations, 1);
  assert.deepEqual(observed, {
    session_id: sampleSession.session_id,
    resources: null,
    claim_ids: ["claim-a", "claim-b"],
    all: false,
    force: true,
  });
});

test("release selector and concurrency ambiguity fail before backend invocation", async () => {
  let invocations = 0;
  const backend = backendForTests({
    releaseClaims: async () => {
      invocations += 1;
      return failure(new DomainError("INTERNAL_ERROR", "backend should not be called"));
    },
  });
  const invalidCommands = [
    ["--all", "--force", "--resource", "src/a.ts"],
    ["--claim-id", "claim-a", "--all", "--force"],
    ["--resource", "src/a.ts", "--claim-id", "claim-a", "--force"],
    ["--force"],
    ["--all"],
    ["--all", "--force", "--if-generation", "1"],
    ["--all", "--force", "--force"],
    ["--all", "--if-generation", "1", "--if-generation", "2"],
    ["--all", "--if-generation", "not-an-integer"],
  ];
  for (const arguments_ of invalidCommands) {
    const output = capture();
    const exitCode = await runCli(["--json", "session", "release", ...arguments_], { backend, io: output.io });
    assert.equal(exitCode, 2, arguments_.join(" "));
    const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; code: string };
    assert.equal(response.ok, false);
    assert.ok(["INVALID_ARGUMENT", "MISSING_ARGUMENT"].includes(response.code));
  }
  assert.equal(invocations, 0);
});

test("release human and JSON help expose the same selected/all grammar", async () => {
  const human = capture();
  const json = capture();
  const aliasJson = capture();
  assert.equal(await runCli(["session", "release", "--help"], { io: human.io }), 0);
  assert.equal(await runCli(["--json", "session", "release", "--help"], { io: json.io }), 0);
  assert.equal(await runCli(["--json", "resource", "release", "--help"], { io: aliasJson.io }), 0);
  assert.match(human.stdout.join("\n"), /--resource <path-or-glob>/u);
  assert.match(human.stdout.join("\n"), /--claim-id <id>/u);
  assert.match(human.stdout.join("\n"), /--all/u);
  assert.match(human.stdout.join("\n"), /--if-generation <non-negative-safe-int>/u);
  const canonical = JSON.parse(json.stdout[0] ?? "") as {
    help_for: string;
    usage: string;
    options: Array<{ name: string }>;
    notes: string[];
  };
  const alias = JSON.parse(aliasJson.stdout[0] ?? "") as typeof canonical;
  assert.equal(canonical.help_for, "session release");
  assert.equal(alias.help_for, "resource release");
  assert.equal(alias.usage.replace("resource release", "session release"), canonical.usage);
  assert.deepEqual(
    alias.options.map((option) => option.name),
    canonical.options.map((option) => option.name),
  );
  assert.match(canonical.notes.join("\n"), /exactly one selector family/iu);
  assert.match(canonical.notes.join("\n"), /exactly one destructive concurrency intent/iu);
});

test("session update forwards an explicit claim-set generation CAS guard", async () => {
  let observedOptions: UpdateClaimsOptions | null = null;
  const claims = [sampleClaim("src/a.ts", "write")];
  const result: ClaimResourcesResult = {
    session: sampleSession,
    claims,
    added: claims,
    released: [],
    idempotent: false,
    claim_set_generation: 8,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: UpdateClaimsOptions) => {
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
      "--if-generation",
      "7",
      "--resource",
      "src/a.ts",
      "--mode",
      "write",
    ],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 0, output.stderr.join("\n"));
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: null,
    claims: [{ resource: "src/a.ts", mode: "write" }],
    expected_claim_set_generation: 7,
  });
});

test("claim replacement guards reject malformed or absent concurrency intent before backend invocation", async () => {
  let invocations = 0;
  const backend = backendForTests({
    updateClaims: async () => {
      invocations += 1;
      return failure(new DomainError("INTERNAL_ERROR", "backend should not be called"));
    },
  });
  const invalidCommands = [
    ["--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "1", "--if-generation", "2", "--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "not-an-integer", "--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "-1", "--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "9007199254740992", "--resource", "src/a.ts", "--mode", "write"],
    ["--force=unexpected", "--resource", "src/a.ts", "--mode", "write"],
    ["--if-generation", "1", "--force", "--resource", "src/a.ts", "--mode", "write"],
  ];

  for (const replacementArguments of invalidCommands) {
    const output = capture();
    const exitCode = await runCli(["--json", "session", "update", ...replacementArguments], {
      backend,
      io: output.io,
    });
    assert.equal(exitCode, 2, replacementArguments.join(" "));
    const response = JSON.parse(output.stdout[0] ?? "") as { ok: boolean; code: string };
    assert.equal(response.ok, false);
    assert.ok(["INVALID_ARGUMENT", "MISSING_ARGUMENT"].includes(response.code));
  }
  assert.equal(invocations, 0);
});

test("stale replacement errors are projected unchanged by the canonical CLI", async () => {
  const backend = backendForTests({
    updateClaims: async () =>
      failure(
        new DomainError("STALE_CLAIM_SET", "Claim-set generation is stale.", {
          expectedClaimSetGeneration: 2,
          actualClaimSetGeneration: 3,
        }),
      ),
  });
  const output = capture();
  const exitCode = await runCli(
    ["--json", "session", "update", "--if-generation", "2", "--resource", "src/a.ts", "--mode", "write"],
    { backend, io: output.io },
  );

  assert.equal(exitCode, 3);
  assert.deepEqual(JSON.parse(output.stdout[0] ?? ""), {
    ok: false,
    command: "session update",
    code: "STALE_CLAIM_SET",
    message: "Claim-set generation is stale.",
    details: { expectedClaimSetGeneration: 2, actualClaimSetGeneration: 3 },
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
      "--force",
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
    claim_set_generation: 0,
  };
  const backend = backendForTests({
    updateClaims: async (_context: SessionContext, options: UpdateClaimsOptions) => {
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
      "--force",
    ],
    { backend, io: capture().io },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(observedOptions, {
    session_id: sampleSession.session_id,
    repository: "/tmp/repo",
    claims: [{ resource: "src/a.ts", mode: "write" }],
    force: true,
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
    claim_set_generation: 0,
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
        claim_set_generation: 0,
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
        claim_set_generation: 0,
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
    notes: string[];
  };
  const resourceHelp = JSON.parse(resourceOutput.stdout[0]) as {
    help_for: string;
    options: Array<{ name: string }>;
    optional_options: string[];
    notes: string[];
  };

  assert.equal(resourceHelp.help_for, "resource update");
  assert.deepEqual(
    resourceHelp.options.map((option) => option.name).sort(),
    sessionHelp.options.map((option) => option.name).sort(),
  );
  assert.ok(resourceHelp.options.some((option) => option.name === "--session"));
  assert.ok(resourceHelp.options.some((option) => option.name === "--repository"));
  assert.ok(resourceHelp.options.some((option) => option.name === "--if-generation"));
  assert.ok(resourceHelp.options.some((option) => option.name === "--force"));
  assert.ok(resourceHelp.optional_options.includes("--session"));
  assert.ok(resourceHelp.optional_options.includes("--repository"));
  assert.equal(resourceHelp.notes[0], sessionHelp.notes[0]);
  assert.match(resourceHelp.notes.join("\n"), /full replacement/u);
  assert.match(resourceHelp.notes.join("\n"), /atomically/u);
  assert.match(resourceHelp.notes.join("\n"), /--if-generation/u);
  assert.match(resourceHelp.notes.join("\n"), /claim-set generation CAS/u);
  assert.match(resourceHelp.notes.join("\n"), /--force/u);
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
