import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DomainError, failure, success } from "../domain/errors.js";
import type {
  SessionDiagnostic,
  SessionDiscardPreview,
  SessionDiscardResult,
  SessionLifecycleAction,
} from "../domain/session.js";
import {
  runRepositoryTerminal,
  type RepositoryTerminalInput,
  type RepositoryTerminalOutput,
} from "./repository-terminal.js";
import type { RepositoryScreenModel } from "./repository-screen.js";
import type { SessionActionConfirmation, SessionActionDispatcher, SessionActionToken } from "./session-actions.js";

class FakeInput extends EventEmitter {
  readonly isTTY: boolean;
  readonly rawModes: boolean[] = [];

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  setRawMode(mode: boolean): this {
    this.rawModes.push(mode);
    return this;
  }
}

class FakeOutput extends EventEmitter {
  readonly isTTY: boolean;
  readonly columns = 100;
  readonly rows = 30;
  readonly writes: string[] = [];

  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }

  write(value: string): boolean {
    this.writes.push(value);
    return true;
  }
}

function sample(token = "token-1"): RepositoryScreenModel {
  return {
    snapshot_token: token,
    sessions: [{ session_id: "session-1", branch: "feature/demo", state: "active" }],
    matrix: [],
    attention: [],
    runtime: [],
    conflicts: [],
  };
}

const discardAction: SessionLifecycleAction = {
  schema_version: 1,
  action_id: "discard-session",
  kind: "explicit-discard",
  command: "session discard",
  session_id: "session-1",
  requires_explicit_intent: true,
};

const actionToken: SessionActionToken = {
  schema_version: 1,
  session_id: "session-1",
  session_updated_at: "updated",
  claim_set_generation: 1,
  lifecycle_state: "active",
  physical_state: "healthy",
  working_set_revision: null,
};

const actionPreview = {
  operation: "discard-preview",
  destructive: true,
  warning: "authoritative-preview",
} as unknown as SessionDiscardPreview;

type ActionCall = {
  readonly action_id: string;
  readonly confirmation: SessionActionConfirmation;
};

function actionSample(): RepositoryScreenModel {
  return {
    ...sample(),
    sessions: [
      { session_id: "session-1", repository: "repo", worktree: "/worktree", branch: "feature/demo", state: "active" },
    ],
  };
}

function actionDispatcher(calls: ActionCall[]): SessionActionDispatcher {
  const identity = { session_id: "session-1", repository: "repo", worktree: "/worktree" };
  const diagnostic = { next_actions: [discardAction] } as unknown as SessionDiagnostic;
  return {
    readSessionActionSnapshot: async () => success({ identity, token: actionToken, diagnostic }),
    dispatchSessionAction: async (actionId, _identity, _token, confirmation) => {
      calls.push({ action_id: actionId, confirmation });
      if (!confirmation.confirmed) {
        return success({
          action_id: "discard-session",
          status: "confirmation-required",
          token: actionToken,
          preview: actionPreview,
        });
      }
      return success({
        action_id: "discard-session",
        status: "completed",
        token: actionToken,
        result: {} as SessionDiscardResult,
      });
    },
    confirmDestructiveSessionAction: async () => failure(new DomainError("OPERATION_REJECTED", "unused")),
  };
}

async function flushTerminal(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function openDiscardConfirmation(
  input: FakeInput,
  output: FakeOutput,
  calls: ActionCall[],
): Promise<{ readonly running: ReturnType<typeof runRepositoryTerminal> }> {
  const running = runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    readSnapshot: () => actionSample(),
    sessionActions: actionDispatcher(calls),
  });
  await flushTerminal();
  input.emit("data", "j");
  input.emit("data", "a");
  await flushTerminal();
  input.emit("data", "1");
  await flushTerminal();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.action_id, "discard-session");
  assert.equal(calls[0]?.confirmation.confirmed, false);
  assert.match(output.writes.join(""), /authoritative-preview/u);
  return { running };
}

test("non-TTY mode never enables raw input and emits JSON fallback", async () => {
  const input = new FakeInput(false);
  const output = new FakeOutput(false);
  const result = await runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    json: true,
    readSnapshot: () => sample(),
  });
  assert.equal(result.interactive, false);
  assert.equal(result.reason, "eof");
  assert.deepEqual(input.rawModes, []);
  const value = JSON.parse(output.writes.join("")) as Record<string, unknown>;
  assert.equal(value.interactive, false);
  assert.equal(value.snapshot_token, "token-1");
});

test("TTY mode restores raw mode on q and handles arrow navigation", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const running = runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    readSnapshot: () => ({
      ...sample(),
      sessions: [
        { session_id: "session-1", branch: "feature/demo", state: "active" },
        { session_id: "session-2", branch: "feature/second", state: "idle" },
      ],
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.emit("data", "\u001b[B\u001b[Cq");
  const result = await running;
  assert.equal(result.interactive, true);
  assert.equal(result.reason, "quit");
  assert.deepEqual(input.rawModes, [true, false]);
  assert.match(output.writes.join(""), /NAWABARI repository \(read-only\)/u);
  assert.match(output.writes.join(""), /snapshot=token-1/u);
});

test("Ctrl-C exits through the same cleanup path", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const running = runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    readSnapshot: () => sample(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  input.emit("data", "\u0003");
  const result = await running;
  assert.equal(result.reason, "interrupt");
  assert.deepEqual(input.rawModes, [true, false]);
});

test("TTY action flow selects a session, previews authoritatively, and confirms with y", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const calls: ActionCall[] = [];
  const { running } = await openDiscardConfirmation(input, output, calls);

  input.emit("data", "y");
  await flushTerminal();
  input.emit("data", "q");
  const result = await running;
  assert.equal(result.reason, "quit");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.action_id, "discard-session");
  assert.equal(calls[1]?.confirmation.confirmed, true);
  if (calls[1]?.confirmation.confirmed) assert.equal(calls[1].confirmation.preview, actionPreview);
});

test("TTY action n cancels the authoritative preview without dispatching confirmation", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const calls: ActionCall[] = [];
  const { running } = await openDiscardConfirmation(input, output, calls);

  input.emit("data", "n");
  await flushTerminal();
  input.emit("data", "q");
  const result = await running;
  assert.equal(result.reason, "quit");
  assert.equal(calls.length, 1);
});

test("TTY action Escape cancels the authoritative preview without dispatching confirmation", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const calls: ActionCall[] = [];
  const { running } = await openDiscardConfirmation(input, output, calls);

  input.emit("data", "\u001b");
  await flushTerminal();
  input.emit("data", "q");
  const result = await running;
  assert.equal(result.reason, "quit");
  assert.equal(calls.length, 1);
});

test("an already-aborted signal resolves before raw mode or listeners are installed", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const abortController = new AbortController();
  abortController.abort();
  let readerCalls = 0;
  const result = await runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    signal: abortController.signal,
    readSnapshot: () => {
      readerCalls += 1;
      return sample();
    },
  });
  assert.equal(result.reason, "aborted");
  assert.equal(result.snapshot_token, null);
  assert.equal(readerCalls, 0);
  assert.deepEqual(input.rawModes, []);
  assert.deepEqual(output.writes, []);
});

test("an already-aborted signal does not await a never-resolving snapshot reader", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const abortController = new AbortController();
  abortController.abort();
  let readerCalls = 0;
  const outcome = await Promise.race([
    runRepositoryTerminal({
      stdin: input as unknown as RepositoryTerminalInput,
      stdout: output as unknown as RepositoryTerminalOutput,
      signal: abortController.signal,
      readSnapshot: () => {
        readerCalls += 1;
        return new Promise<RepositoryScreenModel>(() => undefined);
      },
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  assert.ok(outcome !== null);
  assert.equal(outcome.reason, "aborted");
  assert.equal(readerCalls, 0);
  assert.deepEqual(input.rawModes, []);
});
