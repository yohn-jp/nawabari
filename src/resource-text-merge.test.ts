import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyMergeExit, analyzeTextMerge } from "./resource-text-merge.js";

const GIT = "/run/current-system/sw/bin/git";

test("classifies only zero as clean and 1..127 as conflict counts", () => {
  assert.deepEqual(classifyMergeExit(0), { outcome: "clean", conflictCount: 0 });
  assert.deepEqual(classifyMergeExit(1), { outcome: "conflict", conflictCount: 1 });
  assert.deepEqual(classifyMergeExit(127), { outcome: "conflict", conflictCount: 127 });
  assert.deepEqual(classifyMergeExit(128), { outcome: "unknown", conflictCount: null, reason: "process-failed" });
  assert.deepEqual(classifyMergeExit({ status: null, signal: "SIGTERM" }), {
    outcome: "unknown",
    conflictCount: null,
    reason: "signal",
  });
  assert.deepEqual(classifyMergeExit({ status: 0, outputTruncated: true }), {
    outcome: "unknown",
    conflictCount: null,
    reason: "output-limit",
  });
});

test("merges independent hunks cleanly and reports a bounded preview", () => {
  const result = analyzeTextMerge(
    {
      base: "a\nb\nc\nd\n",
      left: "A\nb\nc\nd\n",
      right: "a\nb\nc\nD\n",
    },
    GIT,
  );
  assert.equal(result.operation, "merge-preview");
  assert.equal(result.outcome, "clean");
  assert.equal(result.conflictCount, 0);
  assert.equal(result.preview, "A\nb\nc\nD\n");
  assert.deepEqual(result.conflictRanges, []);
});

test("reports same-hunk conflicts using preview-side line numbers", () => {
  const result = analyzeTextMerge(
    {
      base: "a\nbase\nz\n",
      left: "a\nleft\nz\n",
      right: "a\nright\nz\n",
    },
    GIT,
  );
  assert.equal(result.outcome, "conflict");
  assert.equal(result.conflictCount, 1);
  assert.match(result.preview ?? "", /<<<<<<< left/u);
  assert.deepEqual(result.conflictRanges, [{ startLine: 2, endLine: 8 }]);
});

test("rejects binary, driver-dependent, and ambiguous input before invoking Git", () => {
  assert.equal(analyzeTextMerge({ base: "a", left: "b", right: "c", binary: true }, GIT).reason, "binary");
  assert.equal(
    analyzeTextMerge({ base: "a", left: "b", right: "c", mergeDriver: "custom" }, GIT).reason,
    "merge-driver",
  );
  assert.equal(
    analyzeTextMerge({ base: "a", left: "b", right: "c", mergeBases: 2 }, GIT).reason,
    "multiple-merge-bases",
  );
  assert.equal(analyzeTextMerge({ base: Buffer.from([0]), left: "b", right: "c" }, GIT).reason, "binary");
  assert.equal(analyzeTextMerge({ base: "a", left: "b", right: "c" }, "git").reason, "executable-unavailable");
});

test("output bounds and process failures remain unknown rather than clean", () => {
  const tooSmall = analyzeTextMerge({ base: "base\n", left: "left\n", right: "right\n", maxOutputBytes: 1 }, GIT);
  assert.equal(tooSmall.outcome, "unknown");
  assert.equal(tooSmall.reason, "output-limit");

  const missing = analyzeTextMerge({ base: "a", left: "b", right: "c" }, "/does/not/exist/git");
  assert.equal(missing.outcome, "unknown");
  assert.equal(missing.reason, "executable-unavailable");
});
