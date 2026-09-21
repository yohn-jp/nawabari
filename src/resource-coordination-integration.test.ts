import assert from "node:assert/strict";
import { test } from "node:test";

import { createResourceIntent } from "./resource-coordination.js";
import { SessionRegistry } from "./session-registry.js";

test("the registry composes real coordination producers into read-only public projections", () => {
  const registry = new SessionRegistry({ cwd: process.cwd() });
  const intent = createResourceIntent({
    sessionId: "coordination-integration-session",
    operation: "CREATE",
    selector: "src/new-file.ts",
  });

  const graph = registry.resourceCoordinationGraph([intent]);
  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.complete, true);
  assert.equal(graph.edges.length, 0);

  const snapshot = registry.resourceCoordinationSnapshot({ complete: true });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.contract.persisted, false);
  assert.equal(snapshot.contract.mutation, false);
  assert.deepEqual(snapshot.resources, []);
});
