import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILE_OPERATION_SCHEMA_VERSION,
  MAX_FILE_OPERATION_RECORDS,
  createFileOperationRegistryState,
  fileOperationEffectMatches,
  fileOperationRequestDigest,
  parseFileOperationRegistry,
  recordFileOperationApplyAttempt,
  reconcileFileOperationReceipt,
  reconcileFileOperationReceiptAuthority,
  reserveFileOperation,
  serializeFileOperationRegistry,
  type FileOperationObservation,
  type FileOperationRecord,
  type FileOperationRegistryState,
  type FileOperationRequest,
} from "./file-operation-record.js";

const AUTHORITY = "authority-token";
const FENCE = 7;

function request(overrides: Partial<FileOperationRequest> = {}): FileOperationRequest {
  return {
    operationId: "operation-1",
    sessionId: "session-1",
    operation: "CREATE",
    source: null,
    destination: "src/output.txt",
    expectedIdentity: { inode: 17, device: 3 },
    payloadDigest: "sha256:payload-1",
    authorityToken: AUTHORITY,
    fenceEpoch: FENCE,
    ...overrides,
  };
}

function now(second: number): string {
  return `2026-09-21T00:00:0${second}.000Z`;
}

function createObservation(
  record: FileOperationRecord,
  overrides: Partial<FileOperationObservation> = {},
): FileOperationObservation {
  return {
    operationId: record.operationId,
    authorityToken: record.authorityToken,
    fenceEpoch: record.fenceEpoch,
    source: null,
    destination: {
      present: true,
      identity: record.expectedIdentity,
      payloadDigest: record.payloadDigest,
    },
    effectObserved: true,
    executionCompleted: true,
    ...overrides,
  };
}

function reservedAndRecorded(
  state: FileOperationRegistryState,
  input: FileOperationRequest = request(),
): FileOperationRecord {
  const reserved = reserveFileOperation(state, input, now(1));
  return recordFileOperationApplyAttempt(state, reserved.operationId, reserved.authorityToken, now(2));
}

test("reserves once, returns the same receipt for the same request, and rejects a different request without mutation", () => {
  const state = createFileOperationRegistryState();
  const first = reserveFileOperation(state, request(), now(1));
  const before = JSON.stringify(state);
  const second = reserveFileOperation(state, request(), now(9));

  assert.equal(second, first);
  assert.equal(JSON.stringify(state), before);
  assert.throws(
    () => reserveFileOperation(state, request({ destination: "src/other.txt" }), now(3)),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "FILE_OPERATION_ID_CONFLICT",
  );
  assert.equal(JSON.stringify(state), before);
});

test("binds operation identity to session and normalized request digest", () => {
  const upper = fileOperationRequestDigest(request({ operation: "CREATE" }));
  const lower = fileOperationRequestDigest(request({ operation: "create" }));
  assert.equal(upper, lower);
  assert.notEqual(upper, fileOperationRequestDigest(request({ sessionId: "session-2" })));
  assert.notEqual(upper, fileOperationRequestDigest(request({ fenceEpoch: FENCE + 1 })));
});

test("records the apply boundary once and does not grant a second physical attempt", () => {
  const state = createFileOperationRegistryState();
  const first = reservedAndRecorded(state);
  assert.equal(first.stage, "apply-recorded");
  assert.equal(first.applyAttempts, 1);
  const second = recordFileOperationApplyAttempt(state, first.operationId, AUTHORITY, now(3));
  assert.equal(second.stage, "apply-recorded");
  assert.equal(second.applyAttempts, 1);
});

test("matching effect without completion proof is unresolved and cannot be promoted by bytes alone", () => {
  const state = createFileOperationRegistryState();
  const recorded = reservedAndRecorded(state);
  const observed = reconcileFileOperationReceipt(
    recorded,
    createObservation(recorded, { executionCompleted: false }),
    now(3),
  );

  assert.equal(observed.effectMatches, true);
  assert.equal(observed.completionProven, false);
  assert.equal(observed.disposition, "unresolved");
  assert.equal(observed.record.stage, "unresolved");
  assert.equal(observed.record.effectObserved, true);
  assert.equal(observed.record.executionCompleted, false);
});

test("only an explicit completion observation can complete a matching receipt", () => {
  const state = createFileOperationRegistryState();
  const recorded = reservedAndRecorded(state);
  const completed = reconcileFileOperationReceipt(recorded, createObservation(recorded), now(3));

  assert.equal(completed.effectMatches, true);
  assert.equal(completed.completionProven, true);
  assert.equal(completed.disposition, "completed");
  assert.equal(completed.record.stage, "completed");
  assert.equal(completed.record.executionCompleted, true);
});

test("stale authority preserves matching effect and helper completion without certifying completion", () => {
  const state = createFileOperationRegistryState();
  const recorded = reservedAndRecorded(state);
  const reconciled = reconcileFileOperationReceiptAuthority(recorded, createObservation(recorded), false, now(3));

  assert.equal(reconciled.effectMatches, true);
  assert.equal(reconciled.helperExecutionCompleted, true);
  assert.equal(reconciled.completionProven, false);
  assert.equal(reconciled.disposition, "unresolved");
  assert.equal(reconciled.record.stage, "unresolved");
  assert.equal(reconciled.record.effectObserved, true);
  assert.equal(reconciled.record.executionCompleted, false);
});

test("mismatched or unobserved physical state stays unresolved", () => {
  const state = createFileOperationRegistryState();
  const recorded = reservedAndRecorded(state);
  const beforeAmbiguousObservation = JSON.stringify(recorded);
  assert.throws(
    () =>
      reconcileFileOperationReceipt(
        recorded,
        { ...createObservation(recorded), executionCompleted: "false" } as unknown as FileOperationObservation,
        now(2),
      ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "FILE_OPERATION_INVALID",
  );
  assert.throws(
    () =>
      reconcileFileOperationReceipt(
        recorded,
        { ...createObservation(recorded), effectObserved: "true" } as unknown as FileOperationObservation,
        now(2),
      ),
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "FILE_OPERATION_INVALID",
  );
  assert.equal(JSON.stringify(recorded), beforeAmbiguousObservation);

  const mismatch = reconcileFileOperationReceipt(
    recorded,
    createObservation(recorded, {
      destination: { present: true, identity: { inode: 99, device: 3 }, payloadDigest: recorded.payloadDigest },
      effectObserved: true,
      executionCompleted: true,
    }),
    now(3),
  );
  assert.equal(mismatch.effectMatches, false);
  assert.equal(mismatch.record.stage, "unresolved");
  assert.equal(mismatch.record.executionCompleted, false);

  const notObserved = reconcileFileOperationReceipt(
    recorded,
    createObservation(recorded, { effectObserved: false, executionCompleted: true }),
    now(4),
  );
  assert.equal(notObserved.record.stage, "unresolved");
  assert.equal(notObserved.record.effectObserved, false);
});

test("authority and fence mismatches cannot rewrite a receipt", () => {
  const state = createFileOperationRegistryState();
  const recorded = reservedAndRecorded(state);
  assert.throws(
    () => recordFileOperationApplyAttempt(state, recorded.operationId, "wrong-token", now(3)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FILE_OPERATION_AUTHORITY_DENIED",
  );

  const unrecordedState = createFileOperationRegistryState();
  const reserved = reserveFileOperation(unrecordedState, request({ operationId: "missing-authority" }), now(1));
  const beforeMissingToken = JSON.stringify(unrecordedState);
  assert.throws(
    () => recordFileOperationApplyAttempt(unrecordedState, reserved.operationId),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FILE_OPERATION_AUTHORITY_DENIED",
  );
  assert.equal(JSON.stringify(unrecordedState), beforeMissingToken);

  assert.throws(
    () => reconcileFileOperationReceipt(recorded, createObservation(recorded, { fenceEpoch: FENCE + 1 }), now(3)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FILE_OPERATION_AUTHORITY_DENIED",
  );
});

test("physical effect matching is operation-specific", () => {
  const createState = createFileOperationRegistryState();
  const createRecord = reservedAndRecorded(createState);
  assert.equal(fileOperationEffectMatches(createRecord, createObservation(createRecord)), true);

  const deleteState = createFileOperationRegistryState();
  const deleteRecord = reservedAndRecorded(
    deleteState,
    request({
      operationId: "delete-1",
      operation: "DELETE",
      source: "src/input.txt",
      destination: null,
      expectedIdentity: { inode: 17, device: 3 },
      payloadDigest: null,
    }),
  );
  assert.equal(
    fileOperationEffectMatches(deleteRecord, {
      operationId: deleteRecord.operationId,
      authorityToken: AUTHORITY,
      fenceEpoch: FENCE,
      source: { present: false, before: { present: true, identity: deleteRecord.expectedIdentity } },
      destination: null,
      effectObserved: true,
      executionCompleted: true,
    }),
    true,
  );

  const renameState = createFileOperationRegistryState();
  const renameRecord = reservedAndRecorded(
    renameState,
    request({
      operationId: "rename-1",
      operation: "RENAME",
      source: "src/from.txt",
      destination: "src/to.txt",
    }),
  );
  assert.equal(
    fileOperationEffectMatches(renameRecord, {
      operationId: renameRecord.operationId,
      authorityToken: AUTHORITY,
      fenceEpoch: FENCE,
      source: { present: false, before: { present: true, identity: renameRecord.expectedIdentity } },
      destination: {
        present: true,
        identity: renameRecord.expectedIdentity,
        payloadDigest: renameRecord.payloadDigest,
        before: { present: false },
      },
      effectObserved: true,
      executionCompleted: true,
    }),
    true,
  );
});

test("compaction removes only proven completed history and preserves unresolved receipts", () => {
  const state = createFileOperationRegistryState();
  for (let index = 0; index < MAX_FILE_OPERATION_RECORDS; index += 1) {
    const input = request({ operationId: `operation-${index}` });
    const record = reserveFileOperation(state, input, `2026-09-21T00:01:${String(index % 60).padStart(2, "0")}.000Z`);
    if (index < 2) {
      const apply = recordFileOperationApplyAttempt(state, record.operationId, AUTHORITY, now(2));
      const completed = reconcileFileOperationReceipt(apply, createObservation(apply), now(3));
      state.fileOperations[index] = completed.record;
    }
  }
  const unresolved = reserveFileOperation(state, request({ operationId: "operation-unresolved" }), now(4));
  assert.equal(state.fileOperations.length, MAX_FILE_OPERATION_RECORDS);
  assert.equal(
    state.fileOperations.some((record) => record.operationId === unresolved.operationId),
    true,
  );
  assert.equal(
    state.fileOperations.some((record) => record.stage === "unresolved"),
    false,
  );

  const apply = recordFileOperationApplyAttempt(state, unresolved.operationId, AUTHORITY, now(5));
  const unresolvedResult = reconcileFileOperationReceipt(
    apply,
    createObservation(apply, { executionCompleted: false }),
    now(6),
  );
  state.fileOperations[state.fileOperations.findIndex((record) => record.operationId === unresolved.operationId)] =
    unresolvedResult.record;
  const next = reserveFileOperation(state, request({ operationId: "operation-next" }), now(7));
  assert.equal(state.fileOperations.length, MAX_FILE_OPERATION_RECORDS);
  assert.equal(
    state.fileOperations.some((record) => record.operationId === unresolved.operationId),
    true,
  );
  assert.equal(next.stage, "prepared");
});

test("serialization rejects unknown versions and round-trips the canonical registry keys", () => {
  const state = createFileOperationRegistryState();
  reserveFileOperation(state, request(), now(1));
  const persisted = serializeFileOperationRegistry(state);
  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.file_operations[0]?.schema_version, FILE_OPERATION_SCHEMA_VERSION);
  const restored = parseFileOperationRegistry(persisted);
  assert.deepEqual(restored.fileOperations, state.fileOperations);
  assert.throws(
    () => parseFileOperationRegistry({ ...persisted, schema_version: 99 }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "FILE_OPERATION_UNSUPPORTED_SCHEMA",
  );

  const persistedRecord = persisted.file_operations[0];
  assert.ok(persistedRecord);
  const corruptedRecords = [
    { stage: "prepared", apply_attempts: 1, effect_observed: false, execution_completed: false },
    { stage: "apply-recorded", apply_attempts: 1, effect_observed: true, execution_completed: false },
    { stage: "completed", apply_attempts: 1, effect_observed: false, execution_completed: true },
    { stage: "completed", apply_attempts: 1, effect_observed: true, execution_completed: false },
    { stage: "unresolved", apply_attempts: 1, effect_observed: false, execution_completed: true },
    { stage: "unresolved", apply_attempts: 0, effect_observed: true, execution_completed: false },
  ] as const;
  for (const corruptedRecord of corruptedRecords) {
    assert.throws(
      () =>
        parseFileOperationRegistry({
          ...persisted,
          file_operations: [{ ...persistedRecord, ...corruptedRecord }],
        }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "FILE_OPERATION_CORRUPT",
    );
  }
});
