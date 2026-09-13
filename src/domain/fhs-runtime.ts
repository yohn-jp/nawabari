import fs from "node:fs";
import { posix } from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { inspectRuntimeFile, readRuntimeFile } from "./runtime-file-identity.js";
import {
  RUNTIME_PROFILE_CONTRACT_ID,
  RUNTIME_PROFILE_SCHEMA_VERSION,
  type ResolvedRuntimeProfile,
} from "./runtime-profile.js";
import {
  runtimeMaterializationMissingError,
  STRICT_RUNTIME_POLICY,
  validateRuntimePolicy,
  validateSessionRuntimeProjection,
  type RuntimeFilesystemProjection,
  type RuntimePolicy,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

/** Versioned identity for bounded standalone/FHS runtime materialization. */
export const FHS_RUNTIME_MATERIALIZATION_CONTRACT_ID = "nawabari.fhs-runtime-materialization.v1" as const;
export const FHS_RUNTIME_MATERIALIZATION_SCHEMA_VERSION = 1 as const;

/** The only host roots accepted as FHS materialization destinations. */
export const FHS_RUNTIME_ROOTS = Object.freeze(["/usr", "/bin", "/lib", "/lib64"] as const);

/** Fixed, distro-independent lookup order for the common FHS library layouts. */
export const FHS_RUNTIME_LIBRARY_SEARCH_PATHS = Object.freeze([
  "/lib",
  "/lib64",
  "/usr/lib",
  "/usr/lib64",
  "/lib/aarch64-linux-gnu",
  "/lib/arm-linux-gnueabi",
  "/lib/arm-linux-gnueabihf",
  "/lib/i386-linux-gnu",
  "/lib/powerpc64le-linux-gnu",
  "/lib/riscv64-linux-gnu",
  "/lib/s390x-linux-gnu",
  "/lib/x86_64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
  "/usr/lib/arm-linux-gnueabi",
  "/usr/lib/arm-linux-gnueabihf",
  "/usr/lib/i386-linux-gnu",
  "/usr/lib/powerpc64le-linux-gnu",
  "/usr/lib/riscv64-linux-gnu",
  "/usr/lib/s390x-linux-gnu",
  "/usr/lib/x86_64-linux-gnu",
] as const);

const MAX_ELF_BYTES = 256 * 1024 * 1024;
const MAX_PROGRAM_HEADERS = 4_096;
const MAX_MATERIALIZED_FILES = 1_024;
const MAX_DEPENDENCY_DEPTH = 64;

export type FhsRuntimeExecutableDeclaration = Readonly<{
  /** Profile requirement satisfied by this explicitly declared host artifact. */
  readonly requirement_id: string;
  /** Absolute canonical host path. */
  readonly path: string;
  /** Optional bounded namespace target; omitted for legacy same-path declarations. */
  readonly target?: string;
}>;

export type FhsRuntimeMaterializationInput = Readonly<{
  /** Output of the #290 logical runtime-profile resolver. */
  readonly profile: ResolvedRuntimeProfile;
  /** One explicitly declared executable artifact for every selected requirement. */
  readonly executables: readonly FhsRuntimeExecutableDeclaration[];
  /** Omitted means strict default-deny. Compatibility is never inferred. */
  readonly policy?: RuntimePolicy;
  /** Optional fixed FHS directories, useful for a controlled host layout. */
  readonly library_search_paths?: readonly string[];
}>;

type ElfProgramHeader = Readonly<{
  readonly type: number;
  readonly offset: number;
  readonly virtual_address: number;
  readonly file_size: number;
  readonly memory_size: number;
}>;

type ElfMetadata = Readonly<{
  readonly interpreter: string | null;
  readonly needed: readonly string[];
  readonly rpath: string | null;
  readonly runpath: string | null;
}>;

type CanonicalFile = Readonly<{
  readonly source: string;
  readonly target: string;
  readonly inspection?: DomainResult<ElfMetadata>;
}>;

type RequirementContext = Readonly<{
  readonly id: string;
  readonly kind: "runtime" | "package";
  readonly provenance: "runtime-profile" | "package" | "compatibility";
}>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pathMatches(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isFhsPath(candidate: string, allowRoot = false): boolean {
  return FHS_RUNTIME_ROOTS.some((root) => (allowRoot && candidate === root) || pathMatches(candidate, root));
}

/** Strip a reason's own trailing period so it nests into a sentence exactly once. */
function reasonSentence(reason: string): string {
  return reason.endsWith(".") ? reason.slice(0, -1) : reason;
}

function materializationFailure(
  requirement: RequirementContext,
  reason: string,
  details: Record<string, string | number> = {},
): DomainResult<never> {
  const canonical = runtimeMaterializationMissingError(requirement.id, requirement.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reasonSentence(reason)}.`,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function ambiguousMaterialization(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", `FHS runtime field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function invalidMaterialization(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `FHS runtime field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function profileContext(value: unknown): DomainResult<{
  readonly profile: RuntimeProfileIdentity;
  readonly requirements: readonly RuntimeRequirement[];
}> {
  if (
    !isRecord(value) ||
    value.contract_id !== RUNTIME_PROFILE_CONTRACT_ID ||
    value.schema_version !== RUNTIME_PROFILE_SCHEMA_VERSION ||
    !isRecord(value.profile) ||
    !isStableIdentifier(value.profile.id) ||
    !isNonEmptyText(value.profile.version)
  ) {
    return failure(
      new DomainError("RUNTIME_PROFILE_INVALID", "FHS materialization requires a resolved runtime profile."),
    );
  }
  if (!Array.isArray(value.requirements)) {
    return failure(
      new DomainError("RUNTIME_PROFILE_INVALID", "The resolved runtime profile requirements are invalid."),
    );
  }
  const requirements: RuntimeRequirement[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.requirements.entries()) {
    if (
      !isRecord(item) ||
      !isStableIdentifier(item.id) ||
      (item.kind !== "runtime" && item.kind !== "package") ||
      !isNonEmptyText(item.name) ||
      !isNonEmptyText(item.version)
    ) {
      return failure(
        new DomainError("RUNTIME_PROFILE_INVALID", `Resolved runtime profile requirement ${index} is invalid.`, {
          requirement_index: index,
        }),
      );
    }
    if (ids.has(item.id)) {
      return ambiguousMaterialization("requirements", "duplicate requirement id", item.id);
    }
    ids.add(item.id);
    requirements.push(
      Object.freeze({
        id: item.id,
        kind: item.kind,
        name: item.name,
        version: item.version,
      }),
    );
  }
  if (requirements.length === 0) {
    return failure(
      new DomainError("RUNTIME_PROFILE_REQUIREMENT_MISSING", "The runtime profile has no material requirements."),
    );
  }
  return success({
    profile: Object.freeze({ id: value.profile.id, version: value.profile.version }),
    requirements: Object.freeze(requirements),
  });
}

function validateFhsTarget(candidate: unknown, field: string, allowRoot = false): DomainResult<string> {
  if (!isNonEmptyText(candidate) || !posix.isAbsolute(candidate) || posix.normalize(candidate) !== candidate) {
    return invalidMaterialization(
      field,
      "expected a normalized absolute POSIX path",
      typeof candidate === "string" ? candidate : undefined,
    );
  }
  if (!isFhsPath(candidate, allowRoot)) {
    return invalidMaterialization(field, "path is outside the bounded FHS roots", candidate);
  }
  return success(candidate);
}

function canonicalHostFile(
  candidate: string,
  requirement: RequirementContext,
  field: string,
  allowExternalSource = false,
  inspect?: (descriptor: number, stat: fs.BigIntStats) => DomainResult<ElfMetadata>,
): DomainResult<CanonicalFile> {
  try {
    const inspected = inspectRuntimeFile(candidate, inspect ?? (() => undefined));
    const source = inspected.source;
    if (!allowExternalSource && !isFhsPath(source)) {
      return materializationFailure(requirement, "declared artifact resolves outside the bounded FHS roots", {
        field,
        resolved_source: source,
      });
    }
    const inspection = inspect === undefined ? undefined : inspected.value;
    return success({ source, target: candidate, ...(inspection === undefined ? {} : { inspection }) });
  } catch (error: unknown) {
    return materializationFailure(requirement, "declared artifact is missing or cannot be canonicalized", {
      field,
      reason_detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
  }
}

function canonicalHostDirectory(
  candidate: string,
  requirement: RequirementContext,
  field: string,
): DomainResult<string> {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      return materializationFailure(requirement, "compatibility root is not a directory", { field });
    }
    const source = fs.realpathSync.native(candidate);
    if (!fs.statSync(source).isDirectory() || !isFhsPath(source, true)) {
      return materializationFailure(requirement, "compatibility root resolves outside the bounded FHS roots", {
        field,
        resolved_source: source,
      });
    }
    return success(source);
  } catch (error: unknown) {
    return materializationFailure(requirement, "compatibility root cannot be canonicalized", {
      field,
      reason_detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
  }
}

function readInteger(data: Buffer, offset: number, width: 2 | 4 | 8): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + width > data.length) return null;
  try {
    if (width === 2) return data.readUInt16LE(offset);
    if (width === 4) return data.readUInt32LE(offset);
    const value = data.readBigUInt64LE(offset);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  } catch {
    return null;
  }
}

function boundedRange(offset: number, size: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(size) &&
    offset >= 0 &&
    size >= 0 &&
    offset <= length &&
    size <= length - offset
  );
}

function readString(data: Buffer, offset: number, maxLength: number, allowEmpty = false): string | null {
  if (!boundedRange(offset, maxLength, data.length)) return null;
  const end = data.indexOf(0, offset);
  if (end === -1 || end >= offset + maxLength) return null;
  const value = data.subarray(offset, end).toString("utf8");
  return (!allowEmpty && value.length === 0) || value.includes("\u0000") ? null : value;
}

function virtualToFileOffset(
  address: number,
  size: number,
  loads: readonly ElfProgramHeader[],
  dataLength: number,
): number | null {
  for (const load of loads) {
    if (
      address >= load.virtual_address &&
      address <= load.virtual_address + load.file_size &&
      size <= load.file_size - (address - load.virtual_address)
    ) {
      const offset = load.offset + (address - load.virtual_address);
      return boundedRange(offset, size, dataLength) ? offset : null;
    }
  }
  return null;
}

function parseElf(data: Buffer, requirement: RequirementContext): DomainResult<ElfMetadata> {
  if (data.length < 52 || data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) {
    return materializationFailure(requirement, "unsupported non-ELF executable format");
  }
  const elfClass = data[4];
  const dataEncoding = data[5];
  if ((elfClass !== 1 && elfClass !== 2) || dataEncoding !== 1) {
    return materializationFailure(requirement, "unsupported ELF class or byte order", {
      elf_class: elfClass ?? -1,
      elf_data: dataEncoding ?? -1,
    });
  }

  const is64 = elfClass === 2;
  const phoff = readInteger(data, is64 ? 32 : 28, is64 ? 8 : 4);
  const phentsize = readInteger(data, is64 ? 54 : 42, 2);
  const phnum = readInteger(data, is64 ? 56 : 44, 2);
  if (phoff === null || phentsize === null || phnum === null || phnum > MAX_PROGRAM_HEADERS) {
    return materializationFailure(requirement, "ELF program-header table is invalid");
  }
  const minimumPhentsize = is64 ? 56 : 32;
  if (phentsize < minimumPhentsize || !boundedRange(phoff, phentsize * phnum, data.length)) {
    return materializationFailure(requirement, "ELF program-header table is outside the file");
  }

  const headers: ElfProgramHeader[] = [];
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize;
    const type = readInteger(data, offset, 4);
    const fileOffset = readInteger(data, offset + (is64 ? 8 : 4), is64 ? 8 : 4);
    const virtualAddress = readInteger(data, offset + (is64 ? 16 : 8), is64 ? 8 : 4);
    const fileSize = readInteger(data, offset + (is64 ? 32 : 16), is64 ? 8 : 4);
    const memorySize = readInteger(data, offset + (is64 ? 40 : 20), is64 ? 8 : 4);
    if (
      type === null ||
      fileOffset === null ||
      virtualAddress === null ||
      fileSize === null ||
      memorySize === null ||
      !boundedRange(fileOffset, fileSize, data.length)
    ) {
      return materializationFailure(requirement, "ELF program header contains an invalid range");
    }
    headers.push({
      type,
      offset: fileOffset,
      virtual_address: virtualAddress,
      file_size: fileSize,
      memory_size: memorySize,
    });
  }

  const loads = headers.filter((header) => header.type === 1);
  const interpreterHeaders = headers.filter((header) => header.type === 3);
  if (interpreterHeaders.length > 1)
    return materializationFailure(requirement, "ELF has multiple program interpreters");
  let interpreter: string | null = null;
  if (interpreterHeaders.length === 1) {
    const header = interpreterHeaders[0];
    interpreter = readString(data, header.offset, header.file_size);
    if (interpreter === null) return materializationFailure(requirement, "ELF interpreter string is invalid");
  }

  const dynamic = headers.find((header) => header.type === 2);
  if (dynamic === undefined) return success({ interpreter, needed: Object.freeze([]), rpath: null, runpath: null });

  const dynamicEntrySize = is64 ? 16 : 8;
  if (dynamic.file_size < dynamicEntrySize || dynamic.file_size % dynamicEntrySize !== 0) {
    return materializationFailure(requirement, "ELF dynamic section has an invalid size");
  }
  let stringTableAddress: number | null = null;
  let stringTableSize: number | null = null;
  const neededOffsets: number[] = [];
  let rpathOffset: number | null = null;
  let runpathOffset: number | null = null;
  let hasNull = false;
  for (let offset = dynamic.offset; offset < dynamic.offset + dynamic.file_size; offset += dynamicEntrySize) {
    const tag = readInteger(data, offset, is64 ? 8 : 4);
    const value = readInteger(data, offset + (is64 ? 8 : 4), is64 ? 8 : 4);
    if (tag === null || value === null) return materializationFailure(requirement, "ELF dynamic entry is invalid");
    if (tag === 0) {
      hasNull = true;
      break;
    }
    if (tag === 1) neededOffsets.push(value);
    if (tag === 5) stringTableAddress = value;
    if (tag === 10) stringTableSize = value;
    if (tag === 15) {
      if (rpathOffset !== null) return materializationFailure(requirement, "ELF has multiple DT_RPATH entries");
      rpathOffset = value;
    }
    if (tag === 29) {
      if (runpathOffset !== null) return materializationFailure(requirement, "ELF has multiple DT_RUNPATH entries");
      runpathOffset = value;
    }
  }
  if (!hasNull) return materializationFailure(requirement, "ELF dynamic section has no terminator");
  if (neededOffsets.length === 0 && rpathOffset === null && runpathOffset === null)
    return success({ interpreter, needed: Object.freeze([]), rpath: null, runpath: null });
  if (stringTableAddress === null || stringTableSize === null || stringTableSize === 0) {
    return materializationFailure(requirement, "ELF shared-library names have no valid string table");
  }
  const stringTableOffset = virtualToFileOffset(stringTableAddress, stringTableSize, loads, data.length);
  if (stringTableOffset === null) return materializationFailure(requirement, "ELF string table is not file-backed");

  const readSearchPath = (offset: number | null, tag: "DT_RPATH" | "DT_RUNPATH"): string | null => {
    if (offset === null) return null;
    if (offset >= stringTableSize) {
      throw new Error(`${tag} string offset is out of range`);
    }
    const value = readString(data, stringTableOffset + offset, stringTableSize - offset, true);
    if (value === null) throw new Error(`${tag} string is invalid`);
    return value;
  };
  let rpath: string | null;
  let runpath: string | null;
  try {
    rpath = readSearchPath(rpathOffset, "DT_RPATH");
    runpath = readSearchPath(runpathOffset, "DT_RUNPATH");
  } catch (error: unknown) {
    return materializationFailure(requirement, error instanceof Error ? error.message : "ELF search path is invalid");
  }

  if (neededOffsets.length === 0) {
    return success({ interpreter, needed: Object.freeze([]), rpath, runpath });
  }

  const needed: string[] = [];
  for (const neededOffset of neededOffsets) {
    if (neededOffset >= stringTableSize)
      return materializationFailure(requirement, "ELF shared-library name is out of range");
    const name = readString(data, stringTableOffset + neededOffset, stringTableSize - neededOffset);
    if (name === null) return materializationFailure(requirement, "ELF shared-library name is invalid");
    needed.push(name);
  }
  return success({ interpreter, needed: Object.freeze(needed), rpath, runpath });
}

/**
 * FHS package entrypoints may be executable scripts (notably pnpm). Their
 * shebang interpreter is another bounded artifact; the script itself has no
 * ELF loader or DT_NEEDED closure to inspect.
 */
function parseScriptInterpreter(data: Buffer, requirement: RequirementContext): DomainResult<string | null> {
  const firstLine = data.subarray(0, 4_096).toString("utf8").split("\n", 1)[0] ?? "";
  if (!firstLine.startsWith("#!")) return success(null);
  const shebang = firstLine.slice(2).trim();
  const interpreter = shebang.split(/\s+/u, 1)[0] ?? "";
  if (interpreter.length === 0 || !posix.isAbsolute(interpreter) || posix.normalize(interpreter) !== interpreter) {
    return materializationFailure(requirement, "script interpreter is not a bounded absolute path");
  }
  return success(interpreter);
}

function inspectArtifact(
  descriptor: number,
  stat: fs.BigIntStats,
  requirement: RequirementContext,
): DomainResult<ElfMetadata> {
  if (stat.size > BigInt(MAX_ELF_BYTES)) {
    return materializationFailure(requirement, "ELF artifact exceeds the bounded inspection size", {
      artifact_size: Number(stat.size),
    });
  }
  let data: Buffer;
  try {
    data = readRuntimeFile(descriptor, stat.size, MAX_ELF_BYTES);
  } catch (error: unknown) {
    return materializationFailure(requirement, "ELF artifact cannot be read", {
      reason_detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
  }
  const parsed = parseElf(data, requirement);
  if (parsed.ok) return parsed;
  const scriptInterpreter = parseScriptInterpreter(data, requirement);
  if (!scriptInterpreter.ok || scriptInterpreter.value === null) return parsed;
  return success({ interpreter: scriptInterpreter.value, needed: Object.freeze([]), rpath: null, runpath: null });
}

function validateLibrarySearchPaths(value: unknown): DomainResult<readonly string[]> {
  if (value === undefined) return success(Object.freeze([...FHS_RUNTIME_LIBRARY_SEARCH_PATHS].sort(compareText)));
  if (!Array.isArray(value)) return invalidMaterialization("library_search_paths", "expected an array");
  const paths = new Set<string>();
  for (const [index, item] of value.entries()) {
    const checked = validateFhsTarget(item, `library_search_paths[${index}]`, true);
    if (!checked.ok) return checked;
    let boundedPath = checked.value;
    try {
      const stat = fs.statSync(checked.value);
      if (!stat.isDirectory())
        return invalidMaterialization(`library_search_paths[${index}]`, "path is not a directory", checked.value);
      const resolved = fs.realpathSync.native(checked.value);
      if (!isFhsPath(resolved, true)) {
        return invalidMaterialization(
          `library_search_paths[${index}]`,
          "directory resolves outside FHS roots",
          resolved,
        );
      }
      boundedPath = resolved;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return invalidMaterialization(
          `library_search_paths[${index}]`,
          `directory cannot be inspected${error instanceof Error ? ` (${error.message.slice(0, 120)})` : ""}`,
          checked.value,
        );
      }
    }
    paths.add(boundedPath);
  }
  return success(Object.freeze([...paths].sort(compareText)));
}

function validateExecutableDeclarations(
  value: unknown,
  requirements: readonly RuntimeRequirement[],
): DomainResult<ReadonlyMap<string, FhsRuntimeExecutableDeclaration>> {
  if (!Array.isArray(value)) return invalidMaterialization("executables", "expected an array");
  const requirementMap = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  const declarations = new Map<string, FhsRuntimeExecutableDeclaration>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isStableIdentifier(item.requirement_id) || !isNonEmptyText(item.path)) {
      return invalidMaterialization(
        "executables",
        "declaration requires a stable requirement_id and path",
        String(index),
      );
    }
    const requirement = requirementMap.get(item.requirement_id);
    if (requirement === undefined) {
      return failure(
        new DomainError(
          "RUNTIME_MATERIALIZATION_MISSING",
          `Executable declaration references unknown requirement '${item.requirement_id}'.`,
          {
            requirement_id: item.requirement_id,
            requirement_kind: "runtime",
          },
        ),
      );
    }
    const source = item.path;
    if (!posix.isAbsolute(source) || posix.normalize(source) !== source) {
      return invalidMaterialization(`executables[${index}].path`, "expected a normalized absolute POSIX path", source);
    }
    const target =
      item.target === undefined
        ? validateFhsTarget(source, `executables[${index}].path`)
        : validateFhsTarget(item.target, `executables[${index}].target`);
    if (!target.ok) return target;
    if (declarations.has(item.requirement_id)) {
      return ambiguousMaterialization(
        "executables.requirement_id",
        "multiple artifacts satisfy one requirement",
        item.requirement_id,
      );
    }
    declarations.set(
      item.requirement_id,
      Object.freeze({
        requirement_id: requirement.id,
        path: source,
        ...(item.target === undefined ? {} : { target: target.value }),
      }),
    );
  }
  for (const requirement of requirements) {
    if (!declarations.has(requirement.id)) {
      return failure(runtimeMaterializationMissingError(requirement.id, requirement.kind));
    }
  }
  return success(declarations);
}

function safeLibraryName(name: string): boolean {
  return name.length > 0 && !name.includes("\u0000") && !name.startsWith(".") && !name.includes("/") && name !== "..";
}

function canonicalSearchDirectory(
  candidate: string,
  requirement: RequirementContext,
  field: string,
): DomainResult<string> {
  let probe = candidate;
  const missingTail: string[] = [];
  for (;;) {
    try {
      const stat = fs.statSync(probe);
      if (!stat.isDirectory()) {
        return materializationFailure(requirement, "ELF search path is not a directory", {
          field,
          search_path: candidate,
        });
      }
      const resolved = fs.realpathSync.native(probe);
      if (!isFhsPath(resolved, true)) {
        return materializationFailure(requirement, "ELF search path resolves outside the bounded FHS roots", {
          field,
          search_path: candidate,
          resolved_source: resolved,
        });
      }
      const bounded = missingTail.reduce((directory, part) => posix.join(directory, part), resolved);
      if (!isFhsPath(bounded, true)) {
        return materializationFailure(requirement, "ELF search path escapes the bounded FHS roots", {
          field,
          search_path: candidate,
          resolved_source: bounded,
        });
      }
      return success(bounded);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        return materializationFailure(requirement, "ELF search path cannot be canonicalized", {
          field,
          search_path: candidate,
        });
      }
      const parent = posix.dirname(probe);
      if (parent === probe) {
        return materializationFailure(requirement, "ELF search path cannot be canonicalized", {
          field,
          search_path: candidate,
        });
      }
      missingTail.unshift(posix.basename(probe));
      probe = parent;
    }
  }
}

function boundedElfSearchPaths(
  value: string | null,
  objectSource: string,
  requirement: RequirementContext,
  field: "DT_RPATH" | "DT_RUNPATH",
): DomainResult<readonly string[]> {
  if (value === null || value.length === 0) return success(Object.freeze([]));
  const origin = posix.dirname(objectSource);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.split(":").entries()) {
    if (entry.length === 0) {
      return materializationFailure(requirement, "ELF search path contains an ambient empty element", {
        field,
        search_path_index: index,
      });
    }
    const expanded = entry.replaceAll("$ORIGIN", origin);
    if (expanded.includes("$")) {
      return materializationFailure(requirement, "ELF search path contains an unsupported token", {
        field,
        search_path: entry,
      });
    }
    if (!posix.isAbsolute(expanded)) {
      return materializationFailure(requirement, "ELF search path is not absolute after bounded expansion", {
        field,
        search_path: entry,
      });
    }
    const normalized = posix.normalize(expanded);
    if (!isFhsPath(normalized, true)) {
      return materializationFailure(requirement, "ELF search path escapes the bounded FHS roots", {
        field,
        search_path: entry,
        resolved_source: normalized,
      });
    }
    const bounded = canonicalSearchDirectory(normalized, requirement, field);
    if (!bounded.ok) return bounded;
    if (seen.has(bounded.value)) continue;
    seen.add(bounded.value);
    paths.push(bounded.value);
  }
  return success(Object.freeze(paths));
}

function canonicalDependency(
  candidate: string,
  requirement: RequirementContext,
  field: string,
): DomainResult<CanonicalFile> {
  const target = validateFhsTarget(candidate, field);
  if (!target.ok) {
    return materializationFailure(requirement, "required dependency path is outside the bounded FHS roots", {
      dependency: candidate,
    });
  }
  try {
    fs.lstatSync(target.value);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return materializationFailure(requirement, "required dependency is missing", { dependency: target.value });
    }
    return materializationFailure(requirement, "required dependency cannot be inspected", {
      dependency: target.value,
    });
  }
  return canonicalHostFile(target.value, requirement, field);
}

function resolveLibrary(
  name: string,
  searchPaths: readonly string[],
  requirement: RequirementContext,
): DomainResult<CanonicalFile> {
  if (name.startsWith("/")) return canonicalDependency(name, requirement, "dependency");
  if (!safeLibraryName(name))
    return materializationFailure(requirement, "shared-library name is not a safe basename", { dependency: name });
  for (const directory of searchPaths) {
    const candidate = posix.join(directory, name);
    try {
      fs.lstatSync(candidate);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return materializationFailure(requirement, "shared-library candidate cannot be inspected", { dependency: name });
    }
    return canonicalHostFile(candidate, requirement, "dependency");
  }
  return materializationFailure(requirement, "shared library was not found in bounded FHS search paths", {
    dependency: name,
  });
}

/**
 * Resolve declared FHS executables and their ELF loader/library closure into
 * file-level read-only projections. No directory or host-root projection is
 * ever generated by this function.
 */
export function materializeFhsRuntime(input: unknown): DomainResult<SessionRuntimeProjection> {
  if (!isRecord(input)) return invalidMaterialization("materialization", "expected an object");
  const context = profileContext(input.profile);
  if (!context.ok) return context;
  const policy = validateRuntimePolicy(input.policy ?? STRICT_RUNTIME_POLICY);
  if (!policy.ok) return policy;
  const searchPaths = validateLibrarySearchPaths(input.library_search_paths);
  if (!searchPaths.ok) return searchPaths;
  const declarations = validateExecutableDeclarations(input.executables, context.value.requirements);
  if (!declarations.ok) return declarations;

  const requirements = new Map(
    context.value.requirements.map((requirement) => [
      requirement.id,
      Object.freeze({
        id: requirement.id,
        kind: requirement.kind,
        provenance:
          policy.value.mode === "compatibility"
            ? ("compatibility" as const)
            : requirement.kind === "package"
              ? ("package" as const)
              : ("runtime-profile" as const),
      }),
    ]),
  );
  const mounts = new Map<string, RuntimeFilesystemProjection>();
  const parsed = new Map<string, ElfMetadata>();
  const processed = new Set<string>();

  if (policy.value.mode === "compatibility") {
    const compatibilityRequirement = [...requirements.values()].sort((left, right) =>
      compareText(left.id, right.id),
    )[0] as RequirementContext;
    for (const declaration of declarations.value.values()) {
      const requirement = requirements.get(declaration.requirement_id) as RequirementContext;
      const checked = canonicalHostFile(declaration.path, requirement, "executables.path");
      if (!checked.ok) return checked;
    }
    for (const root of FHS_RUNTIME_ROOTS) {
      let present = false;
      try {
        fs.lstatSync(root);
        present = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          return materializationFailure(compatibilityRequirement, "compatibility root cannot be inspected", {
            root,
          });
        }
      }
      if (!present) continue;
      const source = canonicalHostDirectory(root, compatibilityRequirement, "filesystem.source");
      if (!source.ok) return source;
      mounts.set(
        root,
        Object.freeze({
          source: source.value,
          target: root,
          access_mode: "read-only",
          provenance: "compatibility",
        }),
      );
    }
    if (mounts.size === 0) {
      return materializationFailure(compatibilityRequirement, "no FHS compatibility roots are available");
    }
    return validateSessionRuntimeProjection({
      policy: policy.value,
      profile: context.value.profile,
      requirements: context.value.requirements,
      filesystem: [...mounts.values()],
      executables: [],
    });
  }

  const addArtifact = (
    candidate: string,
    target: string,
    requirement: RequirementContext,
    depth: number,
    inheritedRpath: readonly string[],
    allowExternalSource = false,
  ): DomainResult<null> => {
    if (depth > MAX_DEPENDENCY_DEPTH)
      return materializationFailure(requirement, "dependency graph exceeds the bounded depth");
    const checkedTarget = validateFhsTarget(target, "filesystem.target");
    if (!checkedTarget.ok) return checkedTarget;
    const source = canonicalHostFile(
      candidate,
      requirement,
      "filesystem.source",
      allowExternalSource,
      (descriptor, stat) => inspectArtifact(descriptor, stat, requirement),
    );
    if (!source.ok) return source;
    const previous = mounts.get(checkedTarget.value);
    if (previous !== undefined) {
      if (previous.source !== source.value.source) {
        return ambiguousMaterialization(
          "filesystem.target",
          "target resolves to multiple host files",
          checkedTarget.value,
        );
      }
      return success(null);
    }
    if (mounts.size >= MAX_MATERIALIZED_FILES) {
      return materializationFailure(requirement, "dependency graph exceeds the bounded file count");
    }
    mounts.set(
      checkedTarget.value,
      Object.freeze({
        source: source.value.source,
        target: checkedTarget.value,
        access_mode: "read-only",
        provenance: requirement.provenance,
      }),
    );
    const cacheKey = `${source.value.source}\u0000${checkedTarget.value}`;
    if (processed.has(cacheKey)) return success(null);
    processed.add(cacheKey);

    let metadata = parsed.get(source.value.source);
    if (metadata === undefined) {
      const inspected = source.value.inspection;
      if (inspected === undefined) {
        return materializationFailure(requirement, "ELF artifact inspection did not produce metadata");
      }
      if (!inspected.ok) return inspected;
      metadata = inspected.value;
      parsed.set(source.value.source, metadata);
    }

    const rpath = boundedElfSearchPaths(metadata.rpath, source.value.source, requirement, "DT_RPATH");
    if (!rpath.ok) return rpath;
    const runpath = boundedElfSearchPaths(metadata.runpath, source.value.source, requirement, "DT_RUNPATH");
    if (!runpath.ok) return runpath;
    const objectSearchPaths = [
      ...(metadata.runpath === null ? rpath.value : runpath.value),
      ...inheritedRpath,
      ...searchPaths.value,
    ];
    const childInheritedRpath = metadata.runpath === null ? [...rpath.value, ...inheritedRpath] : [...inheritedRpath];
    if (metadata.interpreter !== null) {
      const interpreter = canonicalDependency(metadata.interpreter, requirement, "interpreter");
      if (!interpreter.ok) return interpreter;
      const addedInterpreter = addArtifact(
        interpreter.value.source,
        interpreter.value.target,
        requirement,
        depth + 1,
        childInheritedRpath,
      );
      if (!addedInterpreter.ok) return addedInterpreter;
    }
    for (const needed of [...metadata.needed].sort(compareText)) {
      const dependency = resolveLibrary(needed, objectSearchPaths, requirement);
      if (!dependency.ok) return dependency;
      const addedDependency = addArtifact(
        dependency.value.source,
        dependency.value.target,
        requirement,
        depth + 1,
        childInheritedRpath,
      );
      if (!addedDependency.ok) return addedDependency;
    }
    return success(null);
  };

  for (const profileRequirement of [...context.value.requirements].sort((left, right) =>
    compareText(left.id, right.id),
  )) {
    const declaration = declarations.value.get(profileRequirement.id) as FhsRuntimeExecutableDeclaration;
    const requirement = requirements.get(profileRequirement.id) as RequirementContext;
    const target = validateFhsTarget(
      declaration.target ?? declaration.path,
      `executables.${profileRequirement.id}.target`,
    );
    if (!target.ok) return target;
    const added = addArtifact(declaration.path, target.value, requirement, 0, [], declaration.target !== undefined);
    if (!added.ok) return added;
  }

  const projection = validateSessionRuntimeProjection({
    policy: policy.value,
    profile: context.value.profile,
    requirements: context.value.requirements,
    filesystem: [...mounts.values()],
    // Executable aliases are intentionally left to the later provider contract.
    executables: [],
  });
  if (!projection.ok) return projection;
  return projection;
}

/** Descriptive alias for callers that emphasize the resulting projection. */
export const materializeFhsRuntimeProjection = materializeFhsRuntime;
