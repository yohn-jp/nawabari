import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  runRepositoryTerminal,
  type RepositoryTerminalInput,
  type RepositoryTerminalOutput,
} from "./repository-terminal.js";
import type { RepositoryScreenModel } from "./repository-screen.js";

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

test("an already-aborted signal resolves before raw mode or listeners are installed", async () => {
  const input = new FakeInput(true);
  const output = new FakeOutput(true);
  const abortController = new AbortController();
  abortController.abort();
  const result = await runRepositoryTerminal({
    stdin: input as unknown as RepositoryTerminalInput,
    stdout: output as unknown as RepositoryTerminalOutput,
    signal: abortController.signal,
    readSnapshot: () => sample(),
  });
  assert.equal(result.reason, "aborted");
  assert.equal(result.snapshot_token, "token-1");
  assert.deepEqual(input.rawModes, []);
  assert.deepEqual(output.writes, []);
});
