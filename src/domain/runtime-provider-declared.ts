import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import { inspectRuntimeFile, readRuntimeFile, type RuntimeFileIdentity } from "./runtime-file-identity.js";
import {
  runtimeMaterializationMissingError,
  runtimeProviderMissingError,
  type ProjectedExecutableEntrypoint,
  type RuntimeExecutableProvider,
  type RuntimeFilesystemProjection,
  type RuntimeProjectionProvenance,
  type RuntimeRequirement,
} from "./runtime-projection.js";

/** Versioned contract for host-declared, file-level tool material. */
export const DECLARED_TOOL_MATERIAL_CONTRACT_ID = "nawabari.declared-tool-material.v1" as const;
export const DECLARED_TOOL_MATERIAL_SCHEMA_VERSION = 1 as const;

/** The runtime-resolution document owns the host material handoff. */
export const DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY = "runtime-resolution" as const;

/** Bounded file size inspected while proving a declared material snapshot. */
export const DECLARED_TOOL_MATERIAL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DECLARED_TOOL_MATERIAL_MAX_FILES = 4_096;
export const DECLARED_TOOL_MATERIAL_MAX_TEXT = 4_096;

const SHA256 = /^[a-f0-9]{64}$/u;
const STABLE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/u;
const ENTRYPOINT = /^[A-Za-z0-9][A-Za-z0-9+._-]*$/u;

/** JSON-safe inode/device evidence captured at declaration time. */
export type DeclaredToolFileIdentity = Readonly<{
  readonly dev: string;
  readonly ino: string;
}>;

/** One explicitly declared regular file in the executable/source closure. */
export type DeclaredToolFile = Readonly<{
  /** Canonical absolute host path; this is never looked up through PATH. */
  readonly source: string;
  /** SHA-256 of the bytes inspected at declaration time. */
  readonly digest: string;
  /** Linux device/inode identity inspected at declaration time. */
  readonly identity: DeclaredToolFileIdentity;
}>;

/** Host-side declaration consumed by the runtime-resolution boundary. */
export type DeclaredToolMaterial = Readonly<{
  readonly contract_id: typeof DECLARED_TOOL_MATERIAL_CONTRACT_ID;
  readonly schema_version: typeof DECLARED_TOOL_MATERIAL_SCHEMA_VERSION;
  /** Stable material identity referenced by a profile binding. */
  readonly id: string;
  /** Logical runtime/package requirement supplied by the existing resolver. */
  readonly requirement_id: string;
  /** Material version; it must equal the selected requirement version. */
  readonly version: string;
  /** Name exposed by the projected executable surface. */
  readonly entrypoint: string;
  /** The executable member of source_closure. */
  readonly executable: DeclaredToolFile;
  /** Exact regular-file closure; directories and symlinks are not accepted. */
  readonly source_closure: readonly DeclaredToolFile[];
}>;

/** Input shape accepted before canonicalization. Contract fields are optional only for v1 compatibility. */
export type DeclaredToolMaterialInput = Readonly<{
  readonly contract_id?: unknown;
  readonly schema_version?: unknown;
  readonly id?: unknown;
  readonly requirement_id?: unknown;
  readonly version?: unknown;
  readonly entrypoint?: unknown;
  readonly executable?: unknown;
  readonly source_closure?: unknown;
}>;

/** Profile-side binding. It references a material identity, never a host path. */
export type DeclaredToolMaterialBinding = Readonly<{
  readonly material_id: string;
  /** Optional target override is an exact file target, not a directory bind. */
  readonly target?: string;
  readonly provider?: RuntimeExecutableProvider;
  readonly entrypoint?: string;
  readonly provenance?: RuntimeProjectionProvenance;
}>;

/** File-level output consumed by the later runtime-resolution composition. */
export type DeclaredToolMaterialProjection = Readonly<{
  readonly contract_id: typeof DECLARED_TOOL_MATERIAL_CONTRACT_ID;
  readonly schema_version: typeof DECLARED_TOOL_MATERIAL_SCHEMA_VERSION;
  readonly material_id: string;
  readonly requirement_id: string;
  readonly version: string;
  readonly filesystem: readonly RuntimeFilesystemProjection[];
  readonly executable: ProjectedExecutableEntrypoint;
  readonly provider_materialization: Readonly<{
    readonly provider: RuntimeExecutableProvider;
    readonly source: string;
  }>;
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Declared tool material field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROJECTION_AMBIGUOUS",
      `Declared tool material field '${field}' is ambiguous: ${reason}.`,
      {
        field,
        ...(value === undefined ? {} : { value }),
      },
    ),
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

function boundedText(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > DECLARED_TOOL_MATERIAL_MAX_TEXT) {
    return invalid(field, "expected bounded non-empty text");
  }
  if (value.includes("\0") || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalid(field, "control characters are not supported");
  }
  return success(value.normalize("NFC"));
}

function stableIdentifier(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !STABLE_IDENTIFIER.test(value)) {
    return invalid(field, "expected a stable identifier", typeof value === "string" ? value : undefined);
  }
  return success(value);
}

function entrypoint(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !ENTRYPOINT.test(value)) {
    return invalid(field, "expected a stable executable basename", typeof value === "string" ? value : undefined);
  }
  return success(value);
}

function canonicalAbsolutePath(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > DECLARED_TOOL_MATERIAL_MAX_TEXT) {
    return invalid(field, "expected a bounded absolute path");
  }
  if (!path.posix.isAbsolute(value) || value.includes("\0") || value === "/") {
    return invalid(field, "expected a non-root absolute POSIX path", value);
  }
  if (path.posix.normalize(value) !== value) {
    return invalid(field, "path must be canonical and contain no traversal aliases", value);
  }
  if (value === "/nawabari/bin" || value.startsWith("/nawabari/bin/")) {
    return invalid(field, "the canonical executable surface cannot be a material source", value);
  }
  return success(value);
}

function assertKeys(value: UnknownRecord, allowed: readonly string[], field: string): DomainResult<null> {
  const supported = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !supported.has(key));
  return unknown === undefined ? success(null) : invalid(`${field}.${unknown}`, "unknown fields are not supported");
}

function decimal(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    return invalid(field, "expected a positive decimal identity string");
  }
  try {
    if (BigInt(value) <= 0n) return invalid(field, "expected a positive decimal identity string");
  } catch {
    return invalid(field, "expected a valid decimal identity string");
  }
  return success(value);
}

function fileIdentity(value: unknown, field: string): DomainResult<DeclaredToolFileIdentity> {
  if (!isRecord(value)) return invalid(field, "expected device and inode identity evidence");
  const keys = assertKeys(value, ["dev", "ino"], field);
  if (!keys.ok) return keys;
  const dev = decimal(value.dev, `${field}.dev`);
  if (!dev.ok) return dev;
  const ino = decimal(value.ino, `${field}.ino`);
  if (!ino.ok) return ino;
  return success(Object.freeze({ dev: dev.value, ino: ino.value }));
}

function digest(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !SHA256.test(value)) {
    return invalid(field, "expected a lowercase SHA-256 digest");
  }
  return success(value);
}

function declaredFile(value: unknown, field: string): DomainResult<DeclaredToolFile> {
  if (!isRecord(value)) return invalid(field, "expected a regular-file declaration");
  const keys = assertKeys(value, ["source", "digest", "identity"], field);
  if (!keys.ok) return keys;
  const source = canonicalAbsolutePath(value.source, `${field}.source`);
  if (!source.ok) return source;
  const fileDigest = digest(value.digest, `${field}.digest`);
  if (!fileDigest.ok) return fileDigest;
  const identity = fileIdentity(value.identity, `${field}.identity`);
  if (!identity.ok) return identity;
  return success(Object.freeze({ source: source.value, digest: fileDigest.value, identity: identity.value }));
}

function provider(
  value: unknown,
  expected: RuntimeExecutableProvider,
  field: string,
): DomainResult<RuntimeExecutableProvider> {
  if (!isRecord(value)) return invalid(field, "expected a provider identity");
  const keys = assertKeys(value, ["id", "requirement_id"], field);
  if (!keys.ok) return keys;
  const id = stableIdentifier(value.id, `${field}.id`);
  if (!id.ok) return id;
  const requirementId = stableIdentifier(value.requirement_id, `${field}.requirement_id`);
  if (!requirementId.ok) return requirementId;
  if (id.value !== expected.id || requirementId.value !== expected.requirement_id) {
    return invalid(field, "provider identity does not match the declared material requirement", id.value);
  }
  return success(Object.freeze({ id: id.value, requirement_id: requirementId.value }));
}

function identityMatches(expected: DeclaredToolFileIdentity, actual: RuntimeFileIdentity): boolean {
  return expected.dev === actual.dev.toString(10) && expected.ino === actual.ino.toString(10);
}

function inspectDeclaredFile(file: DeclaredToolFile, executable: boolean): DomainResult<null> {
  try {
    inspectRuntimeFile(
      file.source,
      (descriptor, stat) => {
        if (!identityMatches(file.identity, { dev: stat.dev, ino: stat.ino })) {
          throw new Error("the declared file identity changed");
        }
        if (executable && (stat.mode & 0o111n) === 0n) throw new Error("the declared executable is not executable");
        const content = readRuntimeFile(descriptor, stat.size, DECLARED_TOOL_MATERIAL_MAX_FILE_BYTES);
        const actualDigest = createHash("sha256").update(content).digest("hex");
        if (actualDigest !== file.digest) throw new Error("the declared file digest changed");
        return undefined;
      },
      { requireCanonicalPath: true },
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "the declared file could not be inspected";
    return failure(
      new DomainError("RUNTIME_MATERIALIZATION_MISSING", `Declared tool material is stale or unavailable: ${reason}.`, {
        source: file.source,
      }),
    );
  }
  return success(null);
}

function requirementContext(value: unknown): DomainResult<RuntimeRequirement> {
  if (!isRecord(value)) return invalid("requirement", "expected the selected runtime requirement");
  const id = stableIdentifier(value.id, "requirement.id");
  if (!id.ok) return id;
  if (value.kind !== "runtime" && value.kind !== "package")
    return invalid("requirement.kind", "expected runtime or package");
  const name = boundedText(value.name, "requirement.name");
  if (!name.ok) return name;
  const version = boundedText(value.version, "requirement.version");
  if (!version.ok) return version;
  return success(Object.freeze({ id: id.value, kind: value.kind, name: name.value, version: version.value }));
}

function canonicalMaterial(input: unknown, requirement: RuntimeRequirement): DomainResult<DeclaredToolMaterial> {
  if (!isRecord(input)) return invalid("material", "expected an object");
  const keys = assertKeys(
    input,
    ["contract_id", "schema_version", "id", "requirement_id", "version", "entrypoint", "executable", "source_closure"],
    "material",
  );
  if (!keys.ok) return keys;
  if (input.contract_id !== undefined && input.contract_id !== DECLARED_TOOL_MATERIAL_CONTRACT_ID) {
    return invalid("contract_id", "does not match the declared tool material contract");
  }
  if (input.schema_version !== undefined && input.schema_version !== DECLARED_TOOL_MATERIAL_SCHEMA_VERSION) {
    return invalid("schema_version", "does not match the declared tool material schema");
  }
  const id = stableIdentifier(input.id, "id");
  if (!id.ok) return id;
  const requirementId = stableIdentifier(input.requirement_id, "requirement_id");
  if (!requirementId.ok) return requirementId;
  if (requirementId.value !== requirement.id) {
    return invalid("requirement_id", "does not match the selected runtime requirement", requirementId.value);
  }
  const version = boundedText(input.version, "version");
  if (!version.ok) return version;
  if (version.value !== requirement.version) {
    return invalid("version", "does not match the selected runtime requirement", version.value);
  }
  const name = entrypoint(input.entrypoint, "entrypoint");
  if (!name.ok) return name;
  if (!Array.isArray(input.source_closure) || input.source_closure.length === 0) {
    return invalid("source_closure", "expected a non-empty regular-file closure");
  }
  if (input.source_closure.length > DECLARED_TOOL_MATERIAL_MAX_FILES) {
    return invalid("source_closure", "the regular-file closure exceeds the bounded file count");
  }
  const closure: DeclaredToolFile[] = [];
  const paths = new Set<string>();
  const identities = new Map<string, string>();
  for (const [index, value] of input.source_closure.entries()) {
    const file = declaredFile(value, `source_closure[${index}]`);
    if (!file.ok) return file;
    if (paths.has(file.value.source)) return ambiguous("source_closure", "duplicate source path", file.value.source);
    const identityKey = `${file.value.identity.dev}:${file.value.identity.ino}`;
    const previousSource = identities.get(identityKey);
    if (previousSource !== undefined && previousSource !== file.value.source) {
      return ambiguous("source_closure", "multiple paths alias one file identity", file.value.source);
    }
    paths.add(file.value.source);
    identities.set(identityKey, file.value.source);
    closure.push(file.value);
  }
  const executable = declaredFile(input.executable, "executable");
  if (!executable.ok) return executable;
  if (!paths.has(executable.value.source)) {
    return materializationMissing(
      requirement,
      "the executable is not included in the declared source closure",
      executable.value.source,
    );
  }
  const ordered = Object.freeze(
    [...closure].sort((left, right) => (left.source < right.source ? -1 : left.source > right.source ? 1 : 0)),
  );
  const executableFromClosure = ordered.find((file) => file.source === executable.value.source);
  if (executableFromClosure === undefined)
    return materializationMissing(requirement, "the executable closure member is missing");
  if (
    executableFromClosure.digest !== executable.value.digest ||
    JSON.stringify(executableFromClosure.identity) !== JSON.stringify(executable.value.identity)
  ) {
    return ambiguous(
      "executable",
      "executable evidence conflicts with its source closure member",
      executable.value.source,
    );
  }
  for (const file of ordered) {
    const checked = inspectDeclaredFile(file, file.source === executable.value.source);
    if (!checked.ok) return checked;
  }
  return success(
    Object.freeze({
      contract_id: DECLARED_TOOL_MATERIAL_CONTRACT_ID,
      schema_version: DECLARED_TOOL_MATERIAL_SCHEMA_VERSION,
      id: id.value,
      requirement_id: requirementId.value,
      version: version.value,
      entrypoint: name.value,
      executable: executableFromClosure,
      source_closure: ordered,
    }),
  );
}

function targetPath(value: unknown, field: string): DomainResult<string> {
  const target = canonicalAbsolutePath(value, field);
  if (!target.ok) return target;
  if (target.value.startsWith("/nawabari/bin/") || target.value === "/nawabari/bin") {
    return invalid(field, "the canonical executable surface cannot be a materialized source target", target.value);
  }
  return target;
}

function bindingValue(
  value: unknown,
  material: DeclaredToolMaterial,
  requirementKind: RuntimeRequirement["kind"],
): DomainResult<{
  readonly material_id: string;
  readonly target: string;
  readonly provider: RuntimeExecutableProvider;
  readonly entrypoint: string;
  readonly provenance: RuntimeProjectionProvenance;
}> {
  if (!isRecord(value)) return invalid("binding", "expected a profile material binding");
  const keys = assertKeys(value, ["material_id", "target", "provider", "entrypoint", "provenance"], "binding");
  if (!keys.ok) return keys;
  if (value.material_id !== material.id) {
    return failure(
      runtimeProviderMissingError(String(value.material_id ?? "unknown"), material.entrypoint, material.requirement_id),
    );
  }
  const target =
    value.target === undefined ? success(material.executable.source) : targetPath(value.target, "binding.target");
  if (!target.ok) return target;
  const selectedEntrypoint =
    value.entrypoint === undefined ? success(material.entrypoint) : entrypoint(value.entrypoint, "binding.entrypoint");
  if (!selectedEntrypoint.ok) return selectedEntrypoint;
  if (selectedEntrypoint.value !== material.entrypoint)
    return invalid("binding.entrypoint", "does not match the material entrypoint");
  const expectedProvider = Object.freeze({ id: material.id, requirement_id: material.requirement_id });
  const selectedProvider =
    value.provider === undefined
      ? success(expectedProvider)
      : provider(value.provider, expectedProvider, "binding.provider");
  if (!selectedProvider.ok) return selectedProvider;
  const provenance = value.provenance ?? (requirementKind === "runtime" ? "runtime-profile" : "package");
  if (
    provenance !== "runtime-profile" &&
    provenance !== "package" &&
    provenance !== "session" &&
    provenance !== "compatibility"
  ) {
    return invalid("binding.provenance", "expected canonical runtime projection provenance");
  }
  if (provenance === "compatibility")
    return invalid("binding.provenance", "declared material cannot use compatibility visibility");
  return success(
    Object.freeze({
      material_id: material.id,
      target: target.value,
      provider: selectedProvider.value,
      entrypoint: selectedEntrypoint.value,
      provenance,
    }),
  );
}

function materializationFilesystem(
  material: DeclaredToolMaterial,
  binding: {
    readonly target: string;
    readonly provenance: RuntimeProjectionProvenance;
  },
): readonly RuntimeFilesystemProjection[] {
  return Object.freeze(
    material.source_closure.map((file) =>
      Object.freeze({
        source: file.source,
        target: file.source === material.executable.source ? binding.target : file.source,
        access_mode: "read-only" as const,
        provenance: binding.provenance,
      }),
    ),
  );
}

/**
 * Validate host-declared material against one already-selected logical
 * requirement. Validation is deliberately filesystem-backed: stale digest,
 * inode/device, symlink, missing, directory, or non-executable evidence is
 * rejected before a caller can project a runnable entrypoint.
 */
export function validateDeclaredToolMaterial(input: unknown, requirement: unknown): DomainResult<DeclaredToolMaterial> {
  const selected = requirementContext(requirement);
  if (!selected.ok) return selected;
  return canonicalMaterial(input, selected.value);
}

/**
 * Project one validated material through a profile binding. The binding names
 * only the material identity and optional exact executable target; no PATH
 * lookup, directory bind, package installation, or provider fallback occurs.
 * The material is revalidated so a declaration cannot become runnable after
 * its regular-file digest or identity has changed.
 */
export function projectDeclaredToolMaterial(
  material: unknown,
  binding: unknown,
  requirement?: unknown,
): DomainResult<DeclaredToolMaterialProjection> {
  if (!isRecord(material)) return invalid("material", "expected a declared tool material");
  const fallbackRequirement = {
    id: material.requirement_id,
    kind: "package" as const,
    name: material.entrypoint,
    version: material.version,
  };
  const selected = requirementContext(requirement ?? fallbackRequirement);
  if (!selected.ok) return selected;
  const checked = canonicalMaterial(material, selected.value);
  if (!checked.ok) return checked;
  const selectedBinding = bindingValue(binding, checked.value, selected.value.kind);
  if (!selectedBinding.ok) return selectedBinding;
  const filesystem = materializationFilesystem(checked.value, selectedBinding.value);
  const executable: ProjectedExecutableEntrypoint = Object.freeze({
    name: selectedBinding.value.entrypoint,
    target: selectedBinding.value.target,
    provider: selectedBinding.value.provider,
    provenance: selectedBinding.value.provenance,
  });
  return success(
    Object.freeze({
      contract_id: DECLARED_TOOL_MATERIAL_CONTRACT_ID,
      schema_version: DECLARED_TOOL_MATERIAL_SCHEMA_VERSION,
      material_id: checked.value.id,
      requirement_id: checked.value.requirement_id,
      version: checked.value.version,
      filesystem,
      executable,
      provider_materialization: Object.freeze({
        provider: selectedBinding.value.provider,
        source: checked.value.executable.source,
      }),
    }),
  );
}

/** Serialize only a validated canonical material under runtime-resolution. */
export function serializeDeclaredToolMaterial(input: unknown, requirement: unknown): DomainResult<string> {
  const material = validateDeclaredToolMaterial(input, requirement);
  return material.ok
    ? success(JSON.stringify({ [DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY]: material.value }))
    : failure(material.error);
}

/** JSON-safe descriptor consumed by governance and contract documentation. */
export const DECLARED_TOOL_MATERIAL_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: DECLARED_TOOL_MATERIAL_CONTRACT_ID,
  schema_version: DECLARED_TOOL_MATERIAL_SCHEMA_VERSION,
  serialization_key: DECLARED_TOOL_MATERIAL_SERIALIZATION_KEY,
  fields: ["id", "requirement_id", "version", "entrypoint", "executable", "source_closure"],
  authorities: {
    requirement: "selected RuntimeProfile requirement",
    source: "explicit regular-file closure and file identity/digest evidence",
    profile: "material id binding only",
  },
  excludes: ["ambient PATH", "global packages", "directory binds", "package installation", "named-tool CLI semantics"],
});

export function isDeclaredToolMaterialError(error: DomainError): error is DomainError & {
  readonly code:
    | "RUNTIME_PROJECTION_INVALID"
    | "RUNTIME_PROJECTION_AMBIGUOUS"
    | "RUNTIME_MATERIALIZATION_MISSING"
    | "RUNTIME_PROVIDER_MISSING";
} {
  return (
    error.code === "RUNTIME_PROJECTION_INVALID" ||
    error.code === "RUNTIME_PROJECTION_AMBIGUOUS" ||
    error.code === "RUNTIME_MATERIALIZATION_MISSING" ||
    error.code === "RUNTIME_PROVIDER_MISSING"
  );
}
