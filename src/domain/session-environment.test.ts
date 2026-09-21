import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY,
  SESSION_RUNTIME_LOGICAL_CACHE_HOME,
  SESSION_RUNTIME_LOGICAL_CONFIG_HOME,
  SESSION_RUNTIME_LOGICAL_DATA_HOME,
  SESSION_RUNTIME_LOGICAL_HOME,
  SESSION_RUNTIME_LOGICAL_STATE_HOME,
  SESSION_RUNTIME_LOGICAL_TMPDIR,
  cleanupSessionRuntimeDirectories,
  compileSessionEnvironment,
  materializeSessionRuntimeDirectories,
  serializeSessionRuntimeDirectoryManifest,
} from "./session-environment.js";

function profileInput(cache: "session" | "shared-read-only" = "session"): Record<string, unknown> {
  return {
    id: "standard-shell",
    version: "1",
    materialSelection: { profiles: ["base"], operations: [] },
    filesystem: {
      readOnly: ["src/**"],
      write: ["src/**"],
      create: ["tmp/**"],
      delete: ["tmp/**"],
      deny: [".git/**"],
      immutable: [".git/**"],
    },
    tools: [{ entrypoint: "bash", provider: { id: "fhs", requirement_id: "bash-runtime" } }],
    shell: { entrypoint: "bash" },
    environment: {
      home: "session",
      xdg: { config: "session", cache, data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
    execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
  };
}

function identity(root: string, sharedCache = false): Record<string, unknown> {
  const value: Record<string, unknown> = {
    session_id: "session-test",
    execution_id: "execution-test",
    session_root: path.join(root, "session"),
    execution_root: path.join(root, "execution"),
    owner_uid: typeof process.getuid === "function" ? process.getuid() : 0,
    owner_gid: typeof process.getgid === "function" ? process.getgid() : 0,
    term: "xterm-256color",
  };
  if (sharedCache) value.shared_cache_root = path.join(root, "shared-cache");
  return value;
}

test("compiles one fixed environment and separates durable session roots from execution tmp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-environment-"));
  try {
    const result = compileSessionEnvironment(profileInput(), identity(root));
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(result.value.environment, {
      PATH: "/nawabari/bin",
      SHELL: "/nawabari/bin/bash",
      HOME: SESSION_RUNTIME_LOGICAL_HOME,
      TMPDIR: SESSION_RUNTIME_LOGICAL_TMPDIR,
      XDG_CONFIG_HOME: SESSION_RUNTIME_LOGICAL_CONFIG_HOME,
      XDG_CACHE_HOME: SESSION_RUNTIME_LOGICAL_CACHE_HOME,
      XDG_DATA_HOME: SESSION_RUNTIME_LOGICAL_DATA_HOME,
      XDG_STATE_HOME: SESSION_RUNTIME_LOGICAL_STATE_HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      TERM: "xterm-256color",
    });
    assert.equal(result.value.manifest.session.home.durability, "durable");
    assert.equal(result.value.manifest.execution.tmp.durability, "ephemeral");
    assert.equal(result.value.manifest.execution.tmp.scope, "execution");
    assert.notEqual(result.value.manifest.session.home.path, result.value.manifest.execution.tmp.path);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not accept arbitrary environment authority or ambient display values", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-environment-"));
  try {
    const withPathOverride = identity(root);
    withPathOverride.PATH = "/host/bin";
    const rejected = compileSessionEnvironment(profileInput(), withPathOverride);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "RUNTIME_PROJECTION_INVALID");

    const invalidTerm = identity(root);
    invalidTerm.term = "bad\nterm";
    const rejectedTerm = compileSessionEnvironment(profileInput(), invalidTerm);
    assert.equal(rejectedTerm.ok, false);
    if (!rejectedTerm.ok) assert.equal(rejectedTerm.error.code, "RUNTIME_PROJECTION_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires an explicit shared cache and marks it read-only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-environment-"));
  try {
    const missing = compileSessionEnvironment(profileInput("shared-read-only"), identity(root));
    assert.equal(missing.ok, false);

    const result = compileSessionEnvironment(profileInput("shared-read-only"), identity(root, true));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.manifest.session.xdg.cache.scope, "shared-read-only");
    assert.equal(result.value.manifest.session.xdg.cache.access, "read-only");
    assert.equal(result.value.manifest.session.xdg.cache.path, path.join(root, "shared-cache"));

    const absent = materializeSessionRuntimeDirectories(result.value.manifest);
    assert.equal(absent.ok, false);
    fs.mkdirSync(path.join(root, "shared-cache"), { mode: 0o700 });
    const materialized = materializeSessionRuntimeDirectories(result.value.manifest);
    assert.equal(materialized.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("materializes and validates descriptor identity, owner, and 0700 mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-environment-"));
  try {
    const compiled = compileSessionEnvironment(profileInput(), identity(root));
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    const materialized = materializeSessionRuntimeDirectories(compiled.value.manifest);
    assert.equal(materialized.ok, true);
    if (!materialized.ok) return;
    assert.ok(materialized.value.directories.length >= 6);
    for (const observed of materialized.value.directories) {
      assert.equal(observed.mode, 0o700);
      assert.equal(observed.uid, compiled.value.manifest.owner.uid);
      assert.equal(observed.gid, compiled.value.manifest.owner.gid);
      assert.notEqual(observed.ino, "0");
    }
    const sentinel = path.join(compiled.value.manifest.session.home.path, "durable.txt");
    fs.writeFileSync(sentinel, "must survive execution cleanup");
    const cleaned = cleanupSessionRuntimeDirectories(compiled.value.manifest);
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(sentinel), true);
    assert.equal(fs.existsSync(compiled.value.manifest.execution.tmp.path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("serializes only the canonical sandbox manifest key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-session-environment-"));
  try {
    const compiled = compileSessionEnvironment(profileInput(), identity(root));
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    const serialized = serializeSessionRuntimeDirectoryManifest(compiled.value.manifest);
    assert.equal(serialized.ok, true);
    if (!serialized.ok) return;
    const document = JSON.parse(serialized.value) as Record<string, unknown>;
    assert.deepEqual(Object.keys(document), [SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY]);
    assert.equal(
      (document[SESSION_RUNTIME_DIRECTORY_SERIALIZATION_KEY] as Record<string, unknown>).contract_id,
      "nawabari.session-runtime-directory-manifest.v1",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
