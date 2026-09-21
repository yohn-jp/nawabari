import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DomainError, type DomainResult } from "./domain/errors.js";
import {
  FILE_OPERATION_STATE_UNCERTAIN,
  WORKTREE_FILE_OPERATION_CONTRACT_ID,
  WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES,
  WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
  type WorktreeFileOperationResult,
} from "./domain/worktree-file-operation.js";
import {
  WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID,
  parseWorktreeFileOperationCli,
  projectWorktreeFileOperationCliOutcome,
  runWorktreeFileOperationCli,
  serializeWorktreeFileOperationCliOutcome,
  type WorktreeFileOperationCliAuthority,
} from "./worktree-file-operation-cli.js";

const AUTHORITY: WorktreeFileOperationCliAuthority = {
  worktree_root: "/tmp",
  scope: { create: ["docs/**"], delete: ["docs/**"], deny: ["docs/private/**"] },
  claims: [{ resource: "docs/**", mode: "write" }],
};

const IDENTITY = { dev: "1", ino: "2", size: 7, digest: "a".repeat(64) } as const;

function createArgs(...extra: readonly string[]): string[] {
  return [
    "session",
    "file",
    "create",
    "--session",
    "session-1",
    "--operation-id",
    "operation-create-1",
    "--path",
    "docs/new.txt",
    "--if-generation",
    "4",
    "--expect-absent",
    "--payload-stdin",
    ...extra,
  ];
}

function applied(operationId = "operation-create-1"): DomainResult<WorktreeFileOperationResult> {
  return {
    ok: true,
    value: {
      contract_id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
      schema_version: WORKTREE_FILE_OPERATION_SCHEMA_VERSION,
      operation_id: operationId,
      operation: "CREATE",
      state: "applied",
      previous_generation: 4,
      next_generation: 5,
      identity: IDENTITY,
      postcondition: { kind: "rebuild-execution-view", reason: "physical-operation-applied", generation: 5 },
    },
  };
}

test("CLI rejects a missing CAS before reading payload or invoking the owner", () => {
  let read = false;
  const result = parseWorktreeFileOperationCli(
    createArgs().filter(
      (value, index, values) => value !== "--if-generation" && values[index - 1] !== "--if-generation",
    ),
    {
      read_stdin: () => {
        read = true;
        return Buffer.from("secret");
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "MISSING_ARGUMENT");
  assert.equal(read, false);
});

test("CREATE requires explicit absent evidence and a bounded file or stdin payload", () => {
  const missingExpectation = parseWorktreeFileOperationCli(
    createArgs().filter((value) => value !== "--expect-absent"),
    { read_stdin: () => Buffer.from("body") },
  );
  assert.equal(missingExpectation.ok, false);
  if (!missingExpectation.ok) assert.equal(missingExpectation.error.code, "INVALID_ARGUMENT");

  const accepted = parseWorktreeFileOperationCli(createArgs(), { read_stdin: () => Buffer.from("body") });
  assert.equal(accepted.ok, true);

  const oversized = parseWorktreeFileOperationCli(createArgs(), {
    read_stdin: () => Buffer.alloc(WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES + 1),
  });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.error.code, "INVALID_ARGUMENT");
});

test("DELETE and RENAME require expected target evidence and reject payload argv", () => {
  const deleteResult = parseWorktreeFileOperationCli([
    "session",
    "file",
    "delete",
    "--session",
    "session-1",
    "--operation-id",
    "operation-delete-1",
    "--path",
    "docs/remove.txt",
    "--if-generation",
    "1",
  ]);
  assert.equal(deleteResult.ok, false);
  if (!deleteResult.ok) assert.equal(deleteResult.error.code, "MISSING_ARGUMENT");

  const renameResult = parseWorktreeFileOperationCli(
    [
      "session",
      "file",
      "rename",
      "--session",
      "session-1",
      "--operation-id",
      "operation-rename-1",
      "--path",
      "docs/source.txt",
      "--to-path",
      "docs/target.txt",
      "--if-generation",
      "1",
      "--expected-digest",
      "a".repeat(64),
      "--payload-stdin",
    ],
    { read_stdin: () => Buffer.from("not-accepted") },
  );
  assert.equal(renameResult.ok, false);
  if (!renameResult.ok) assert.equal(renameResult.error.code, "INVALID_ARGUMENT");
});

test("operation ID and CAS are forwarded unchanged for retry reconciliation", async () => {
  const operationIds: string[] = [];
  const generations: number[] = [];
  const first = await runWorktreeFileOperationCli(
    createArgs(),
    AUTHORITY,
    (request) => {
      operationIds.push(request.operation_id);
      generations.push(request.requested_generation);
      return applied(request.operation_id);
    },
    { read_stdin: () => Buffer.from("body") },
  );
  const retry = await runWorktreeFileOperationCli(
    createArgs(),
    AUTHORITY,
    (request) => {
      operationIds.push(request.operation_id);
      generations.push(request.requested_generation);
      return applied(request.operation_id);
    },
    { read_stdin: () => Buffer.from("body") },
  );
  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.deepEqual(operationIds, ["operation-create-1", "operation-create-1"]);
  assert.deepEqual(generations, [4, 4]);
});

test("uncertain and rejected outcomes never expose file body details", () => {
  const secret = "UNAUTHORIZED-FILE-BODY";
  const rejected = projectWorktreeFileOperationCliOutcome(
    {
      ok: false,
      error: new DomainError("OPERATION_REJECTED", secret, {
        operation_id: "operation-delete-1",
        operation_code: FILE_OPERATION_STATE_UNCERTAIN,
        state_uncertain: true,
        payload: secret,
        body: secret,
      }),
    },
    "operation-delete-1",
    "DELETE",
  );
  const serialized = JSON.stringify(serializeWorktreeFileOperationCliOutcome(rejected));
  assert.equal(rejected.state, "uncertain");
  assert.equal(rejected.message?.includes(secret), false);
  assert.equal(serialized.includes(secret), false);
  assert.match(serialized, /"cli"/u);
  assert.match(serialized, /"contract"/u);
  assert.match(serialized, /"error-vocabulary"/u);
  assert.equal(rejected.contract_id, WORKTREE_FILE_OPERATION_CLI_CONTRACT_ID);
});

test("payload files are read as bounded bytes without putting their path in the outcome", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-file-cli-"));
  const payloadFile = path.join(root, "payload.bin");
  fs.writeFileSync(payloadFile, Buffer.from("payload"));
  try {
    const parsed = parseWorktreeFileOperationCli(createArgs(), { read_stdin: () => Buffer.from("payload") });
    assert.equal(parsed.ok, true);
    const fromFile = parseWorktreeFileOperationCli([
      ...createArgs().filter((value) => value !== "--payload-stdin"),
      "--payload-file",
      payloadFile,
    ]);
    assert.equal(fromFile.ok, true);
    if (parsed.ok && fromFile.ok) assert.deepEqual(parsed.value.payload_ref, fromFile.value.payload_ref);
    assert.equal(JSON.stringify(fromFile).includes(payloadFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
