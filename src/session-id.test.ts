import assert from "node:assert/strict";
import { test } from "node:test";

import { generateSessionId, isSessionId } from "./session-id.js";

test("generates unique UUIDv7 session IDs", () => {
  const identifiers = Array.from({ length: 5_000 }, () => generateSessionId(1_735_689_600_000));
  assert.equal(new Set(identifiers).size, identifiers.length);
  for (const identifier of identifiers) {
    assert.equal(isSessionId(identifier), true);
    assert.match(identifier, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  }
});

test("UUIDv7 IDs preserve millisecond ordering", () => {
  const earlier = generateSessionId(1_735_689_600_000);
  const later = generateSessionId(1_735_689_600_001);

  assert.ok(earlier < later);
});

test("rejects values that are not UUIDv7 IDs", () => {
  assert.equal(isSessionId("550e8400-e29b-41d4-a716-446655440000"), false);
  assert.equal(isSessionId("not-a-session-id"), false);
});
