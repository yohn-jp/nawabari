import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { machineContract } from "./contract.js";
import {
  materializeWorktreeFileOperationCliRequest,
  parseWorktreeFileOperationCli,
  serializeWorktreeFileOperationCliOutcome,
  type WorktreeFileOperationCliAuthority,
} from "./worktree-file-operation-cli.js";
import { FileOperationError } from "./registry/file-operation-record.js";
import { SessionRegistry, type PersistedRegistry } from "./session-registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-file-operation-integration-"));
  git(root, "init", "--quiet", "--initial-branch", "main");
  git(root, "config", "user.name", "Nawabari Test");
  git(root, "config", "user.email", "nawabari@example.invalid");
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "--quiet", "-m", "fixture");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("real receipt producer is persisted in the canonical registry and retries are idempotent", () => {
  const testFixture = fixture();
  try {
    const registry = new SessionRegistry({ cwd: testFixture.root, clock: () => new Date("2026-09-22T00:00:00.000Z") });
    const session = registry.create();
    const request = {
      operationId: "operation-integration-1",
      sessionId: session.sessionId,
      operation: "create" as const,
      source: null,
      destination: "src/integration.txt",
      expectedIdentity: null,
      payloadDigest: null,
      authorityToken: "accepted-authority-token",
      fenceEpoch: 1,
    };

    const first = registry.reserveFileOperation(request);
    const retry = registry.reserveFileOperation(request);
    assert.equal(first.idempotent, false);
    assert.equal(retry.idempotent, true);
    assert.equal(registry.fileOperations(session.sessionId).length, 1);

    assert.throws(
      () => registry.reserveFileOperation({ ...request, destination: "src/other.txt" }),
      (error: unknown) => error instanceof FileOperationError && error.code === "FILE_OPERATION_ID_CONFLICT",
    );

    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as PersistedRegistry;
    assert.deepEqual(persisted.required_features, ["file-operations.v1"]);
    assert.equal(persisted.file_operations?.[0]?.operation_id, request.operationId);
  } finally {
    testFixture.cleanup();
  }
});

test("real CLI producer and machine contract share the integrated public identities", () => {
  const authority: WorktreeFileOperationCliAuthority = {
    worktree_root: process.cwd(),
    scope: { create: ["src/**"], delete: ["src/**"], deny: ["src/private/**"] },
    claims: [{ resource: "src/**", mode: "write" }],
  };
  const parsed = parseWorktreeFileOperationCli(
    [
      "session",
      "file",
      "create",
      "--session",
      "01936f5e-7b00-7abc-8def-0123456789ab",
      "--operation-id",
      "operation-cli-integration",
      "--path",
      "src/integration.txt",
      "--if-generation",
      "1",
      "--expect-absent",
      "--payload-stdin",
    ],
    { read_stdin: () => Buffer.from("real producer payload") },
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const operation = materializeWorktreeFileOperationCliRequest(parsed.value, authority);
  assert.equal(operation.ok, true);
  if (!operation.ok) return;

  const serialized = serializeWorktreeFileOperationCliOutcome({
    contract_id: "nawabari.worktree-file-operation-cli.v1",
    schema_version: 1,
    state: "rejected",
    operation_id: operation.value.operation_id,
    operation: operation.value.operation,
    code: "OPERATION_REJECTED",
    message: "The file operation was rejected.",
  });
  assert.equal(serialized.cli.operation_id, operation.value.operation_id);

  const capability = (machineContract("test").capabilities as unknown as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === "file-operations",
  );
  assert.ok(capability);
  assert.deepEqual(capability?.commands, ["session file create", "session file delete", "session file rename"]);
  assert.deepEqual(capability?.registry_features, ["file-operations.v1"]);
});
