import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError, type JsonObject } from "./domain/errors.js";
import { renderFailure, renderSuccess } from "./presentation.js";

const session: JsonObject = {
  schema_version: 1,
  session_id: "0190f1e0-0000-7000-8000-000000000001",
  repository: "/tmp/example-repository",
  worktree: "/tmp/example-worktree",
  branch: "feat/example",
  state: "active",
  created_at: "2026-08-10T00:00:00.000Z",
  updated_at: "2026-08-10T00:00:00.000Z",
};

test("renders primitives, nested objects, and arrays as concise human text", () => {
  const output = renderSuccess("human", "example", {
    string: "text",
    number: 42,
    boolean: false,
    nullish: null,
    flat: { foo: "bar", count: 2 },
    nested: {
      outer: { inner: "value" },
      matrix: [
        [1, 2],
        [3, 4],
      ],
    },
    primitive_array: ["one", 2, true, null],
    records: [
      { name: "first", details: { enabled: true } },
      { name: "second", values: ["x", "y"] },
    ],
  });

  assert.equal(
    output,
    [
      "example: ok",
      "  string: text",
      "  number: 42",
      "  boolean: false",
      "  nullish: null",
      "  flat:",
      "    foo: bar",
      "    count: 2",
      "  nested:",
      "    outer:",
      "      inner: value",
      "    matrix:",
      "      - [1, 2]",
      "      - [3, 4]",
      "  primitive_array: [one, 2, true, null]",
      "  records:",
      "    - name: first",
      "      details:",
      "        enabled: true",
      "    - name: second",
      "      values: [x, y]",
    ].join("\n"),
  );
  assert.doesNotMatch(output, /\{"foo"/u);
  assert.doesNotMatch(output, /\[\{"name"/u);
  assert.doesNotMatch(output, /\[object Object\]/u);
});

test("renders session create, show, and close payloads recursively", () => {
  const sessionOutput = [
    "  schema_version: 1",
    "  session_id: 0190f1e0-0000-7000-8000-000000000001",
    "  repository: /tmp/example-repository",
    "  worktree: /tmp/example-worktree",
    "  branch: feat/example",
    "  state: active",
    "  created_at: 2026-08-10T00:00:00.000Z",
    "  updated_at: 2026-08-10T00:00:00.000Z",
  ];

  for (const command of ["session create", "session show"]) {
    assert.equal(renderSuccess("human", command, session), [`${command}: ok`, ...sessionOutput].join("\n"));
  }

  assert.equal(
    renderSuccess("human", "session close", {
      session,
      worktree_removed: true,
      branch_removed: true,
      idempotent: false,
    }),
    [
      "session close: ok",
      "  session:",
      ...sessionOutput.map((line) => `  ${line}`),
      "  worktree_removed: true",
      "  branch_removed: true",
      "  idempotent: false",
    ].join("\n"),
  );
});

test("renders structured rejection details without inline JSON", () => {
  const output = renderFailure(
    "human",
    "session create",
    new DomainError("BRANCH_OWNED_BY_OTHER_SESSION", "Branch is already owned: refs/heads/foo", {
      branch: "refs/heads/foo",
      ownerSessionId: "0190f1e0-0000-7000-8000-000000000002",
      metadata: { attempts: 2, active: true },
      conflicts: [
        { session_id: "0190f1e0-0000-7000-8000-000000000002", state: "active" },
        { session_id: "0190f1e0-0000-7000-8000-000000000003", state: "stale" },
      ],
    }),
  );

  assert.equal(
    output,
    [
      "session create: rejected",
      "  code: BRANCH_OWNED_BY_OTHER_SESSION",
      "  message: Branch is already owned: refs/heads/foo",
      "  details:",
      "    branch: refs/heads/foo",
      "    ownerSessionId: 0190f1e0-0000-7000-8000-000000000002",
      "    metadata:",
      "      attempts: 2",
      "      active: true",
      "    conflicts:",
      "      - session_id: 0190f1e0-0000-7000-8000-000000000002",
      "        state: active",
      "      - session_id: 0190f1e0-0000-7000-8000-000000000003",
      "        state: stale",
    ].join("\n"),
  );
  assert.doesNotMatch(output, /\{"branch"/u);
  assert.doesNotMatch(output, /\[\{"session_id"/u);
});

test("renders status and doctor-style check records without a command-specific branch", () => {
  const statusOutput = renderSuccess("human", "status", {
    repository: "/tmp/example-repository",
    current_session: session,
    sessions: [session],
    capabilities: {
      session_registry: true,
      provisioning: true,
      lifecycle: true,
      garbage_collection: false,
      current_session_resolution: true,
    },
  });
  const doctorOutput = renderSuccess("human", "doctor", {
    ok: true,
    checks: [
      {
        name: "git",
        status: "ok",
        code: null,
        message: "Git is available.",
        details: { version: "2.46.0" },
      },
    ],
    repository: {
      top_level: "/tmp/example-repository",
      common_dir: "/tmp/example-repository/.git",
      registry_path: "/tmp/example-repository/.git/nawabari/session-registry.json",
    },
  });

  assert.match(statusOutput, /  current_session:\n    schema_version: 1/u);
  assert.match(statusOutput, /  sessions:\n    - schema_version: 1/u);
  assert.match(statusOutput, /  capabilities:\n    session_registry: true/u);
  assert.match(doctorOutput, /  checks:\n    - name: git\n      status: ok/u);
  assert.match(doctorOutput, /      details:\n        version: 2\.46\.0/u);
  assert.doesNotMatch(statusOutput, /\{"schema_version"/u);
  assert.doesNotMatch(doctorOutput, /\[\{"name"/u);
});

test("keeps JSON success and failure rendering unchanged", () => {
  const payload = { session, flags: [true, false] };
  assert.equal(
    renderSuccess("json", "session close", payload),
    JSON.stringify({ ok: true, command: "session close", ...payload }),
  );

  const error = new DomainError("OPERATION_REJECTED", "Operation rejected.", {
    allowed: false,
    details: { reason: "owner_mismatch", retryable: false },
  });
  assert.equal(
    renderFailure("json", "guard", error),
    JSON.stringify({
      ok: false,
      command: "guard",
      code: "OPERATION_REJECTED",
      message: "Operation rejected.",
      allowed: false,
      details: error.details,
    }),
  );
});
