import assert from "node:assert/strict";
import { test } from "node:test";

import { deriveCgroupScopeName, type CgroupFileSystem } from "./cgroups-v2.js";
import { observeSessionCgroupTree } from "./session-cgroup-tree-observation.js";
import {
  SESSION_EXECUTION_RECORD_CONTRACT_ID,
  SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
  type SessionExecutionRecord,
} from "./session-execution-record.js";

const ROOT = "/sys/fs/cgroup/user.slice/nawabari-drain-test";
const PARENT = `${ROOT}/nawabari`;
const BOOT = "test-boot-id";

type VirtualCgroupFs = CgroupFileSystem & {
  addScope: (identity: { readonly session_id: string; readonly execution_id: string }, populated: boolean) => string;
  setParentPopulated: (populated: boolean) => void;
  failRead: (file: string) => void;
};

function fixture(): VirtualCgroupFs {
  const directories = new Set([ROOT, PARENT]);
  const files = new Map<string, string>([
    [`${PARENT}/cgroup.events`, "populated 0\n"],
    [`${PARENT}/cgroup.procs`, ""],
    [`${PARENT}/cgroup.subtree_control`, "+cpu +memory +pids\n"],
  ]);
  const failedReads = new Set<string>();
  const filesystem: VirtualCgroupFs = {
    statSync: (file) => ({
      isDirectory: () => directories.has(file),
      isFile: () => files.has(file),
    }),
    realpathSync: (file) => {
      if (!directories.has(file) && !files.has(file)) throw new Error(`missing path: ${file}`);
      return file;
    },
    readFileSync: (file) => {
      if (failedReads.has(file)) throw new Error(`unreadable file: ${file}`);
      const value = files.get(file);
      if (value === undefined) throw new Error(`missing file: ${file}`);
      return value;
    },
    readdirSync: (directory) => {
      if (!directories.has(directory)) throw new Error(`missing directory: ${directory}`);
      const names = new Set<string>();
      for (const candidate of directories) {
        if (candidate !== directory && candidate.startsWith(`${directory}/`)) {
          const relative = candidate.slice(directory.length + 1);
          if (!relative.includes("/")) names.add(relative);
        }
      }
      for (const candidate of files.keys()) {
        if (candidate.startsWith(`${directory}/`)) {
          const relative = candidate.slice(directory.length + 1);
          if (!relative.includes("/")) names.add(relative);
        }
      }
      return [...names].map((name) => ({ name, isDirectory: () => directories.has(`${directory}/${name}`) }));
    },
    writeFileSync: (file, value) => {
      files.set(file, value);
    },
    mkdirSync: (directory) => {
      directories.add(directory);
    },
    rmdirSync: (directory) => {
      directories.delete(directory);
    },
    addScope: (identity, populated) => {
      const scope = `${PARENT}/${deriveCgroupScopeName(identity)}`;
      directories.add(scope);
      files.set(`${scope}/cgroup.events`, `populated ${populated ? 1 : 0}\n`);
      files.set(`${scope}/cgroup.procs`, "");
      return scope;
    },
    setParentPopulated: (populated) => {
      files.set(`${PARENT}/cgroup.events`, `populated ${populated ? 1 : 0}\n`);
    },
    failRead: (file) => failedReads.add(file),
  };
  return filesystem;
}

function executionRecord(
  sessionId: string,
  executionId: string,
  root = ROOT,
  bootId = BOOT,
): SessionExecutionRecord {
  return {
    contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
    schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
    session_id: sessionId,
    execution_id: executionId,
    state: "exited",
    profile_digest: "a".repeat(64),
    filesystem_token: "b".repeat(64),
    runtime_epoch: 1,
    boot_id: bootId,
    supervisor_pid: null,
    supervisor_starttime: null,
    cgroup_identity: { session_id: sessionId, execution_id: executionId },
    cgroup_root: root,
    release_attempt: null,
    created_at: "2026-10-17T00:00:00.000Z",
    updated_at: "2026-10-17T00:00:01.000Z",
  };
}

const observe = (
  filesystem: CgroupFileSystem,
  sessionId: string,
  records: readonly SessionExecutionRecord[] = [],
) =>
  observeSessionCgroupTree({
    session_id: sessionId,
    root: ROOT,
    current_boot_id: BOOT,
    execution_records: records,
    filesystem,
  });

test("never-launched sessions are empty only after the shared managed cgroup tree is observed", () => {
  const filesystem = fixture();
  const result = observe(filesystem, "target-session");
  assert.equal(result.state, "empty");
  assert.equal(result.reason, "observed-empty");
  assert.equal(result.observed_scopes, 0);
});

test("a populated child without exact current-boot registry ownership blocks the proof", () => {
  const filesystem = fixture();
  const identity = { session_id: "unrecorded-session", execution_id: "unrecorded-run" };
  filesystem.addScope(identity, true);
  filesystem.setParentPopulated(true);

  const result = observe(filesystem, "target-session");
  assert.equal(result.state, "unknown");
  assert.equal(result.reason, "unattributed-scope-populated");
});

test("an exact populated sibling scope is excluded while target emptiness remains observable", () => {
  const filesystem = fixture();
  const sibling = executionRecord("sibling-session", "sibling-run");
  filesystem.addScope(sibling.cgroup_identity, true);
  filesystem.setParentPopulated(true);

  const result = observe(filesystem, "target-session", [sibling]);
  assert.equal(result.state, "empty");
  assert.equal(result.known_other_session_scopes, 1);
});

test("a target-owned populated scope prevents an empty-session drain result", () => {
  const filesystem = fixture();
  const target = executionRecord("target-session", "target-run");
  filesystem.addScope(target.cgroup_identity, true);
  filesystem.setParentPopulated(true);

  const result = observe(filesystem, "target-session", [target]);
  assert.equal(result.state, "populated");
  assert.equal(result.reason, "target-owned-scope-populated");
});

test("wrong-boot owners and unavailable population files never prove sibling emptiness", () => {
  const filesystem = fixture();
  const sibling = executionRecord("sibling-session", "sibling-run", ROOT, "old-boot");
  const scope = filesystem.addScope(sibling.cgroup_identity, true);
  filesystem.setParentPopulated(true);

  const wrongBoot = observe(filesystem, "target-session", [sibling]);
  assert.equal(wrongBoot.state, "unknown");
  assert.equal(wrongBoot.reason, "unattributed-scope-populated");

  filesystem.failRead(`${scope}/cgroup.procs`);
  const unavailable = observe(filesystem, "target-session", []);
  assert.equal(unavailable.state, "unknown");
  assert.equal(unavailable.reason, "cgroup-observation-unavailable");
});
