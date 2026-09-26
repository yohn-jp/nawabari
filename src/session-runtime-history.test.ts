import assert from "node:assert/strict";
import test from "node:test";
import { appendRuntimeEvent, projectSessionRuntimeHistory } from "./session-runtime-history.js";
import {
  emptyRuntimeRecords,
  MAX_RUNTIME_RECORDS,
  parseRuntimeRecords,
  toPersistedRuntimeRecords,
} from "./registry/runtime-records.js";

const event = (session_id: string, revision: number) => ({
  kind: "lifecycle" as const,
  session_id,
  execution_id: null,
  source: "session-registry" as const,
  operation: "active->parked",
  before_revision: revision,
  after_revision: revision + 1,
  observed_at: "2026-01-01T00:00:00.000Z",
});

test("history persists with stable identities, provenance, bounded retention and explicit retained window", () => {
  let state = emptyRuntimeRecords();
  for (let i = 0; i < MAX_RUNTIME_RECORDS + 3; i++) state = appendRuntimeEvent(state, [event(i % 2 ? "s2" : "s1", i)]);
  const persisted = toPersistedRuntimeRecords(state);
  assert.equal(persisted.session_history?.length, MAX_RUNTIME_RECORDS);
  const reloaded = parseRuntimeRecords({ required_features: state.requiredFeatures, ...persisted });
  const projected = projectSessionRuntimeHistory(reloaded, "s1");
  assert.equal(projected.retained_from, 4);
  assert.equal(projected.retained_through, MAX_RUNTIME_RECORDS + 3);
  assert.equal(projected.truncated, true);
  assert.equal(projected.coverage, "since-first-recorded-event");
  assert.equal(projected.events[0]?.event_id, "history:5");
  assert.equal(projected.events[0]?.source, "session-registry");
  assert.equal(
    projected.events.every((value) => value.session_id === "s1"),
    true,
  );
});

test("history rejects malformed events; other evidence never competes for its bound", () => {
  const handoff = {
    kind: "resource-handoff",
    schema_version: 1,
    operation_id: "o",
    from_session_id: "s1",
    to_session_id: "s2",
    resource: "r",
    mode: "write",
    claim_set_generation: 1,
  };
  const initial = parseRuntimeRecords({ required_features: ["recent-events.v1"], recent_events: [handoff] });
  const updated = appendRuntimeEvent(initial, [event("s1", 1)]);
  assert.deepEqual(toPersistedRuntimeRecords(updated).recent_events, [handoff]);
  const persisted = toPersistedRuntimeRecords(updated);
  assert.throws(() =>
    parseRuntimeRecords({
      ...persisted,
      required_features: updated.requiredFeatures,
      session_history: [{ ...persisted.session_history![0], event_id: "tampered" }],
    }),
  );
  assert.deepEqual(projectSessionRuntimeHistory(initial, "s1"), {
    events: [],
    bound: MAX_RUNTIME_RECORDS,
    retained_from: null,
    retained_through: null,
    truncated: false,
    coverage: "since-first-recorded-event",
  });
});
