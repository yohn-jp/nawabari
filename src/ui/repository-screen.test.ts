import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeTerminalText,
  reconcileScreenSelection,
  renderRepositoryScreen,
  repositoryScreenJson,
  type RepositoryScreenModel,
} from "./repository-screen.js";

const hostile = "feature/ok\u001b]0;owned\u0007\nnext";

function model(overrides: RepositoryScreenModel = {}): RepositoryScreenModel {
  return {
    snapshot_token: "snapshot-1",
    sessions: [
      { session_id: "session-1", branch: "feature/demo", state: "active" },
      { session_id: "session-2", branch: hostile, state: "attention" },
    ],
    matrix: [
      {
        path: "src/main.ts",
        session_ids: ["session-1", "session-2"],
        claim_mode: "write",
        observed_change: "changed",
        conflict_state: "blocked",
      },
    ],
    attention: [{ attention_id: "attention-1", severity: "high", reason: "review required" }],
    runtime: [{ id: "runtime-1", status: "ready", profile: "strict", process_state: "idle" }],
    conflicts: [{ conflict_id: "conflict-1", path: hostile, state: "blocked", message: hostile }],
    ...overrides,
  };
}

test("escapes terminal controls as visible text", () => {
  const escaped = escapeTerminalText(hostile);
  assert.equal(escaped, "feature/ok\\u{1b}]0;owned\\u{7}\\nnext");
  assert.doesNotMatch(escaped, /\u001b/u);
});

test("renders the supplied matrix and conflict values without recalculating them", () => {
  const output = renderRepositoryScreen(
    model(),
    { width: 140, height: 40 },
    {
      view: "files",
      selected_id: "src/main.ts",
      snapshot_token: "snapshot-1",
    },
  );
  assert.match(output, /FILES:/u);
  assert.match(output, /claim=write/u);
  assert.match(output, /change=changed/u);
  assert.match(output, /conflict=blocked/u);
  assert.doesNotMatch(output, /\u001b\]0;/u);

  const conflictOutput = renderRepositoryScreen(
    model(),
    { width: 140, height: 40 },
    {
      view: "conflicts",
      selected_id: "conflict-1",
      snapshot_token: "snapshot-1",
    },
  );
  assert.match(conflictOutput, /\\u\{1b\}/u);
});

test("small viewports stay bounded and advertise snapshot truncation", () => {
  const output = renderRepositoryScreen(model({ truncated: true, next_cursor: "cursor-2" }), { width: 24, height: 5 });
  assert.ok(output.split("\n").length <= 5);
  assert.match(output, /more lines|snapshot/u);
});

test("selection is matched by stable identity when a snapshot token changes", () => {
  const stale = reconcileScreenSelection(
    { view: "sessions", selected_id: "session-2", snapshot_token: "snapshot-1" },
    model({
      snapshot_token: "snapshot-2",
      sessions: [{ session_id: "session-1", branch: "feature/demo", state: "active" }],
    }),
  );
  assert.equal(stale.selected_id, null);
  assert.equal(stale.snapshot_token, "snapshot-2");

  const retained = reconcileScreenSelection(
    { view: "sessions", selected_id: "session-2", snapshot_token: "snapshot-1" },
    model({ snapshot_token: "snapshot-2" }),
  );
  assert.equal(retained.selected_id, "session-2");
});

test("JSON fallback is non-interactive and carries the snapshot token", () => {
  const value = JSON.parse(repositoryScreenJson(model(), { width: 80, height: 20 })) as Record<string, unknown>;
  assert.equal(value.ui, "repository");
  assert.equal(value.interactive, false);
  assert.equal(value.snapshot_token, "snapshot-1");
});

test("JSON fallback remains bounded when a producer supplies a large snapshot", () => {
  const large = model({
    sessions: Array.from({ length: 10_000 }, (_, index) => ({
      session_id: `session-${index}`,
      branch: `feature/${index}`,
      state: "active",
      message: "bounded evidence",
    })),
  });
  const encoded = repositoryScreenJson(large, { width: 80, height: 20 });
  assert.ok(new TextEncoder().encode(encoded).byteLength <= 64 * 1024);
  assert.equal((JSON.parse(encoded) as Record<string, unknown>).truncated, true);
});
