import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { CANONICAL_EXECUTABLE_ROOT } from "./runtime-executable-projection.js";
import {
  runtimeMaterializationMissingError,
  validateSessionRuntimeProjection,
  type RuntimeExecutableProvider,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

/** The stable projected entrypoint supplied by this concrete provider. */
export const PROJECTED_PNPM_ENTRYPOINT = "pnpm" as const;
export const PROJECTED_PNPM_TARGET = `${CANONICAL_EXECUTABLE_ROOT}/${PROJECTED_PNPM_ENTRYPOINT}` as const;

/** The one namespace file used as the launcher backing source. */
export const PNPM_MIDDLEWARE_LAUNCHER_TARGET = "/runtime/pnpm-middleware/pnpm-launcher" as const;
export const PNPM_MIDDLEWARE_LAUNCHER_NODE_TARGET = `${CANONICAL_EXECUTABLE_ROOT}/node` as const;

/**
 * These are deliberately concrete adapter requirements, not additions to the
 * backend-neutral runtime-profile vocabulary.  Callers add them explicitly to
 * the selected materialization input.
 */
export const PNPM_MIDDLEWARE_REQUIREMENTS = Object.freeze({
  rtk: Object.freeze({
    id: "rtk-pnpm-middleware",
    kind: "package" as const,
    name: "rtk",
    version: "0.45.0",
  }),
  real_pnpm: Object.freeze({
    id: "pnpm-pinned-backend",
    kind: "package" as const,
    name: "pnpm",
    version: "11.18.0",
  }),
});

export const PNPM_MIDDLEWARE_PROVIDER_IDS = Object.freeze({
  rtk: "rtk-pnpm",
  real_pnpm: "pnpm-real-backend",
  launcher: "rtk-pnpm-launcher",
});

/** The command supported by the pinned RTK adapter. */
export const PINNED_RTK_BACKEND_BINDING = "proxy" as const;

/** A backend is identified by its exact sandbox path and its exact host source. */
export type PnpmMiddlewareBackend = Readonly<{
  /** Exact path visible inside the sandbox. */
  readonly path: string;
  /** Exact already-materialized host source bound at `path`. */
  readonly source: string;
  readonly provider: RuntimeExecutableProvider;
}>;

export type PnpmMiddlewareMaterializationInput = Readonly<{
  readonly projection: SessionRuntimeProjection;
  /** New launcher file; it must not already exist. */
  readonly launcher_path: string;
  readonly rtk: PnpmMiddlewareBackend;
  readonly real_pnpm: PnpmMiddlewareBackend;
}>;

export type PnpmMiddlewareMaterialization = Readonly<{
  readonly projection: SessionRuntimeProjection;
  readonly launcher_source: string;
  readonly launcher_target: typeof PNPM_MIDDLEWARE_LAUNCHER_TARGET;
  readonly executable_target: typeof PROJECTED_PNPM_TARGET;
  readonly rtk_path: string;
  readonly real_pnpm_path: string;
}>;

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `pnpm middleware field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", `pnpm middleware field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function materializationMissing(requirement: RuntimeRequirement, reason: string, source?: string): DomainResult<never> {
  const canonical = runtimeMaterializationMissingError(requirement.id, requirement.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reason}.`,
      {
        ...(canonical.details ?? {}),
        reason,
        ...(source === undefined ? {} : { source }),
      },
      canonical.exitCode,
    ),
  );
}

function isCanonicalAbsolute(value: string): boolean {
  return (
    value.length > 0 &&
    path.posix.isAbsolute(value) &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    value !== "/"
  );
}

function isProjectedPath(value: string): boolean {
  return value === CANONICAL_EXECUTABLE_ROOT || value.startsWith(`${CANONICAL_EXECUTABLE_ROOT}/`);
}

function validateExactPath(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !isCanonicalAbsolute(value)) {
    return invalid(field, "expected a normalized absolute path", typeof value === "string" ? value : undefined);
  }
  if (isProjectedPath(value)) return invalid(field, "the canonical executable surface cannot be a backend", value);
  return success(value);
}

function validateBackendFile(source: string, field: string, requirement: RuntimeRequirement): DomainResult<null> {
  try {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) return invalid(field, "the backend must not be a symlink", source);
    if (!stat.isFile()) return materializationMissing(requirement, "not a regular file", source);
    if ((stat.mode & 0o111) === 0) return materializationMissing(requirement, "not executable", source);
    if (fs.realpathSync.native(source) !== source) {
      return invalid(field, "the backend resolves through a symlink", source);
    }
  } catch {
    return materializationMissing(requirement, "the backend is missing", source);
  }
  return success(null);
}

function validateProvider(value: unknown, expected: RuntimeExecutableProvider, field: string): DomainResult<null> {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { requirement_id?: unknown }).requirement_id !== "string"
  ) {
    return invalid(field, "expected a provider identity");
  }
  const provider = value as RuntimeExecutableProvider;
  if (provider.id !== expected.id || provider.requirement_id !== expected.requirement_id) {
    return invalid(field, "provider identity does not match the fixed adapter requirement", provider.id);
  }
  return success(null);
}

function requirementFor(
  projection: SessionRuntimeProjection,
  requirement: RuntimeRequirement,
): DomainResult<RuntimeRequirement> {
  const selected = projection.requirements.find((candidate) => candidate.id === requirement.id);
  if (selected === undefined) return materializationMissing(requirement, "the adapter requirement was not selected");
  if (
    selected.kind !== requirement.kind ||
    selected.name !== requirement.name ||
    selected.version !== requirement.version
  ) {
    return invalid(
      "requirements",
      "the selected adapter requirement does not match the pinned backend evidence",
      selected.id,
    );
  }
  return success(selected);
}

function hasExactReadOnlyMaterialization(
  projection: SessionRuntimeProjection,
  source: string,
  target: string,
): boolean {
  return projection.filesystem.some(
    (entry) => entry.source === source && entry.target === target && entry.access_mode === "read-only",
  );
}

function validateBackend(
  projection: SessionRuntimeProjection,
  backend: unknown,
  requirement: RuntimeRequirement,
  providerId: string,
  field: string,
): DomainResult<PnpmMiddlewareBackend> {
  if (typeof backend !== "object" || backend === null) return invalid(field, "expected an exact backend descriptor");
  const candidate = backend as Partial<PnpmMiddlewareBackend>;
  const target = validateExactPath(candidate.path, `${field}.path`);
  if (!target.ok) return target;
  const source = validateExactPath(candidate.source, `${field}.source`);
  if (!source.ok) return source;
  const provider = validateProvider(
    candidate.provider,
    { id: providerId, requirement_id: requirement.id },
    `${field}.provider`,
  );
  if (!provider.ok) return provider;
  const selected = requirementFor(projection, requirement);
  if (!selected.ok) return selected;
  const materialized = validateBackendFile(source.value, `${field}.source`, requirement);
  if (!materialized.ok) return materialized;
  if (!hasExactReadOnlyMaterialization(projection, source.value, target.value)) {
    return materializationMissing(
      selected.value,
      "no exact read-only source-to-target materialization exists",
      source.value,
    );
  }
  return success(
    Object.freeze({
      path: target.value,
      source: source.value,
      provider: candidate.provider as RuntimeExecutableProvider,
    }),
  );
}

function validateLauncherPath(
  value: unknown,
  backendSources: readonly string[],
  projection: SessionRuntimeProjection,
): DomainResult<string> {
  if (typeof value !== "string" || !isCanonicalAbsolute(value)) {
    return invalid(
      "launcher_path",
      "expected a normalized absolute path",
      typeof value === "string" ? value : undefined,
    );
  }
  if (isProjectedPath(value))
    return invalid("launcher_path", "the launcher cannot be written in the projected surface", value);
  if (backendSources.includes(value))
    return ambiguous("launcher_path", "the launcher would overwrite a backend", value);
  for (const entry of projection.filesystem) {
    if (entry.source === value || entry.source.startsWith(`${value}/`) || value.startsWith(`${entry.source}/`)) {
      return invalid("launcher_path", "the launcher cannot overlap an existing materialization", value);
    }
  }
  const parent = path.posix.dirname(value);
  try {
    if (fs.realpathSync.native(parent) !== parent)
      return invalid("launcher_path", "the parent is not canonical", parent);
  } catch {
    return materializationMissing(PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm, "the launcher parent is unavailable", parent);
  }
  try {
    fs.lstatSync(value);
    return ambiguous("launcher_path", "the launcher destination already exists", value);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return invalid("launcher_path", "the launcher destination cannot be inspected", value);
    }
  }
  return success(value);
}

function renderLauncher(rtkPath: string, realPnpmPath: string): string {
  return `#!${PNPM_MIDDLEWARE_LAUNCHER_NODE_TARGET}
import { spawn } from "node:child_process";
import process from "node:process";

const rtkPath = ${JSON.stringify(rtkPath)};
const realPnpmPath = ${JSON.stringify(realPnpmPath)};
const child = spawn(rtkPath, ["${PINNED_RTK_BACKEND_BINDING}", realPnpmPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: "inherit",
});

let childExited = false;
const signals = ["SIGHUP", "SIGINT", "SIGTERM", "SIGQUIT"];
const forwardSignal = (signal) => {
  if (!childExited) child.kill(signal);
};
for (const signal of signals) process.on(signal, forwardSignal);

child.once("error", (error) => {
  process.stderr.write("pnpm middleware could not start RTK: " + error.message + "\\n");
});
child.once("close", (code, signal) => {
  childExited = true;
  for (const forwarded of signals) process.removeListener(forwarded, forwardSignal);
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 127;
});
`;
}

function writeLauncher(source: string, content: string): DomainResult<null> {
  try {
    fs.writeFileSync(source, content, { encoding: "utf8", mode: 0o755, flag: "wx" });
    fs.chmodSync(source, 0o755);
    return success(null);
  } catch (error: unknown) {
    try {
      fs.unlinkSync(source);
    } catch {
      // Preserve the materialization error; a partial launcher is never used.
    }
    return failure(
      new DomainError(
        "RUNTIME_MATERIALIZATION_MISSING",
        "Runtime package requirement 'pnpm-pinned-backend' was not materialized: the fixed launcher could not be written.",
        {
          requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
          requirement_kind: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.kind,
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          source,
        },
      ),
    );
  }
}

/**
 * Materialize the one concrete executable provider owned by Issue #296.
 *
 * The returned projection is still consumed by #293's canonical executable
 * compiler.  This function writes one launcher file and adds one file-level
 * read-only projection; it never creates a directory projection or performs
 * command discovery.
 */
export function materializePnpmMiddleware(input: unknown): DomainResult<PnpmMiddlewareMaterialization> {
  if (typeof input !== "object" || input === null) return invalid("materialization", "expected an object");
  const candidate = input as Partial<PnpmMiddlewareMaterializationInput>;
  if (candidate.projection === undefined) return invalid("projection", "is required");
  const projection = candidate.projection;
  const rtk = validateBackend(
    projection,
    candidate.rtk,
    PNPM_MIDDLEWARE_REQUIREMENTS.rtk,
    PNPM_MIDDLEWARE_PROVIDER_IDS.rtk,
    "rtk",
  );
  if (!rtk.ok) return rtk;
  const realPnpm = validateBackend(
    projection,
    candidate.real_pnpm,
    PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm,
    PNPM_MIDDLEWARE_PROVIDER_IDS.real_pnpm,
    "real_pnpm",
  );
  if (!realPnpm.ok) return realPnpm;
  if (rtk.value.path === realPnpm.value.path || rtk.value.source === realPnpm.value.source) {
    return ambiguous("backends", "RTK and real pnpm cannot resolve to the same path", rtk.value.path);
  }
  if (rtk.value.path === realPnpm.value.source || rtk.value.source === realPnpm.value.path) {
    return ambiguous(
      "backends",
      "RTK and real pnpm cannot cross-resolve between host and sandbox paths",
      rtk.value.path,
    );
  }

  const launcher = validateLauncherPath(candidate.launcher_path, [rtk.value.source, realPnpm.value.source], projection);
  if (!launcher.ok) return launcher;

  const requirements = [...projection.requirements];
  for (const requirement of [PNPM_MIDDLEWARE_REQUIREMENTS.rtk, PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm]) {
    const existing = requirements.find((candidateRequirement) => candidateRequirement.id === requirement.id);
    if (existing !== undefined) {
      if (
        existing.kind !== requirement.kind ||
        existing.name !== requirement.name ||
        existing.version !== requirement.version
      ) {
        return invalid(
          "requirements",
          "a pinned middleware requirement conflicts with the selected projection",
          requirement.id,
        );
      }
      continue;
    }
    requirements.push(requirement);
  }

  const projected = {
    policy: projection.policy,
    profile: projection.profile,
    requirements,
    filesystem: [
      ...projection.filesystem,
      {
        source: launcher.value,
        target: PNPM_MIDDLEWARE_LAUNCHER_TARGET,
        access_mode: "read-only" as const,
        provenance: "package" as const,
      },
    ],
    executables: [
      ...projection.executables,
      {
        name: PROJECTED_PNPM_ENTRYPOINT,
        target: PNPM_MIDDLEWARE_LAUNCHER_TARGET,
        provider: {
          id: PNPM_MIDDLEWARE_PROVIDER_IDS.launcher,
          requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
        },
        provenance: "package" as const,
      },
    ],
  };
  const validated = validateProjectedPnpmProjection(projected);
  if (!validated.ok) return validated;

  const written = writeLauncher(launcher.value, renderLauncher(rtk.value.path, realPnpm.value.path));
  if (!written.ok) return written;
  return success(
    Object.freeze({
      projection: validated.value,
      launcher_source: launcher.value,
      launcher_target: PNPM_MIDDLEWARE_LAUNCHER_TARGET,
      executable_target: PROJECTED_PNPM_TARGET,
      rtk_path: rtk.value.path,
      real_pnpm_path: realPnpm.value.path,
    }),
  );
}

function validateProjectedPnpmProjection(
  input: Omit<SessionRuntimeProjection, "contract_id" | "schema_version">,
): DomainResult<SessionRuntimeProjection> {
  return validateSessionRuntimeProjection(input);
}
