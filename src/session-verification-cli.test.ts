import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "./cli.js";
import { machineContract } from "./contract.js";
import { DomainError, failure } from "./domain/errors.js";
import type { SessionBackend } from "./domain/session.js";

test("public verification CLI requires explicit bounded requests without invoking an execution backend", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-verifier-cli-dispatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invalid = path.join(root, "request.json");
  fs.writeFileSync(invalid, "{}\n");
  const backend = new Proxy(
    {},
    {
      get() {
        throw new Error("invalid requests must not reach backend execution");
      },
    },
  ) as SessionBackend;
  for (const args of [
    ["verification", "snapshot"],
    ["verification", "execute"],
    ["verification", "stage-candidate"],
    ["verification", "execute", "--session", "untrusted"],
    ["verification", "execute", "--request-file", invalid],
  ]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runCli(["--json", ...args], {
      cwd: root,
      backend,
      io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    });
    assert.equal(exit, 2, stdout.join("\n"));
    assert.equal(stdout.length, 1);
    assert.deepEqual(stderr, []);
    assert.equal(JSON.parse(stdout[0]).ok, false);
  }
});

test("verification snapshot dispatches only to the canonical read-only session owner", async () => {
  const sessionId = "0190f1e0-0000-7000-8000-000000000001";
  const observed: string[] = [];
  const backend = {
    async getSessionVerificationSnapshot(context, id) {
      assert.equal(context.cwd, "/owned/repository");
      observed.push(id);
      return failure(new DomainError("OPERATION_REJECTED", "The session is closed.", {}));
    },
  } as SessionBackend;
  const stdout: string[] = [];
  const exit = await runCli(["--json", "verification", "snapshot", "--session", sessionId], {
    cwd: "/owned/repository",
    backend,
    io: { stdout: (line) => stdout.push(line), stderr: () => assert.fail("machine errors use stdout") },
  });
  assert.equal(exit, 3);
  assert.deepEqual(observed, [sessionId]);
  assert.equal(JSON.parse(stdout[0]).code, "OPERATION_REJECTED");
});

test("machine discovery maps each verification command to its versioned owner result", () => {
  const contract = machineContract("0.14.0");
  const protectedCapability = (contract.capabilities as Array<Record<string, unknown>>).find(
    (capability) => capability.id === "protected-execution",
  );
  assert.ok(protectedCapability);
  const schemas = protectedCapability.result_schemas as Array<{ schema: string; commands: string[] }>;
  assert.ok(
    schemas.some(
      (entry) =>
        entry.schema === "nawabari.session-verification-snapshot.v1" &&
        entry.commands.includes("verification snapshot"),
    ),
  );
  assert.ok(
    schemas.some(
      (entry) =>
        entry.schema === "nawabari.session-bound-verification.v1" && entry.commands.includes("verification execute"),
    ),
  );
  assert.ok(
    schemas.some(
      (entry) =>
        entry.schema === "nawabari.session-candidate-bundle.v1" &&
        entry.commands.includes("verification stage-candidate"),
    ),
  );
});
