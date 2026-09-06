import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_UIDS, parseArgs, parseUids, UID_HANDOFF_CONTRACT_ID } from "./run-mottainai-uid-handoff.mjs";

test("UID handoff parser requires the exact packed artifact lineage", () => {
  assert.throws(() => parseArgs([]), /tarball and --artifact-evidence/u);
  const parsed = parseArgs([
    "--tarball",
    "/tmp/nawabari.tgz",
    "--artifact-evidence",
    "/tmp/packed.json",
    "--uids",
    "23001,23002",
  ]);
  assert.deepEqual(parsed.uids, [23001, 23002]);
  assert.equal(parsed.tarball, "/tmp/nawabari.tgz");
  assert.equal(parsed.artifactEvidence, "/tmp/packed.json");
});

test("UID handoff parser never accepts a self-repack shortcut", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.deepEqual(DEFAULT_UIDS, [23001, 23002]);
  assert.equal(UID_HANDOFF_CONTRACT_ID, "nawabari.mottainai-packed-uid-handoff.v1");
});

test("UID handoff rejects ambiguous or privileged principal selections", () => {
  assert.throws(() => parseUids("23001,23001"), /distinct/u);
  assert.throws(() => parseUids("0,23002"), /unprivileged/u);
  assert.throws(() => parseUids("23001,23002,23003"), /exactly two/u);
  assert.throws(() => parseUids("23001,abc"), /numeric/u);
});
