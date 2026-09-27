import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BigIntStats } from "node:fs";

import type { JsonValue } from "./errors.js";
import { resolveRepositoryContext } from "../git.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import { REPOSITORY_PROFILE_OBSERVATION_V1 } from "../repository-runtime-observations.js";
import type { RepositoryRegistryView, SessionRegistry } from "../session-registry.js";
import { MAX_RUNTIME_RECORDS } from "../registry/runtime-records.js";
import { discoverSandboxRuntimeLayout } from "./sandbox.js";
import {
  inspectWorktreeProfile,
  type WorktreeProfileCatalogObservation,
  type WorktreeProfileRuntimeObservation,
} from "./worktree-profile-inspection.js";
import { validateWorktreeProfileCatalog, WORKTREE_PROFILE_CATALOG_PATH } from "./worktree-profile-catalog.js";
import { parsePinnedProfileRecord } from "./worktree-profile-pinning.js";
import { resolveWorktreeProfileRuntime, type WorktreeProfileRuntimeLayout } from "./worktree-profile-runtime.js";
import type { NixRuntimeClosureOptions } from "./nix-runtime-closure.js";
import type { RuntimeResolutionFhsOptions } from "./runtime-resolution.js";

const MAX_PROFILE_OBSERVATION_SESSIONS = 1_024;
const MAX_PROFILE_CATALOG_BYTES = 1_048_576;

const UNKNOWN_REGISTRY = "profile registry evidence is unavailable";
const UNKNOWN_MIXED_SAMPLE = "profile observation sources changed during collection";
const UNKNOWN_SESSION_BOUND = "profile observation exceeds its session bound";
const UNKNOWN_CATALOG = "current profile catalog evidence is unavailable";
const UNKNOWN_RUNTIME = "profile runtime evidence is unavailable";
const UNKNOWN_CATALOG_AND_RUNTIME = "profile catalog and runtime evidence are unavailable";
const UNKNOWN_PIN_IDENTITY = "profile pin source identity is inconsistent";

export type RepositoryRuntimeProfileCollectorOptions = Readonly<{
  readonly clock?: () => Date;
  /** Production defaults to current runtime discovery. */
  readonly runtimeLayout?: WorktreeProfileRuntimeLayout;
  readonly nix?: NixRuntimeClosureOptions;
  readonly fhs?: RuntimeResolutionFhsOptions;
}>;

type ProfileObservationRow = Readonly<{
  readonly session_id: string;
  readonly status: "current" | "drift" | "unknown";
  readonly profile_id: string | null;
  readonly reason: string | null;
}>;

type CatalogRead =
  | Readonly<{
      readonly status: "available";
      readonly digest: string;
      readonly observation: Extract<WorktreeProfileCatalogObservation, { readonly status: "available" }>;
    }>
  | Readonly<{ readonly status: "unknown" }>;

type ProfilePin = ReturnType<typeof parsePinnedProfileRecord>;

/**
 * Collect the parser-v1 profile section from one registry sample, the actual
 * working-tree catalog, and the existing profile runtime resolver. The
 * collector only reads repository and host state.
 */
export function collectRepositoryRuntimeProfileObservation(
  registry: SessionRegistry,
  options: RepositoryRuntimeProfileCollectorOptions = {},
): RepositoryRuntimeObservation<JsonValue> {
  let before: RepositoryRegistryView;
  try {
    before = registry.readRepositoryView();
  } catch {
    return unknownObservation(null, UNKNOWN_REGISTRY);
  }

  if (!validRepositoryView(before, registry.repository.repositoryId)) {
    return unknownObservation(null, UNKNOWN_REGISTRY);
  }
  if (!repositoryContextMatches(registry)) return unknownObservation(null, UNKNOWN_REGISTRY);
  if (before.sessions.length > MAX_PROFILE_OBSERVATION_SESSIONS) {
    return unknownObservation(timestamp(options.clock), UNKNOWN_SESSION_BOUND);
  }

  let pins: ReadonlyMap<string, ProfilePin>;
  try {
    pins = readPins(before);
  } catch {
    return unknownObservation(null, UNKNOWN_REGISTRY);
  }

  const repositoryPins = [...pins.values()].some((pin) => !isBuiltin(pin));
  const catalog = repositoryPins ? readCurrentCatalog(registry) : { status: "unknown" as const };

  let runtimeLayout: WorktreeProfileRuntimeLayout | null = null;
  if (pins.size > 0) {
    try {
      runtimeLayout = options.runtimeLayout ?? { ...discoverSandboxRuntimeLayout(), platform: process.platform };
    } catch {
      runtimeLayout = null;
    }
  }

  const runtimeByPin = new Map<string, WorktreeProfileRuntimeObservation>();
  const rows: ProfileObservationRow[] = [];
  for (const session of [...before.sessions].sort((left, right) => compareText(left.sessionId, right.sessionId))) {
    const pin = pins.get(session.sessionId);
    if (pin === undefined) {
      rows.push({ session_id: session.sessionId, status: "current", profile_id: null, reason: null });
      continue;
    }
    if (!pinMatchesSession(pin, session, before.repositoryId)) {
      rows.push({
        session_id: session.sessionId,
        status: "unknown",
        profile_id: pin.resolved.id,
        reason: UNKNOWN_PIN_IDENTITY,
      });
      continue;
    }

    let runtime = runtimeByPin.get(pin.digest);
    if (runtime === undefined) {
      runtime = observeRuntime(pin, runtimeLayout, options);
      runtimeByPin.set(pin.digest, runtime);
    }

    const currentCatalog = catalog.status === "available" ? catalog.observation : { status: "unknown" as const };
    const inspection = inspectWorktreeProfile(pin, currentCatalog, runtime);
    rows.push(projectInspection(session.sessionId, inspection));
  }

  if (repositoryPins && !sameCatalogSample(catalog, readCurrentCatalog(registry))) {
    return unknownObservation(null, UNKNOWN_MIXED_SAMPLE);
  }

  let after: RepositoryRegistryView;
  try {
    after = registry.readRepositoryView();
  } catch {
    return unknownObservation(null, UNKNOWN_MIXED_SAMPLE);
  }
  if (!sameProfileSample(before, after) || !repositoryContextMatches(registry)) {
    return unknownObservation(null, UNKNOWN_MIXED_SAMPLE);
  }

  const observedAt = timestamp(options.clock);
  if (observedAt === null) return unknownObservation(null, "profile observation time is unavailable");

  const value = {
    contract_id: REPOSITORY_PROFILE_OBSERVATION_V1,
    schema_version: 1,
    sessions: rows,
  } satisfies JsonValue;
  return Object.freeze({ status: "available", observed_at: observedAt, value });
}

function projectInspection(
  sessionId: string,
  inspection: ReturnType<typeof inspectWorktreeProfile>,
): ProfileObservationRow {
  const drift = inspection.current.drift;
  if (inspection.runtime.status !== "available") {
    return {
      session_id: sessionId,
      status: "unknown",
      profile_id: inspection.pinned.profile.id,
      reason:
        drift === "changed"
          ? "profile catalog drift; runtime evidence is unavailable"
          : drift === "unknown"
            ? UNKNOWN_CATALOG_AND_RUNTIME
            : UNKNOWN_RUNTIME,
    };
  }

  if (drift === "unknown") {
    return {
      session_id: sessionId,
      status: "unknown",
      profile_id: inspection.pinned.profile.id,
      reason: UNKNOWN_CATALOG,
    };
  }
  return {
    session_id: sessionId,
    status: drift === "same" ? "current" : "drift",
    profile_id: inspection.pinned.profile.id,
    reason: drift === "changed" ? "profile catalog drift" : null,
  };
}

function observeRuntime(
  pin: ProfilePin,
  layout: WorktreeProfileRuntimeLayout | null,
  options: RepositoryRuntimeProfileCollectorOptions,
): WorktreeProfileRuntimeObservation {
  if (layout === null) return { status: "unknown", materializer: null, providers: [] };
  try {
    const result = resolveWorktreeProfileRuntime(pin.resolved, layout, {
      ...(options.nix === undefined ? {} : { nix: options.nix }),
      ...(options.fhs === undefined ? {} : { fhs: options.fhs }),
    });
    if (!result.ok) return { status: "unknown", materializer: null, providers: [] };
    return {
      status: "available",
      materializer: result.value.materializer,
      providers: result.value.projection.executables.map((entrypoint) => entrypoint.provider),
    };
  } catch {
    return { status: "unknown", materializer: null, providers: [] };
  }
}

function readCurrentCatalog(registry: SessionRegistry): CatalogRead {
  const root = registry.repository.worktreePath;
  const catalogPath = path.join(root, WORKTREE_PROFILE_CATALOG_PATH);
  const noFollow = fs.constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") return { status: "unknown" };

  let descriptor: number | null = null;
  try {
    const canonicalRoot = fs.realpathSync(root);
    if (canonicalRoot !== path.resolve(root)) return { status: "unknown" };
    const beforePath = fs.lstatSync(catalogPath, { bigint: true });
    if (!beforePath.isFile()) return { status: "unknown" };
    if (beforePath.size <= 0n || beforePath.size > BigInt(MAX_PROFILE_CATALOG_BYTES)) return { status: "unknown" };

    descriptor = fs.openSync(catalogPath, fs.constants.O_RDONLY | noFollow);
    const beforeFile = fs.fstatSync(descriptor, { bigint: true });
    if (!beforeFile.isFile() || !sameFileIdentity(beforePath, beforeFile)) return { status: "unknown" };

    const size = Number(beforeFile.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = fs.readSync(descriptor, bytes, offset, size - offset, offset);
      if (read === 0) return { status: "unknown" };
      offset += read;
    }

    const afterFile = fs.fstatSync(descriptor, { bigint: true });
    const afterPath = fs.lstatSync(catalogPath, { bigint: true });
    if (
      !sameFileIdentity(beforeFile, afterFile) ||
      !sameFileIdentity(beforeFile, afterPath) ||
      fs.realpathSync(root) !== canonicalRoot
    ) {
      return { status: "unknown" };
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = validateWorktreeProfileCatalog(JSON.parse(text) as unknown);
    if (!parsed.ok) return { status: "unknown" };

    const digest = createHash("sha1").update(`blob ${bytes.length}\0`, "utf8").update(bytes).digest("hex");
    return {
      status: "available",
      digest,
      observation: { status: "available", digest, catalog: parsed.value },
    };
  } catch {
    return { status: "unknown" };
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The completed read remains valid even if descriptor cleanup fails.
      }
    }
  }
}

function sameCatalogSample(before: CatalogRead, after: CatalogRead): boolean {
  if (before.status === "unknown" || after.status === "unknown") {
    return before.status === "unknown" && after.status === "unknown";
  }
  return before.digest === after.digest;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readPins(view: RepositoryRegistryView): ReadonlyMap<string, ProfilePin> {
  const rawPins = view.runtimeRecords.records.pinned_profiles ?? [];
  if (rawPins.length > MAX_RUNTIME_RECORDS) throw new Error("profile pin bound exceeded");
  const sessions = new Set(view.sessions.map((session) => session.sessionId));
  const pins = new Map<string, ProfilePin>();
  for (const raw of rawPins) {
    if (typeof raw.session_id !== "string" || !sessions.has(raw.session_id) || pins.has(raw.session_id)) {
      throw new Error("profile pin owner is inconsistent");
    }
    pins.set(raw.session_id, parsePinnedProfileRecord(raw));
  }
  return pins;
}

function isBuiltin(pin: ProfilePin): boolean {
  return "kind" in pin.provenance.catalog && pin.provenance.catalog.kind === "builtin";
}

function pinMatchesSession(
  pin: ProfilePin,
  session: RepositoryRegistryView["sessions"][number],
  repositoryId: string,
): boolean {
  return (
    session.repositoryId === repositoryId &&
    session.baseRevision !== undefined &&
    pin.provenance.repository.id === repositoryId &&
    pin.provenance.repository.revision === session.baseRevision &&
    pin.provenance.base.revision === session.baseRevision
  );
}

function validRepositoryView(view: RepositoryRegistryView, expectedRepositoryId: string): boolean {
  return (
    view.repositoryId === expectedRepositoryId &&
    Number.isSafeInteger(view.registryRevision) &&
    Number.isSafeInteger(view.runtimeEpoch) &&
    Number.isSafeInteger(view.claimSetGeneration) &&
    view.sessions.every((session) => session.repositoryId === view.repositoryId)
  );
}

function sameProfileSample(before: RepositoryRegistryView, after: RepositoryRegistryView): boolean {
  return profileSampleIdentity(before) === profileSampleIdentity(after);
}

function repositoryContextMatches(registry: SessionRegistry): boolean {
  try {
    const current = resolveRepositoryContext({ cwd: registry.repository.worktreePath });
    return (
      current.repositoryId === registry.repository.repositoryId &&
      current.commonGitDirectory === registry.repository.commonGitDirectory &&
      current.worktreePath === registry.repository.worktreePath
    );
  } catch {
    return false;
  }
}

function profileSampleIdentity(view: RepositoryRegistryView): string {
  const pins = [...(view.runtimeRecords.records.pinned_profiles ?? [])]
    .map((pin) => [pin.session_id, pin.digest])
    .sort((left, right) => compareText(String(left[0]), String(right[0])));
  const sessions = [...view.sessions]
    .map((session) => [session.sessionId, session.repositoryId, session.baseRevision ?? null])
    .sort((left, right) => compareText(String(left[0]), String(right[0])));
  return JSON.stringify({
    repository_id: view.repositoryId,
    schema_version: view.registrySchemaVersion,
    registry_revision: view.registryRevision,
    runtime_epoch: view.runtimeEpoch,
    claim_set_generation: view.claimSetGeneration,
    sessions,
    pins,
  });
}

function unknownObservation(observedAt: string | null, reason: string): RepositoryRuntimeObservation<JsonValue> {
  return Object.freeze({ status: "unknown", observed_at: observedAt, reason });
}

function timestamp(clock: (() => Date) | undefined): string | null {
  try {
    const value = (clock ?? (() => new Date()))();
    const timestamp = value.toISOString();
    return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
  } catch {
    return null;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
