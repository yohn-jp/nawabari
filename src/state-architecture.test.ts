import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SESSION_MACHINE_EVENT_TYPES, SESSION_OPERATION_EVENT_TYPES } from "./state/session/index.js";

const sessionStateDirectory = path.dirname(fileURLToPath(new URL("./state/session/types.ts", import.meta.url)));

const FORBIDDEN_AUTHORITY_IMPORT =
  /(?:from\s*["'][^"']*(?:\/(?:git|session-registry)(?:\.js)?|\/registry(?:\/|\.js))|from\s*["']node:(?:fs|fs\/promises|child_process|net|http|https)["'])/u;

test("session state module exposes capability-oriented internal events", () => {
  assert.deepEqual(
    [...SESSION_MACHINE_EVENT_TYPES],
    [
      "SESSION.OBSERVE",
      "SESSION.CLOSE.REQUESTED",
      "SESSION.DISCARD.REQUESTED",
      "SESSION.DOCTOR.REQUESTED",
      "SESSION.RECONCILE.REQUESTED",
      "SESSION.GC.REQUESTED",
      "SESSION.CLEANUP.RETRY",
      "SESSION.CLEANUP.FINALIZE",
      "SESSION.MARK_STALE",
    ],
  );
  assert.equal(
    SESSION_MACHINE_EVENT_TYPES.some((event) => event.includes("session close")),
    false,
  );
  assert.equal(
    SESSION_MACHINE_EVENT_TYPES.some((event) => event.includes("session discard")),
    false,
  );
});

test("session lifecycle operations map to capability events without CLI-shaped names", () => {
  assert.deepEqual(SESSION_OPERATION_EVENT_TYPES, {
    close: "SESSION.CLOSE.REQUESTED",
    discard: "SESSION.DISCARD.REQUESTED",
    inspect: "SESSION.OBSERVE",
    doctor: "SESSION.DOCTOR.REQUESTED",
    reconcile: "SESSION.RECONCILE.REQUESTED",
    gc: "SESSION.GC.REQUESTED",
  });
});

test("session state production modules do not import mutation or observation authorities", () => {
  const productionFiles = fs
    .readdirSync(sessionStateDirectory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"));
  const allowedProductionFiles = new Set([
    "actors.ts",
    "guards.ts",
    "index.ts",
    "machine.ts",
    "projections.ts",
    "types.ts",
  ]);

  assert.notEqual(productionFiles.length, 0);
  for (const file of productionFiles) {
    assert.equal(allowedProductionFiles.has(file), true, file);
    const source = fs.readFileSync(path.join(sessionStateDirectory, file), "utf8");
    assert.doesNotMatch(source, FORBIDDEN_AUTHORITY_IMPORT, file);
  }
});

test("state module boundary does not export raw XState runtime objects", () => {
  for (const file of ["./state/index.ts", "./state/session/index.ts"]) {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), file), "utf8");
    assert.doesNotMatch(source, /\b(?:ActorRef|Snapshot|StateValue|createActor|createMachine)\b/u, file);
  }
});
