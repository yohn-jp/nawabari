import fs from "node:fs";
import path from "node:path";

import {
  FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID,
  FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION,
  selectFilesystemEnforcement,
  type FilesystemPolicyRegistryOperation,
  type FilesystemPolicyRule,
  type MaterializedFilesystemPolicy,
} from "./filesystem-policy-materialization.js";
import { LANDLOCK_ACCESS_FS, type LandlockRule } from "./landlock.js";
import { DomainError, failure, success, type DomainResult } from "./errors.js";

/** Versioned identity for the policy-to-enforcement adapter. */
export const FILESYSTEM_POLICY_ENFORCEMENT_CONTRACT_ID = "nawabari.filesystem-policy-enforcement.v1" as const;
export const FILESYSTEM_POLICY_ENFORCEMENT_SCHEMA_VERSION = 1 as const;

/** The shared public serialization surfaces consumed by later integration. */
export const SANDBOX_FILESYSTEM_POLICY_SERIALIZATION_KEY = "sandbox" as const;
export const RUNTIME_PROJECTION_FILESYSTEM_POLICY_SERIALIZATION_KEY = "runtime-projection" as const;

const LANDLOCK_WRITE_ABI = 3;
const READ_DIRECTORY = LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file | LANDLOCK_ACCESS_FS.read_dir;
const READ_FILE = LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file;
const WRITE_DIRECTORY = READ_DIRECTORY | LANDLOCK_ACCESS_FS.write_file | LANDLOCK_ACCESS_FS.truncate;
const WRITE_FILE = READ_FILE | LANDLOCK_ACCESS_FS.write_file | LANDLOCK_ACCESS_FS.truncate;

export type FilesystemPolicyMount = Readonly<{
  /** The real host entry inside the authoritative worktree. */
  readonly source: string;
  /** The same entry's path in the protected namespace. */
  readonly target: string;
  readonly access_mode: "read-only" | "read-write";
  readonly source_kind: "file" | "directory";
}>;

export type FilesystemPolicyEnforcementOptions = Readonly<{
  /** When supplied, validate that this ABI can represent every emitted rule. */
  readonly landlock_abi?: number | null;
  /** When supplied, null means that the selected runtime helper is unavailable. */
  readonly landlock_helper?: string | null;
}>;

export type FilesystemPolicyEnforcementPlan = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_ENFORCEMENT_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_ENFORCEMENT_SCHEMA_VERSION;
  readonly serialization_key: typeof SANDBOX_FILESYSTEM_POLICY_SERIALIZATION_KEY;
  readonly runtime_projection_serialization_key: typeof RUNTIME_PROJECTION_FILESYSTEM_POLICY_SERIALIZATION_KEY;
  readonly worktree: string;
  readonly policy_digest: string;
  readonly mounts: readonly FilesystemPolicyMount[];
  readonly landlock_rules: readonly LandlockRule[];
  readonly landlock_required_abi: number;
  readonly registry_operations: readonly FilesystemPolicyRegistryOperation[];
}>;

type PolicyInput = MaterializedFilesystemPolicy;

function enforcementError(reason: string, details: Record<string, string | number | boolean>): DomainResult<never> {
  return failure(new DomainError("SANDBOX_TOPOLOGY_INVALID", reason, details));
}

function capabilityError(reason: string, details: Record<string, string | number | boolean>): DomainResult<never> {
  return failure(new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", reason, details));
}

function policyDigest(input: PolicyInput): string {
  return input.digest;
}

function policySchemaIsSupported(input: PolicyInput): boolean {
  return (
    input.contract_id === FILESYSTEM_POLICY_MATERIALIZATION_CONTRACT_ID &&
    input.schema_version === FILESYSTEM_POLICY_MATERIALIZATION_SCHEMA_VERSION
  );
}

function relativePath(value: string): string | null {
  if (value.includes("\0") || value.startsWith("/")) return null;
  if (value.includes("\\")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value && !(value === "." && normalized === ".")) return null;
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized === "." ? "" : normalized;
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function pathFor(worktree: string, relative: string): string | null {
  const normalizedWorktree = path.resolve(worktree);
  if (!path.isAbsolute(worktree) || normalizedWorktree !== worktree || worktree === "/") return null;
  const normalizedRelative = relativePath(relative);
  if (normalizedRelative === null) return null;
  const candidate = path.resolve(normalizedWorktree, normalizedRelative);
  return isWithin(normalizedWorktree, candidate) ? candidate : null;
}

function sameIdentity(left: { readonly device: string; readonly inode: string }, right: fs.BigIntStats): boolean {
  return left.device === right.dev.toString() && left.inode === right.ino.toString();
}

function identityFromEvidence(
  input: PolicyInput,
  source: string,
): { readonly device: string; readonly inode: string } | null {
  const parents = input.resolution.resolved
    .filter((entry) => entry.parent.path === source)
    .map((entry) => entry.parent.identity);
  if (parents.length === 0) return null;
  const first = parents[0] as (typeof parents)[number];
  return parents.every((candidate) => candidate.device === first.device && candidate.inode === first.inode)
    ? first
    : null;
}

function literalPrefix(selector: string): string {
  const wildcard = selector.search(/[?*]/u);
  if (wildcard === -1) return selector;
  const prefix = selector.slice(0, wildcard);
  const slash = prefix.lastIndexOf("/");
  return slash === -1 ? "" : prefix.slice(0, slash);
}

/**
 * A native namespace bind is one broad grant.  If a deny selector could match
 * anything below that grant, the bind would expose a hole that Landlock cannot
 * express by pathname.  Reject the whole native bind instead of weakening
 * deny precedence or silently switching to a copied worktree.
 */
function denyMayIntersectNamespace(selector: string, root: string): boolean {
  if (root.length === 0) return true;
  const prefix = literalPrefix(selector);
  if (prefix.length === 0) return true;
  return prefix === root || prefix.startsWith(`${root}/`) || root.startsWith(`${prefix}/`);
}

function revalidateNamespaceSource(input: PolicyInput, rule: FilesystemPolicyRule, source: string): DomainResult<null> {
  const evidence = identityFromEvidence(input, source);
  if (evidence === null) {
    return enforcementError("Filesystem namespace rule has no physical identity evidence for its root.", {
      relative_path: rule.relativePath,
    });
  }
  try {
    const observed = fs.lstatSync(source, { bigint: true });
    if (observed.isSymbolicLink() || !observed.isDirectory() || !sameIdentity(evidence, observed)) {
      return enforcementError("Filesystem namespace source changed after materialization.", {
        relative_path: rule.relativePath,
      });
    }
    if (fs.realpathSync.native(source) !== source) {
      return enforcementError("Filesystem namespace source resolves through a symlink.", {
        relative_path: rule.relativePath,
      });
    }
  } catch {
    return enforcementError("Filesystem namespace source cannot be physically observed.", {
      relative_path: rule.relativePath,
    });
  }
  return success(null);
}

function resolvedKind(input: PolicyInput, rule: FilesystemPolicyRule): "file" | "directory" | null {
  if (rule.kind === "native-namespace") return "directory";
  const evidence = input.resolution.resolved.find((entry) => entry.relativePath === rule.relativePath);
  return evidence?.kind ?? null;
}

function mountMode(
  existing: FilesystemPolicyMount | undefined,
  rule: FilesystemPolicyRule,
): "read-only" | "read-write" {
  if (existing?.access_mode === "read-write" || rule.operation === "WRITE") return "read-write";
  return "read-only";
}

function compareMounts(left: FilesystemPolicyMount, right: FilesystemPolicyMount): number {
  return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
}

function compileMountsInternal(input: PolicyInput): DomainResult<readonly FilesystemPolicyMount[]> {
  if (!policySchemaIsSupported(input)) {
    return enforcementError("Filesystem policy materialization identity is unsupported.", {
      worktree: input.worktree,
    });
  }
  const selection = selectFilesystemEnforcement(input);
  if (selection.status !== "representable") {
    return enforcementError("Filesystem policy contains capabilities that cannot be safely represented.", {
      unsupported: selection.unsupported.length,
      worktree: input.worktree,
    });
  }

  const byTarget = new Map<string, FilesystemPolicyMount>();
  for (const rule of [...selection.nativePathRules, ...selection.nativeNamespace]) {
    const source = pathFor(input.worktree, rule.relativePath);
    if (source === null) {
      return enforcementError("Filesystem policy rule escapes the authoritative worktree.", {
        relative_path: rule.relativePath,
      });
    }
    const kind = resolvedKind(input, rule);
    if (kind === null) {
      return enforcementError("Filesystem policy rule has no physical kind evidence.", {
        relative_path: rule.relativePath,
      });
    }
    if (rule.kind === "native-namespace") {
      if (input.working_set.scope.deny.some((deny) => denyMayIntersectNamespace(deny, rule.relativePath))) {
        return enforcementError("A DENY selector intersects a native namespace bind.", {
          relative_path: rule.relativePath,
        });
      }
      const namespaceSource = revalidateNamespaceSource(input, rule, source);
      if (!namespaceSource.ok) return namespaceSource;
    }
    if (rule.kind === "native-path-rule") {
      const evidence = input.resolution.resolved.find((entry) => entry.relativePath === rule.relativePath);
      if (evidence === undefined) {
        return enforcementError("Filesystem policy rule has no exact physical evidence.", {
          relative_path: rule.relativePath,
        });
      }
      try {
        const observed = fs.lstatSync(source, { bigint: true });
        if (observed.isSymbolicLink() || !sameIdentity(evidence.identity, observed)) {
          return enforcementError("Filesystem policy source changed after materialization.", {
            relative_path: rule.relativePath,
          });
        }
        if ((kind === "file" && !observed.isFile()) || (kind === "directory" && !observed.isDirectory())) {
          return enforcementError("Filesystem policy source kind changed after materialization.", {
            relative_path: rule.relativePath,
          });
        }
        if (fs.realpathSync.native(source) !== source) {
          return enforcementError("Filesystem policy source resolves through a symlink.", {
            relative_path: rule.relativePath,
          });
        }
      } catch {
        return enforcementError("Filesystem policy source cannot be physically observed.", {
          relative_path: rule.relativePath,
        });
      }
    }
    const previous = byTarget.get(source);
    if (previous !== undefined && previous.source_kind !== kind) {
      return enforcementError("Filesystem policy rules disagree about a target's physical kind.", {
        target: source,
      });
    }
    byTarget.set(
      source,
      Object.freeze({
        source,
        target: source,
        access_mode: mountMode(previous, rule),
        source_kind: kind,
      }),
    );
  }
  return success(Object.freeze([...byTarget.values()].sort(compareMounts)));
}

function addRule(rules: Map<string, number>, candidate: string, access: number): void {
  if (candidate === "/" || !path.posix.isAbsolute(candidate) || candidate.includes("\0")) return;
  rules.set(candidate, (rules.get(candidate) ?? 0) | access);
}

function addParentRules(rules: Map<string, number>, candidate: string): void {
  let parent = path.posix.dirname(candidate);
  while (parent !== "/" && parent !== ".") {
    addRule(rules, parent, LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_dir);
    parent = path.posix.dirname(parent);
  }
}

/** Derive Landlock rules from the exact same mount plan used by bubblewrap. */
export function deriveFilesystemPolicyLandlockRules(mounts: readonly FilesystemPolicyMount[]): readonly LandlockRule[] {
  const rules = new Map<string, number>();
  for (const mount of mounts) {
    addParentRules(rules, mount.target);
    const access =
      mount.source_kind === "directory"
        ? mount.access_mode === "read-write"
          ? WRITE_DIRECTORY
          : READ_DIRECTORY
        : mount.access_mode === "read-write"
          ? WRITE_FILE
          : READ_FILE;
    addRule(rules, mount.target, access);
  }
  return Object.freeze(
    [...rules.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([rulePath, allowed_access]) => Object.freeze({ path: rulePath, allowed_access })),
  );
}

function requiredAbi(mounts: readonly FilesystemPolicyMount[]): number {
  return mounts.some((mount) => mount.access_mode === "read-write") ? LANDLOCK_WRITE_ABI : 1;
}

/** Reject a runtime that cannot represent the already-selected policy. */
export function validateFilesystemPolicyEnforcementRuntime(
  plan: Pick<FilesystemPolicyEnforcementPlan, "landlock_required_abi">,
  options: FilesystemPolicyEnforcementOptions,
): DomainResult<null> {
  if (
    options.landlock_helper !== undefined &&
    (options.landlock_helper === null ||
      !path.isAbsolute(options.landlock_helper) ||
      options.landlock_helper.includes("\0"))
  ) {
    return capabilityError("The selected Landlock helper is unavailable; no unrestricted fallback is allowed.", {
      required_abi: plan.landlock_required_abi,
    });
  }
  if (options.landlock_abi !== undefined) {
    if (
      options.landlock_abi === null ||
      !Number.isSafeInteger(options.landlock_abi) ||
      options.landlock_abi < plan.landlock_required_abi
    ) {
      return capabilityError("The available Landlock ABI cannot represent the selected filesystem policy.", {
        available_abi: options.landlock_abi ?? 0,
        required_abi: plan.landlock_required_abi,
      });
    }
  }
  return success(null);
}

/** Compile one materialized policy into the shared bubblewrap/Landlock plan. */
export function compileFilesystemPolicyEnforcement(
  input: PolicyInput,
  options: FilesystemPolicyEnforcementOptions = {},
): DomainResult<FilesystemPolicyEnforcementPlan> {
  const mounts = compileMountsInternal(input);
  if (!mounts.ok) return mounts;
  const plan: FilesystemPolicyEnforcementPlan = Object.freeze({
    contract_id: FILESYSTEM_POLICY_ENFORCEMENT_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_ENFORCEMENT_SCHEMA_VERSION,
    serialization_key: SANDBOX_FILESYSTEM_POLICY_SERIALIZATION_KEY,
    runtime_projection_serialization_key: RUNTIME_PROJECTION_FILESYSTEM_POLICY_SERIALIZATION_KEY,
    worktree: input.worktree,
    policy_digest: policyDigest(input),
    mounts: mounts.value,
    landlock_rules: deriveFilesystemPolicyLandlockRules(mounts.value),
    landlock_required_abi: requiredAbi(mounts.value),
    registry_operations: Object.freeze([...selectFilesystemEnforcement(input).registryOperations]),
  });
  const runtime = validateFilesystemPolicyEnforcementRuntime(plan, options);
  if (!runtime.ok) return runtime;
  return success(plan);
}

/** Compile deterministic bind declarations for the existing sandbox launcher. */
export function compileFilesystemMounts(input: PolicyInput): DomainResult<readonly FilesystemPolicyMount[]> {
  return compileMountsInternal(input);
}

/** Compile bubblewrap argv fragments without ever copying a host worktree. */
export function compileFilesystemMountArguments(input: PolicyInput): DomainResult<readonly string[]> {
  const mounts = compileMountsInternal(input);
  if (!mounts.ok) return mounts;
  const args: string[] = [];
  const directories = new Set<string>();
  const addDirectory = (candidate: string): void => {
    const parent = path.posix.dirname(candidate);
    if (parent !== "/" && !directories.has(parent)) {
      const parts = parent.split("/").filter(Boolean);
      let current = "";
      for (const part of parts) {
        current += `/${part}`;
        if (directories.has(current)) continue;
        directories.add(current);
        args.push("--dir", current);
      }
    }
  };
  for (const mount of mounts.value) {
    addDirectory(mount.target);
    if (mount.source_kind === "directory" && !directories.has(mount.target)) {
      directories.add(mount.target);
      args.push("--dir", mount.target);
    }
    args.push(mount.access_mode === "read-only" ? "--ro-bind" : "--bind", mount.source, mount.target);
  }
  return success(Object.freeze(args));
}

/** Stable JSON handoff for the later sandbox/runtime-projection integrator. */
export function serializeFilesystemPolicyEnforcement(plan: FilesystemPolicyEnforcementPlan): DomainResult<string> {
  if (
    plan.contract_id !== FILESYSTEM_POLICY_ENFORCEMENT_CONTRACT_ID ||
    plan.schema_version !== FILESYSTEM_POLICY_ENFORCEMENT_SCHEMA_VERSION ||
    plan.serialization_key !== SANDBOX_FILESYSTEM_POLICY_SERIALIZATION_KEY ||
    plan.runtime_projection_serialization_key !== RUNTIME_PROJECTION_FILESYSTEM_POLICY_SERIALIZATION_KEY
  ) {
    return enforcementError("Filesystem policy enforcement contract identity is unsupported.", {});
  }
  return success(JSON.stringify(plan));
}

export const compileFilesystemMountPlan = compileFilesystemPolicyEnforcement;
export const serializeFilesystemMountPlan = serializeFilesystemPolicyEnforcement;
export const compileFilesystemEnforcement = compileFilesystemPolicyEnforcement;
