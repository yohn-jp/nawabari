import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyThreeWayPath } from "./resource-merge-decision.js";

test("classifies unchanged and one-sided edits before content merging", () => {
  assert.equal(classifyThreeWayPath("base", "base", "base").kind, "unchanged");
  assert.equal(classifyThreeWayPath("base", "left", "base").kind, "left-only");
  assert.equal(classifyThreeWayPath("base", "base", "right").kind, "right-only");
});

test("classifies equal two-sided edits as both-same and divergent edits as text merge", () => {
  const same = classifyThreeWayPath("base", "changed", "changed");
  assert.equal(same.kind, "both-same");
  assert.equal(same.outcome, "clean");

  const divergent = classifyThreeWayPath("base", "left", "right");
  assert.equal(divergent.kind, "text-merge");
  assert.equal(divergent.requiresTextMerge, true);
});

test("does not hide delete/modify, add/add, or mode conflicts as text clean", () => {
  assert.equal(classifyThreeWayPath("base", null, "changed").kind, "delete-modify");
  assert.equal(classifyThreeWayPath("base", null, null).kind, "delete-delete");
  assert.equal(classifyThreeWayPath(null, "left", "right").kind, "add-add");

  const modeConflict = classifyThreeWayPath(
    { content: "same", mode: "100644" },
    { content: "left", mode: "100755" },
    { content: "right", mode: "100644" },
  );
  assert.equal(modeConflict.kind, "mode-conflict");
  assert.equal(modeConflict.outcome, "conflict");

  const opposingModes = classifyThreeWayPath(
    { content: "same", mode: "100644" },
    { content: "left", mode: "100755" },
    { content: "right", mode: "100700" },
  );
  assert.equal(opposingModes.kind, "mode-conflict");
  assert.equal(opposingModes.outcome, "conflict");
});

test("preserves unsupported and incomplete observations as explicit unknowns", () => {
  assert.deepEqual(classifyThreeWayPath({ kind: "binary", content: new Uint8Array([0]) }, "left", "right"), {
    operation: "merge-preview",
    schemaVersion: 1,
    kind: "unknown",
    outcome: "unknown",
    requiresTextMerge: false,
    reason: "binary",
  });
  assert.equal(
    classifyThreeWayPath({ type: "commit", sha: "abc" }, { type: "commit", sha: "def" }, { type: "commit", sha: "ghi" })
      .reason,
    "submodule",
  );
  assert.equal(
    classifyThreeWayPath({ content: "a", mergeBases: 2 }, { content: "b" }, { content: "c" }).reason,
    "multiple-merge-bases",
  );
  assert.equal(
    classifyThreeWayPath({ exists: true }, { content: "left" }, { content: "right" }).reason,
    "path-kind-ambiguous",
  );
});
