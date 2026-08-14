import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "./cli.js";
import { DomainError, type JsonObject, type JsonValue } from "./domain/errors.js";
import { boundedSessionListing, DEFAULT_SESSION_LIST_LIMIT } from "./domain/session.js";
import { SessionRegistry } from "./session-registry.js";
import { captureGitCheckpoint } from "./git.js";
import { CHECKPOINT_MAX_PATHS } from "./operation-authorization.js";
import { renderFailure } from "./presentation.js";
import { boundOutputDetails, FAILURE_DETAIL_ARRAY_LIMIT, FAILURE_MESSAGE_LENGTH_LIMIT } from "./output-budget.js";
import { canonicalClaimId } from "./resource-claims.js";

test("default session discovery excludes closed history and exposes bounded continuation metadata", () => {
  const active = makeSession("0190f1e0-0000-7000-8000-000000000001", "active");
  const closed = Array.from({ length: 1_000 }, (_, index) =>
    makeSession(`0190f1e0-0000-7000-8000-${(index + 2).toString(16).padStart(12, "0")}`, "closed"),
  );

  const defaultListing = boundedSessionListing([active, ...closed]);
  assert.deepEqual(
    defaultListing.sessions.map((session) => session.session_id),
    [active.session_id],
  );
  assert.equal(defaultListing.total, 1);
  assert.equal(defaultListing.returned, 1);
  assert.equal(defaultListing.limit, DEFAULT_SESSION_LIST_LIMIT);
  assert.equal(defaultListing.truncated, false);
  assert.equal(defaultListing.closed_count, closed.length);
  assert.equal(defaultListing.history_available, true);
  assert.equal(defaultListing.history_included, false);

  const historyListing = boundedSessionListing([active, ...closed], {
    include_closed: true,
    limit: 8,
    offset: 8,
  });
  assert.equal(historyListing.total, closed.length + 1);
  assert.equal(historyListing.returned, 8);
  assert.equal(historyListing.truncated, true);
  assert.equal(historyListing.next_offset, 16);
  assert.equal(historyListing.history_included, true);
});

test("CLI status and session list remain bounded as closed registry history grows", async () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const sessions = Array.from({ length: 1_000 }, (_, index) =>
      makePersistedSession(
        `0190f1e0-0000-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        registry.repository.repositoryId,
        index,
      ),
    );
    const active = makeActivePersistedSession("0190f1e0-0000-7000-8000-000000000000", registry.repository.repositoryId);
    const claims = Array.from({ length: 256 }, (_, index) => {
      const resource = `stress/resource-${index}.txt`;
      return {
        schema_version: 2,
        claim_id: canonicalClaimId(active.session_id, resource, "read"),
        session_id: active.session_id,
        repository_id: active.repository_id,
        worktree_path: active.worktree_path,
        resource,
        mode: "read" as const,
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      };
    });
    fs.mkdirSync(registry.paths.directory, { recursive: true });
    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify({
        schema_version: 1,
        repository_id: registry.repository.repositoryId,
        claims_schema_version: 2,
        claims,
        sessions: [active, ...sessions],
      })}\n`,
    );

    const defaultList = await runJson<SessionListingResponse>(["session", "list"], repositoryPath);
    const defaultStatus = await runJson<SessionListingResponse>(["status"], repositoryPath);
    assert.equal(defaultList.sessions.length, 1);
    assert.equal(defaultStatus.sessions.length, 1);
    assert.equal(defaultList.total, 1);
    assert.equal(defaultStatus.total, 1);
    assert.equal(defaultList.closed_count, sessions.length);
    assert.equal(defaultStatus.closed_count, sessions.length);
    assert.equal(defaultList.history_available, true);
    assert.equal(defaultStatus.history_available, true);
    assert.equal(JSON.stringify(defaultList).length < 4_000, true);
    assert.equal(JSON.stringify(defaultStatus).length < 4_000, true);

    const historyPage = await runJson<SessionListingResponse>(
      ["session", "list", "--history", "--limit", "8", "--offset", "16"],
      repositoryPath,
    );
    assert.equal(historyPage.sessions.length, 8);
    assert.equal(historyPage.total, sessions.length + 1);
    assert.equal(historyPage.returned, 8);
    assert.equal(historyPage.limit, 8);
    assert.equal(historyPage.offset, 16);
    assert.equal(historyPage.truncated, true);
    assert.equal(historyPage.next_offset, 24);
    assert.equal(historyPage.history_included, true);
    assert.equal(
      historyPage.sessions.some((session) => session.session_id === sessions[0]?.session_id),
      false,
    );
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("capabilities and JSON help are independent of repository history", async () => {
  const repositoryPath = createRepository();
  const emptyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-output-budget-empty-"));
  try {
    const historyOutput = await runJson<JsonObject>(["capabilities"], repositoryPath);
    const emptyOutput = await runJson<JsonObject>(["capabilities"], emptyDirectory);
    assert.deepEqual(historyOutput, emptyOutput);

    const helpOutput = await runJson<JsonObject>(["--help"], repositoryPath);
    assert.equal(helpOutput.command, "help");
    assert.equal(JSON.stringify(helpOutput).length < 12_000, true);
    assert.equal(Object.hasOwn(helpOutput, "sessions"), false);
    assert.equal(Object.hasOwn(helpOutput, "claims"), false);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
    fs.rmSync(emptyDirectory, { recursive: true, force: true });
  }
});

test("failure detail arrays are explicitly bounded without dropping recovery metadata", () => {
  const paths = Array.from({ length: FAILURE_DETAIL_ARRAY_LIMIT + 10 }, (_, index) => `changed-${index}`);
  const longMessage = `message-${"x".repeat(5_000)}`;
  const rendered = renderFailure(
    "json",
    "push",
    new DomainError("PUSH_DIRTY_WORKTREE", longMessage, {
      paths,
      recovery_hints: ["Inspect the changed paths before retrying."],
    }),
  );
  const response = JSON.parse(rendered) as {
    message: string;
    details: {
      paths: string[];
      paths_total: number;
      paths_limit: number;
      paths_truncated: boolean;
      paths_next_offset: number;
      recovery_hints: string[];
      message_total: number;
      message_limit: number;
      message_truncated: boolean;
    };
  };
  assert.equal(response.message.length, FAILURE_MESSAGE_LENGTH_LIMIT);
  assert.equal(response.details.message_total, longMessage.length);
  assert.equal(response.details.message_limit, FAILURE_MESSAGE_LENGTH_LIMIT);
  assert.equal(response.details.message_truncated, true);
  assert.equal(response.details.paths.length, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.equal(response.details.paths_total, paths.length);
  assert.equal(response.details.paths_limit, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.equal(response.details.paths_truncated, true);
  assert.equal(response.details.paths_next_offset, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.deepEqual(response.details.recovery_hints, ["Inspect the changed paths before retrying."]);

  const humanRendered = renderFailure(
    "human",
    "push",
    new DomainError("PUSH_DIRTY_WORKTREE", longMessage, {
      paths,
      recovery_hints: ["Inspect the changed paths before retrying."],
    }),
  );
  assert.equal(humanRendered.includes(`changed-${FAILURE_DETAIL_ARRAY_LIMIT + 9}`), false);
  assert.equal(humanRendered.includes("changed-0"), true);
  assert.equal(humanRendered.includes("paths_total:"), true);
  assert.equal(humanRendered.includes("paths_truncated:"), true);
  assert.equal(humanRendered.includes("message_budget:"), true);
  assert.equal(humanRendered.includes(`total: ${longMessage.length}`), true);
  assert.equal(humanRendered.includes(`limit: ${FAILURE_MESSAGE_LENGTH_LIMIT}`), true);
  assert.equal(humanRendered.includes("truncated: true"), true);
});

test("checkpoint accepts the documented maximum and fails deterministically on overflow", () => {
  const makeOutput = (count: number): string =>
    Array.from({ length: count }, (_, index) => `?? path-${index}\u0000`).join("");
  const withinLimit = captureGitCheckpoint(
    { run: () => "", runRaw: () => makeOutput(CHECKPOINT_MAX_PATHS) },
    "/tmp/worktree",
  );
  assert.equal(withinLimit.changed.length, CHECKPOINT_MAX_PATHS);

  assert.throws(
    () => captureGitCheckpoint({ run: () => "", runRaw: () => makeOutput(CHECKPOINT_MAX_PATHS + 1) }, "/tmp/worktree"),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "GIT_OUTPUT_LIMIT" &&
      "details" in error &&
      (error.details as { maxPaths?: number }).maxPaths === CHECKPOINT_MAX_PATHS,
  );
});

test("arrays nested within arrays retain truncation metadata", () => {
  const oversizedGroup = Array.from({ length: FAILURE_DETAIL_ARRAY_LIMIT + 5 }, (_, index) => `nested-item-${index}`);
  const input: JsonObject = {
    groups: [oversizedGroup, "marker"],
  };
  const bounded = boundOutputDetails(input);
  const groups = bounded.groups as JsonValue[];
  assert.equal(Array.isArray(groups), true);
  // The outer array itself has only 2 members, so it is not truncated and gets no sibling keys.
  assert.equal(Object.hasOwn(bounded, "groups_truncated"), false);

  const firstGroup = groups[0] as JsonObject;
  assert.ok(firstGroup !== null && typeof firstGroup === "object" && !Array.isArray(firstGroup));
  assert.equal(Array.isArray(firstGroup.items), true);
  assert.equal((firstGroup.items as unknown[]).length, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.equal(firstGroup.items_total, oversizedGroup.length);
  assert.equal(firstGroup.items_limit, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.equal(firstGroup.items_truncated, true);
  assert.equal(firstGroup.items_next_offset, FAILURE_DETAIL_ARRAY_LIMIT);
  assert.equal(groups[1], "marker");
});

function makeSession(sessionId: string, state: "active" | "closed") {
  return {
    schema_version: 1,
    session_id: sessionId,
    repository: "/tmp/repository",
    worktree: `/tmp/worktree-${sessionId}`,
    branch: `history/${sessionId.slice(-6)}`,
    state,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    label: `long-valid-label-${"x".repeat(160)}`,
  };
}

function makePersistedSession(sessionId: string, repositoryId: string, index: number) {
  const worktreePath = path.join(os.tmpdir(), `nawabari-history-${process.pid}-${index}-${"x".repeat(40)}`);
  const branchName = `history/${index}`;
  return {
    schema_version: 1,
    session_id: sessionId,
    repository_id: repositoryId,
    worktree_id: worktreePath,
    worktree_path: worktreePath,
    branch_id: `refs/heads/${branchName}`,
    branch_name: branchName,
    state: "closed" as const,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    label: `history-${"x".repeat(160)}`,
  };
}

function makeActivePersistedSession(sessionId: string, repositoryId: string) {
  const worktreePath = path.join(os.tmpdir(), `nawabari-active-history-${process.pid}`);
  return {
    schema_version: 1,
    session_id: sessionId,
    repository_id: repositoryId,
    worktree_id: worktreePath,
    worktree_path: worktreePath,
    branch_id: "refs/heads/history/stress-active",
    branch_name: "history/stress-active",
    state: "active" as const,
    created_at: "2026-08-10T00:00:00.000Z",
    updated_at: "2026-08-10T00:00:00.000Z",
    label: `active-history-${"x".repeat(160)}`,
  };
}

type SessionListingResponse = JsonObject & {
  sessions: Array<{ session_id: string }>;
  total: number;
  returned: number;
  limit: number;
  offset: number;
  truncated: boolean;
  next_offset: number | null;
  closed_count: number;
  history_available: boolean;
  history_included: boolean;
};

async function runJson<T extends JsonObject>(arguments_: string[], cwd: string): Promise<T> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli([...arguments_, "--json"], {
    cwd,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
  });
  assert.equal(exitCode, 0, `${arguments_.join(" ")} failed: ${stderr.join("\n")} ${stdout.join("\n")}`);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0] ?? "") as T;
}

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-output-budget-repository-"));
  runGit(["init", "-b", "main", repositoryPath], process.cwd());
  runGit(["config", "user.email", "test@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Test"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
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
