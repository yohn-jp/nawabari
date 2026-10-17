import fs from "node:fs";
import path from "node:path";

import { deriveCgroupScopeName, isCanonicalManagedCgroupRoot, type CgroupFileSystem } from "./cgroups-v2.js";
import type { SessionExecutionRecord } from "./session-execution-record.js";

export const SESSION_CGROUP_TREE_OBSERVATION_CONTRACT_ID = "nawabari.session-cgroup-tree-observation.v1" as const;

const MAX_CGROUP_FILE_BYTES = 64 * 1024;
const MAX_CHILD_CGROUPS = 8192;

export type SessionCgroupTreeObservation = Readonly<{
  readonly contract_id: typeof SESSION_CGROUP_TREE_OBSERVATION_CONTRACT_ID;
  readonly session_id: string;
  readonly root: string;
  readonly state: "empty" | "populated" | "unknown";
  readonly reason:
    | "observed-empty"
    | "target-owned-scope-populated"
    | "unattributed-scope-populated"
    | "cgroup-observation-unavailable"
    | "cgroup-tree-inconsistent";
  readonly observed_scopes: number;
  readonly known_other_session_scopes: number;
}>;

type CgroupPopulationAtPath = Readonly<{
  readonly state: "empty" | "populated" | "unknown";
  readonly events_populated: 0 | 1 | null;
  readonly process_count: number | null;
}>;

type CgroupTreeFileSystem = Pick<CgroupFileSystem, "statSync" | "realpathSync" | "readFileSync" | "readdirSync">;

const nativeTreeFileSystem: CgroupTreeFileSystem = {
  statSync: (file) => fs.statSync(file),
  realpathSync: (file) => fs.realpathSync.native(file),
  readFileSync: (file) => fs.readFileSync(file, { encoding: "utf8", flag: "r" }),
  readdirSync: (directory) => fs.readdirSync(directory, { withFileTypes: true }),
};

function result(
  sessionId: string,
  root: string,
  state: SessionCgroupTreeObservation["state"],
  reason: SessionCgroupTreeObservation["reason"],
  observedScopes = 0,
  knownOtherSessionScopes = 0,
): SessionCgroupTreeObservation {
  return {
    contract_id: SESSION_CGROUP_TREE_OBSERVATION_CONTRACT_ID,
    session_id: sessionId,
    root,
    state,
    reason,
    observed_scopes: observedScopes,
    known_other_session_scopes: knownOtherSessionScopes,
  };
}

function readBounded(file: string, filesystem: Pick<CgroupFileSystem, "readFileSync">): string | null {
  try {
    const text = filesystem.readFileSync(file);
    return text.length <= MAX_CGROUP_FILE_BYTES ? text : null;
  } catch {
    return null;
  }
}

function readPopulation(directory: string, filesystem: Pick<CgroupFileSystem, "readFileSync">): CgroupPopulationAtPath {
  const events = readBounded(path.join(directory, "cgroup.events"), filesystem);
  const processes = readBounded(path.join(directory, "cgroup.procs"), filesystem);
  if (events === null || processes === null) {
    return { state: "unknown", events_populated: null, process_count: null };
  }

  const populatedLines = events.split(/\r?\n/u).filter((line) => line.startsWith("populated "));
  const match = populatedLines.length === 1 ? /^populated ([01])$/u.exec(populatedLines[0] ?? "") : null;
  const eventsPopulated = match === null ? null : (Number(match[1]) as 0 | 1);
  const processLines = processes.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const processIds = processLines.map((line) => Number(line.trim()));
  if (eventsPopulated === null || processIds.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
    return { state: "unknown", events_populated: eventsPopulated, process_count: null };
  }
  return {
    state: eventsPopulated === 1 || processIds.length > 0 ? "populated" : "empty",
    events_populated: eventsPopulated as 0 | 1,
    process_count: processIds.length,
  };
}

function safeDirectoryEntryName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  );
}

function sameExecution(left: SessionExecutionRecord, right: SessionExecutionRecord): boolean {
  return left.session_id === right.session_id && left.execution_id === right.execution_id;
}

/**
 * Prove one session has no live cgroup-owned process without confusing an
 * absent execution ledger with kernel emptiness. Every direct Nawabari child
 * cgroup is observed. A populated child is ignored only when its exact scope
 * name, boot, root, and execution identity belong to another registry session.
 */
export function observeSessionCgroupTree(
  input: Readonly<{
    readonly session_id: string;
    readonly root: string;
    readonly current_boot_id: string;
    readonly execution_records: readonly SessionExecutionRecord[];
    readonly filesystem?: CgroupFileSystem;
  }>,
): SessionCgroupTreeObservation {
  const filesystem = input.filesystem ?? nativeTreeFileSystem;
  if (
    filesystem === undefined ||
    filesystem.readdirSync === undefined ||
    !isCanonicalManagedCgroupRoot(input.root) ||
    input.current_boot_id.length === 0 ||
    input.current_boot_id.length > 256 ||
    input.current_boot_id.includes("\0")
  ) {
    return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
  }

  const parent = path.join(input.root, "nawabari");
  try {
    if (
      !filesystem.statSync(input.root).isDirectory() ||
      filesystem.realpathSync(input.root) !== input.root ||
      !filesystem.statSync(parent).isDirectory() ||
      filesystem.realpathSync(parent) !== parent
    ) {
      return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
    }
  } catch {
    return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
  }

  const ownerByName = new Map<string, SessionExecutionRecord>();
  for (const record of input.execution_records) {
    if (record.cgroup_root !== input.root || record.boot_id !== input.current_boot_id) continue;
    let name: string;
    try {
      name = deriveCgroupScopeName(record.cgroup_identity);
    } catch {
      return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
    }
    const existing = ownerByName.get(name);
    if (existing !== undefined && !sameExecution(existing, record)) {
      return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent");
    }
    ownerByName.set(name, record);
  }

  let entries: readonly { readonly name: string; readonly isDirectory: () => boolean }[];
  try {
    entries = filesystem.readdirSync(parent);
  } catch {
    return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
  }
  if (entries.length > MAX_CHILD_CGROUPS) {
    return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
  }

  const parentPopulation = readPopulation(parent, filesystem);
  if (parentPopulation.state === "unknown") {
    return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable");
  }
  // Managed processes belong in identity-derived child scopes. A process
  // directly in the shared parent has no session owner and blocks the proof.
  if (parentPopulation.process_count !== 0) {
    return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent");
  }

  let observedScopes = 0;
  let knownOtherSessionScopes = 0;
  let populatedChildren = 0;
  for (const entry of entries) {
    if (!safeDirectoryEntryName(entry.name)) {
      return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent", observedScopes);
    }
    const entryPath = path.join(parent, entry.name);
    try {
      // cgroup control files are non-directories. Canonical realpath checks
      // also reject a substituted symlink at an enumerated entry.
      if (filesystem.realpathSync(entryPath) !== entryPath) {
        return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent", observedScopes);
      }
      if (!entry.isDirectory()) {
        if (filesystem.statSync(entryPath).isDirectory()) {
          return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent", observedScopes);
        }
        continue;
      }
      if (!filesystem.statSync(entryPath).isDirectory()) {
        return result(input.session_id, input.root, "unknown", "cgroup-tree-inconsistent", observedScopes);
      }
    } catch {
      return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable", observedScopes);
    }

    observedScopes += 1;
    const population = readPopulation(entryPath, filesystem);
    if (population.state === "unknown") {
      return result(input.session_id, input.root, "unknown", "cgroup-observation-unavailable", observedScopes);
    }
    const owner = ownerByName.get(entry.name);
    if (population.state === "populated") {
      populatedChildren += 1;
      if (owner === undefined) {
        return result(
          input.session_id,
          input.root,
          "unknown",
          "unattributed-scope-populated",
          observedScopes,
          knownOtherSessionScopes,
        );
      }
      if (owner.session_id === input.session_id) {
        return result(
          input.session_id,
          input.root,
          "populated",
          "target-owned-scope-populated",
          observedScopes,
          knownOtherSessionScopes,
        );
      }
      knownOtherSessionScopes += 1;
    }
  }

  if (
    (parentPopulation.events_populated === 0 && populatedChildren > 0) ||
    (parentPopulation.events_populated === 1 && populatedChildren === 0)
  ) {
    return result(
      input.session_id,
      input.root,
      "unknown",
      "cgroup-tree-inconsistent",
      observedScopes,
      knownOtherSessionScopes,
    );
  }
  return result(input.session_id, input.root, "empty", "observed-empty", observedScopes, knownOtherSessionScopes);
}
