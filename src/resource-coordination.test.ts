import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResourceOverlapGraph, createResourceIntent, resourceSelectorsOverlap } from "./resource-coordination.js";
import type { ResourceClaim } from "./resource-claims.js";

const claim = (sessionId: string, claimId: string, resource: string): ResourceClaim => ({
  schemaVersion: 3,
  claimId,
  sessionId,
  repositoryId: "repo",
  worktreePath: `/worktrees/${sessionId}`,
  resource,
  mode: "write",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("represents exact, glob, namespace, and CREATE overlap as separate facts", () => {
  const leftClaim = claim("session-a", "claim-a", "src/config.json");
  const rightClaim = claim("session-b", "claim-b", "src/*.json");
  const leftIntent = createResourceIntent({
    sessionId: "session-a",
    repositoryId: "repo",
    claimId: "claim-a",
    mode: "CREATE",
    selector: "src/config.json",
  });
  const rightIntent = createResourceIntent({
    sessionId: "session-b",
    repositoryId: "repo",
    claimId: "claim-b",
    mode: "CREATE",
    selector: "src/*.json",
  });

  const graph = buildResourceOverlapGraph([leftClaim, rightClaim], [leftIntent, rightIntent]);
  assert.equal(graph.complete, true);
  assert.equal(graph.edges.length, 1);
  const edge = graph.edges[0]!;
  assert.equal(edge.facts.exactResourceMatch, false);
  assert.equal(edge.facts.selectorIntersection, true);
  assert.equal(edge.facts.createCreateCollision, true);
  assert.deepEqual(edge.classification.kinds, ["selector-intersection", "create-create"]);
});

test("namespace overlap includes parent and child and retains missing CREATE targets", () => {
  assert.equal(
    resourceSelectorsOverlap({ kind: "namespace", resource: "new" }, { kind: "exact", resource: "new/a.txt" }),
    true,
  );
  assert.equal(
    resourceSelectorsOverlap({ kind: "namespace", resource: "new" }, { kind: "exact", resource: "newer/a.txt" }),
    false,
  );

  const first = createResourceIntent({
    sessionId: "a",
    mode: "CREATE",
    selector: { kind: "namespace", resource: "new" },
  });
  const second = createResourceIntent({ sessionId: "b", mode: "CREATE", selector: "new/a.txt" });
  assert.equal(first.selector.resource, "new");
  assert.equal(first.selector.kind, "namespace");
  const graph = buildResourceOverlapGraph([], [first, second]);
  assert.equal(graph.edges[0]?.facts.parentChildOverlap, true);
  assert.equal(graph.edges[0]?.facts.createCreateCollision, true);
});

test("intent selector overlap remains observable when attached claims are disjoint", () => {
  const leftClaim = claim("session-a", "claim-a", "owned/left.ts");
  const rightClaim = claim("session-b", "claim-b", "owned/right.ts");
  const sharedLeft = createResourceIntent({
    sessionId: "session-a",
    claimId: "claim-a",
    mode: "WRITE",
    selector: "planned/shared.ts",
  });
  const sharedRight = createResourceIntent({
    sessionId: "session-b",
    claimId: "claim-b",
    mode: "WRITE",
    selector: "planned/shared.ts",
  });

  const graph = buildResourceOverlapGraph([leftClaim, rightClaim], [sharedLeft, sharedRight]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.facts.exactResourceMatch, true);
});

test("a root-only glob intersection is not a strict namespace descendant", () => {
  const namespace = createResourceIntent({ sessionId: "a", mode: "WRITE", namespace: "new" });
  const rootGlob = createResourceIntent({ sessionId: "b", mode: "WRITE", selector: "new*" });
  const graph = buildResourceOverlapGraph([], [namespace, rootGlob]);

  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.facts.selectorIntersection, true);
  assert.equal(graph.edges[0]?.facts.parentChildOverlap, false);
});

test("edge and node identity are invariant under input order", () => {
  const claims = [claim("b", "claim-b", "src/*.ts"), claim("a", "claim-a", "src/index.ts")];
  const intents = [
    createResourceIntent({ sessionId: "b", claimId: "claim-b", mode: "WRITE", selector: "src/*.ts" }),
    createResourceIntent({ sessionId: "a", claimId: "claim-a", mode: "WRITE", selector: "src/index.ts" }),
  ];
  const first = buildResourceOverlapGraph(claims, intents);
  const second = buildResourceOverlapGraph([...claims].reverse(), [...intents].reverse());
  assert.deepEqual(first, second);
  assert.equal(first.edges[0]?.pairKey, "a\u0000claim-a\u0000b\u0000claim-b");
});

test("intent graphing does not create or mutate ResourceClaim authority", () => {
  const intents = [
    createResourceIntent({ sessionId: "a", mode: "CREATE", selector: "future/new.txt" }),
    createResourceIntent({ sessionId: "b", mode: "CREATE", selector: "future/new.txt" }),
  ];
  const claims: ResourceClaim[] = [];
  const graph = buildResourceOverlapGraph(claims, intents);
  assert.equal(claims.length, 0);
  assert.equal(graph.edges[0]?.left.claim, undefined);
  assert.equal(graph.edges[0]?.right.claim, undefined);
});

test("a truncated graph is incomplete and never clean", () => {
  const claims = [claim("a", "a", "src/a.ts"), claim("b", "b", "src/a.ts"), claim("c", "c", "src/a.ts")];
  const graph = buildResourceOverlapGraph(claims, [], { maxPairs: 1 });
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.unevaluatedPairs, 2);
  assert.equal(graph.complete, false);
  assert.equal(graph.clean, false);
});

test("selector validation remains lexical and fail-closed without filesystem access", () => {
  assert.throws(() => createResourceIntent({ sessionId: "a", mode: "CREATE", resource: "../future" }), {
    name: "ResourceCoordinationError",
  });
  for (const resource of ["C:/secret", "C:\\secret", "C:secret"]) {
    assert.throws(() => createResourceIntent({ sessionId: "a", mode: "CREATE", resource }), {
      name: "ResourceCoordinationError",
    });
  }
  const missing = createResourceIntent({ sessionId: "a", mode: "CREATE", resource: "future/does-not-exist.txt" });
  assert.equal(missing.selector.resource, "future/does-not-exist.txt");
});
