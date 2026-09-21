import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  FILE_OPERATION_STATE_UNCERTAIN,
  WORKTREE_FILE_OPERATION_CONTRACT_ID,
  WORKTREE_FILE_OPERATION_HELPER,
  WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES,
  deserializeWorktreeFileOperation,
  executeWorktreeFileOperation,
  mutateWorktreeFile,
  prepareWorktreeFileOperation,
  serializeWorktreeFileOperation,
  validateWorktreeFileOperation,
  type WorktreeFileIdentity,
  type WorktreeFileOperationExecutionOptions,
} from "./worktree-file-operation.js";

// Test setup resolves the executable once; production execution receives this
// value from strict Landlock materialization and never searches PATH.
function materializedPythonExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    try {
      const canonical = fs.realpathSync.native(path.join(directory, "python3"));
      const stat = fs.statSync(canonical);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return canonical;
    } catch {
      // Try the next test-runtime candidate.
    }
  }
  throw new Error("The test runtime has no materialized python3 executable.");
}

const TEST_LANDLOCK_HELPER = materializedPythonExecutable();

function helperOptions(
  overrides: Omit<WorktreeFileOperationExecutionOptions, "landlock_helper"> = {},
): WorktreeFileOperationExecutionOptions {
  return { landlock_helper: TEST_LANDLOCK_HELPER, ...overrides };
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function request(
  root: string,
  operation: "CREATE" | "DELETE" | "RENAME",
  target: string,
  expected: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    contract_id: WORKTREE_FILE_OPERATION_CONTRACT_ID,
    schema_version: 1,
    session_id: "session-f04-test",
    operation_id: `operation-${operation.toLowerCase()}-${target.replaceAll("/", "-")}`,
    operation,
    worktree_root: root,
    path: target,
    expected_digest: expected,
    requested_generation: 1,
    scope: { create: ["docs/**", "renamed/**"], delete: ["docs/**", "renamed/**"], deny: ["docs/private/**"] },
    claims: [
      { resource: "docs/**", mode: "write" },
      { resource: "renamed/**", mode: "write" },
    ],
    ...(operation === "CREATE"
      ? { payload_ref: { encoding: "base64", data: Buffer.from("payload").toString("base64") } }
      : {}),
    ...extra,
  };
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-f04-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "renamed"));
  return root;
}

function cleanup(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

test("validation requires both typed authority and exact endpoint scope", () => {
  const root = fixture();
  try {
    const accepted = validateWorktreeFileOperation(request(root, "CREATE", "docs/new.txt", null));
    assert.equal(accepted.ok, true);

    const denied = validateWorktreeFileOperation(request(root, "CREATE", "docs/private/secret.txt", null));
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "OPERATION_REJECTED");

    const missingEndpoint = validateWorktreeFileOperation({
      ...request(root, "RENAME", "docs/new.txt", digest("payload")),
      to_path: "unclaimed/new.txt",
    });
    assert.equal(missingEndpoint.ok, false);
  } finally {
    cleanup(root);
  }
});

test("execution fails closed without the canonical materialized Landlock helper", () => {
  const root = fixture();
  try {
    const prepared = prepareWorktreeFileOperation(request(root, "CREATE", "docs/no-helper.txt", null));
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    let helperInvoked = false;
    const result = executeWorktreeFileOperation(prepared.value, {
      landlock_helper: null,
      run_helper: () => {
        helperInvoked = true;
        return JSON.stringify({ ok: true });
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
    assert.equal(helperInvoked, false);
    assert.equal(fs.existsSync(path.join(root, "docs", "no-helper.txt")), false);
  } finally {
    cleanup(root);
  }
});

test("CREATE is exclusive and a failed retry cannot overwrite content", () => {
  const root = fixture();
  try {
    const first = mutateWorktreeFile(request(root, "CREATE", "docs/new.txt", null), helperOptions());
    assert.equal(first.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "docs/new.txt"), "utf8"), "payload");

    const retry = mutateWorktreeFile(request(root, "CREATE", "docs/new.txt", null), helperOptions());
    assert.equal(retry.ok, false);
    assert.equal(fs.readFileSync(path.join(root, "docs/new.txt"), "utf8"), "payload");
  } finally {
    cleanup(root);
  }
});

test("DELETE requires expected identity and refuses a second deletion", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "docs", "remove.txt"), "remove-me");
    const expected: WorktreeFileIdentity = {
      dev: String(fs.statSync(path.join(root, "docs", "remove.txt")).dev),
      ino: String(fs.statSync(path.join(root, "docs", "remove.txt")).ino),
      size: Buffer.byteLength("remove-me"),
      digest: digest("remove-me"),
    };
    const first = mutateWorktreeFile(
      request(root, "DELETE", "docs/remove.txt", expected.digest, { expected_identity: expected }),
      helperOptions(),
    );
    assert.equal(first.ok, true);
    assert.equal(fs.existsSync(path.join(root, "docs", "remove.txt")), false);

    const retry = mutateWorktreeFile(
      request(root, "DELETE", "docs/remove.txt", expected.digest, {
        expected_identity: expected,
        operation_id: "operation-delete-retry",
      }),
      helperOptions(),
    );
    assert.equal(retry.ok, false);
  } finally {
    cleanup(root);
  }
});

test("DELETE and RENAME reject files with unknown hardlink identity", () => {
  const root = fixture();
  try {
    const content = "hardlink-me";
    const source = path.join(root, "docs", "hardlinked.txt");
    const alias = path.join(root, "docs", "hardlinked-alias.txt");
    fs.writeFileSync(source, content);
    fs.linkSync(source, alias);
    const stat = fs.statSync(source);
    const expected = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: Buffer.byteLength(content),
      digest: digest(content),
    } satisfies WorktreeFileIdentity;

    const deletion = mutateWorktreeFile(
      request(root, "DELETE", "docs/hardlinked.txt", expected.digest, { expected_identity: expected }),
      helperOptions(),
    );
    assert.equal(deletion.ok, false);
    if (!deletion.ok) {
      assert.equal(deletion.error.details?.operation_code, "TARGET_IDENTITY_UNAVAILABLE");
      assert.equal(deletion.error.details?.state_uncertain, false);
    }
    assert.equal(fs.readFileSync(source, "utf8"), content);
    assert.equal(fs.readFileSync(alias, "utf8"), content);

    const rename = mutateWorktreeFile(
      request(root, "RENAME", "docs/hardlinked.txt", expected.digest, {
        to_path: "renamed/hardlinked.txt",
        expected_identity: expected,
      }),
      helperOptions(),
    );
    assert.equal(rename.ok, false);
    if (!rename.ok) assert.equal(rename.error.details?.operation_code, "SOURCE_IDENTITY_UNAVAILABLE");
    assert.equal(fs.existsSync(path.join(root, "renamed", "hardlinked.txt")), false);
  } finally {
    cleanup(root);
  }
});

test("RENAME checks source identity and destination CREATE authority without replacement", () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, "docs", "source.txt"), "rename-me");
    const source = path.join(root, "docs", "source.txt");
    const stat = fs.statSync(source);
    const expected: WorktreeFileIdentity = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: 9,
      digest: digest("rename-me"),
    };
    const rename = mutateWorktreeFile(
      request(root, "RENAME", "docs/source.txt", expected.digest, {
        to_path: "renamed/target.txt",
        expected_identity: expected,
      }),
      helperOptions(),
    );
    assert.equal(rename.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "renamed", "target.txt"), "utf8"), "rename-me");
    assert.equal(fs.existsSync(source), false);

    const occupied = path.join(root, "docs", "occupied.txt");
    fs.writeFileSync(occupied, "keep");
    fs.writeFileSync(source, "source-again");
    const occupiedStat = fs.statSync(source);
    const rejected = mutateWorktreeFile(
      request(root, "RENAME", "docs/source.txt", digest("source-again"), {
        operation_id: "operation-rename-occupied",
        to_path: "docs/occupied.txt",
        expected_identity: {
          dev: String(occupiedStat.dev),
          ino: String(occupiedStat.ino),
          size: 12,
          digest: digest("source-again"),
        },
      }),
      helperOptions(),
    );
    assert.equal(rejected.ok, false);
    assert.equal(fs.readFileSync(occupied, "utf8"), "keep");
    assert.equal(fs.readFileSync(source, "utf8"), "source-again");
  } finally {
    cleanup(root);
  }
});

test("serialization uses registry and domain-session authority keys", () => {
  const root = fixture();
  try {
    const prepared = prepareWorktreeFileOperation(request(root, "CREATE", "docs/new.txt", null));
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const serialized = serializeWorktreeFileOperation(prepared.value.request);
    assert.equal(Object.hasOwn(serialized, "registry"), true);
    assert.equal(Object.hasOwn(serialized, "domain-session"), true);
    const restored = deserializeWorktreeFileOperation(serialized);
    assert.equal(restored.ok, true);
    assert.equal(WORKTREE_FILE_OPERATION_HELPER.includes("os.system"), false);
  } finally {
    cleanup(root);
  }
});

test("helper protocol failures are reported as uncertain evidence", () => {
  const root = fixture();
  try {
    const prepared = prepareWorktreeFileOperation(request(root, "CREATE", "docs/uncertain.txt", null));
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const result = mutateWorktreeFile(
      request(root, "CREATE", "docs/uncertain.txt", null),
      helperOptions({
        run_helper: () =>
          JSON.stringify({
            ok: false,
            code: "CREATE_UNCERTAIN",
            message: "post-rename registry evidence unavailable",
            uncertain: true,
          }),
      }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.details?.operation_code, FILE_OPERATION_STATE_UNCERTAIN);
      assert.equal(result.error.details?.state_uncertain, true);
    }
  } finally {
    cleanup(root);
  }
});

test("oversized payloads are rejected before helper spawn", () => {
  const root = fixture();
  try {
    let helperInvoked = false;
    const result = mutateWorktreeFile(
      request(root, "CREATE", "docs/oversized.txt", null, {
        payload_ref: {
          encoding: "base64",
          data: Buffer.alloc(WORKTREE_FILE_OPERATION_MAX_PAYLOAD_BYTES + 1).toString("base64"),
        },
      }),
      {
        ...helperOptions(),
        run_helper: () => {
          helperInvoked = true;
          return JSON.stringify({ ok: false, code: "unexpected", message: "helper must not run" });
        },
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
    assert.equal(helperInvoked, false);
    assert.equal(fs.existsSync(path.join(root, "docs", "oversized.txt")), false);
  } finally {
    cleanup(root);
  }
});
