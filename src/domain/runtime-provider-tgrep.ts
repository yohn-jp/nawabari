import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import type { RuntimeExecutableProviderMaterialization } from "./runtime-executable-projection.js";
import { createRuntimeFile, inspectRuntimeFile } from "./runtime-file-identity.js";
import {
  CANONICAL_EXECUTABLE_ROOT,
  compileRuntimeExecutableProjection,
  runtimeExecutableProviderKey,
} from "./runtime-executable-projection.js";
import {
  projectSessionRuntimeProjection,
  STRICT_RUNTIME_POLICY,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import {
  TGREP_BACKEND_EVIDENCE,
  TGREP_BACKEND_PROVIDER,
  TGREP_BACKEND_REQUIREMENT,
  TGREP_NIX_INSTALLABLE,
  TGREP_NIXPKGS_REF,
  TGREP_RUNTIME_MATERIALIZATION_CONTRACT_ID,
  TGREP_RUNTIME_MATERIALIZATION_SCHEMA_VERSION,
  type TgrepRuntimeMaterialization,
} from "./tgrep-runtime-materialization.js";

/** Versioned identity for the public projected rg adapter. */
export const TGREP_RG_PROVIDER_CONTRACT_ID = "nawabari.tgrep-rg-provider.v1" as const;
export const TGREP_RG_PROVIDER_SCHEMA_VERSION = 1 as const;
export const TGREP_RG_COMPATIBILITY_CONTRACT_ID = "nawabari.tgrep-rg-compatibility.v1" as const;
export const TGREP_RG_COMPATIBILITY_SCHEMA_VERSION = 1 as const;

/** The only public name supplied by this provider. There is deliberately no grep alias. */
export const TGREP_RG_ENTRYPOINT_NAME = "rg" as const;
export const TGREP_RG_ADAPTER_TARGET = "/runtime/tgrep-rg-adapter/rg" as const;
export const TGREP_RG_PROVIDER = Object.freeze({
  id: "tgrep-rg-provider",
  requirement_id: TGREP_BACKEND_REQUIREMENT.id,
});

export type TgrepRgCompatibilityEntry = Readonly<{
  readonly id: string;
  readonly status: "supported" | "rejected";
  readonly rg: readonly string[];
  readonly backend: readonly string[];
  readonly value: "none" | "required";
  readonly conflict_group?: string;
}>;

const supported = (
  id: string,
  rg: readonly string[],
  backend: readonly string[] = rg,
  value: "none" | "required" = "none",
  conflict_group?: string,
): TgrepRgCompatibilityEntry =>
  Object.freeze({
    id,
    status: "supported" as const,
    rg: Object.freeze([...rg]),
    backend: Object.freeze([...backend]),
    value,
    ...(conflict_group === undefined ? {} : { conflict_group }),
  });

const rejected = (id: string, rg: readonly string[]): TgrepRgCompatibilityEntry =>
  Object.freeze({
    id,
    status: "rejected" as const,
    rg: Object.freeze([...rg]),
    backend: Object.freeze([]),
    value: "none" as const,
  });

/**
 * Closed compatibility authority. Every supported spelling has one canonical
 * backend transformation; all other spellings are rejected before spawn.
 */
export const TGREP_RG_COMPATIBILITY_MATRIX: readonly TgrepRgCompatibilityEntry[] = Object.freeze([
  supported("pattern-and-paths", ["<PATTERN>", "<PATH>..."], ["--", "<PATTERN>", "<PATH>..."]),
  supported("files-mode", ["--files"]),
  supported("ignore-case", ["-i", "--ignore-case"], ["--ignore-case"], "none", "case-mode"),
  supported("case-sensitive", ["-s", "--case-sensitive"], ["--case-sensitive"], "none", "case-mode"),
  supported("smart-case", ["-S", "--smart-case"], ["--smart-case"], "none", "case-mode"),
  supported("fixed-strings", ["-F", "--fixed-strings"], ["--fixed-strings"]),
  supported("word-regexp", ["-w", "--word-regexp"], ["--word-regexp"]),
  supported("invert-match", ["-v", "--invert-match"], ["--invert-match"]),
  supported("with-filename", ["-H", "--with-filename"], ["--with-filename"], "none", "filename-mode"),
  supported("no-filename", ["-I", "--no-filename"], ["--no-filename"], "none", "filename-mode"),
  supported("line-number", ["-n", "--line-number"], ["--line-number"], "none", "line-number-mode"),
  supported("no-line-number", ["-N", "--no-line-number"], ["--no-line-number"], "none", "line-number-mode"),
  supported("glob", ["-g", "--glob"], ["--glob"], "required"),
  supported("iglob", ["--iglob"], ["--iglob"], "required"),
  supported("hidden", ["--hidden"]),
  supported("no-ignore", ["--no-ignore"]),
  supported("no-messages", ["--no-messages"]),
  supported("files-with-matches", ["-l", "--files-with-matches"], ["--files-with-matches"], "none", "file-result-mode"),
  supported("files-without-match", ["--files-without-match"], ["--files-without-match"], "none", "file-result-mode"),
  supported("count", ["-c", "--count"], ["--count"]),
  supported("only-matching", ["-o", "--only-matching"], ["--only-matching"]),
  supported("max-count", ["-m", "--max-count"], ["--max-count"], "required"),
  supported("quiet", ["-q", "--quiet"], ["--quiet"]),
  supported("max-depth", ["--max-depth"], ["--max-depth"], "required"),
  rejected("unsupported-engine-and-rewrite", ["-P", "--pcre2", "--engine", "-r", "--replace"]),
  rejected("unsupported-encoding-and-binary", ["-E", "--encoding", "--no-encoding", "-a", "--text", "--binary"]),
  rejected("unsupported-output-rewrite", ["--json", "--vimgrep", "--color", "--colors", "--column", "--byte-offset"]),
  rejected("unsupported-type-and-discovery", [
    "-t",
    "--type",
    "--type-list",
    "--type-add",
    "--type-clear",
    "--follow",
    "-L",
    "-u",
    "--unrestricted",
  ]),
  rejected("unsupported-index-and-runtime-control", ["--index-path", "--no-index", "--stats", "--debug", "--trace"]),
  rejected("unsupported-stdin", ["-"]),
]);

type OptionSpec = TgrepRgCompatibilityEntry;

const OPTION_SPECS: readonly OptionSpec[] = TGREP_RG_COMPATIBILITY_MATRIX.filter(
  (entry): entry is TgrepRgCompatibilityEntry & { readonly status: "supported" } =>
    entry.status === "supported" && entry.id !== "pattern-and-paths",
);
const MAX_ADAPTER_BYTES = 16 * 1024 * 1024;

class AdapterContentConflict extends Error {
  public constructor() {
    super("the existing rg adapter artifact conflicts with the pinned materialization");
  }
}

const OPTION_BY_SPELLING = new Map(OPTION_SPECS.flatMap((entry) => entry.rg.map((spelling) => [spelling, entry])));

export type TgrepRgTranslation = Readonly<{
  readonly argv: readonly string[];
  readonly options: readonly string[];
  readonly positionals: readonly string[];
  readonly files_mode: boolean;
}>;

function providerError(message: string, details: JsonObject = {}): DomainError {
  return new DomainError("INVALID_ARGUMENT", message, {
    provider: TGREP_RG_ENTRYPOINT_NAME,
    compatibility_contract: TGREP_RG_COMPATIBILITY_CONTRACT_ID,
    ...details,
  });
}

function sourceIsCanonical(value: string): boolean {
  return (
    value.length > 0 &&
    path.posix.isAbsolute(value) &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    value !== "/" &&
    value !== CANONICAL_EXECUTABLE_ROOT &&
    !value.startsWith(`${CANONICAL_EXECUTABLE_ROOT}/`)
  );
}

function unsupportedOption(option: string, argv: readonly string[]): DomainResult<never> {
  return failure(
    providerError(`Projected rg rejects unsupported option '${option}' before invoking the pinned backend.`, {
      option,
      argv: [...argv],
      supported: OPTION_SPECS.flatMap((entry) => entry.rg),
      action: "remove the option or use only the closed compatibility subset",
    }),
  );
}

function missingOptionValue(option: string, argv: readonly string[]): DomainResult<never> {
  return failure(
    providerError(`Projected rg option '${option}' requires a value; the backend was not invoked.`, {
      option,
      argv: [...argv],
    }),
  );
}

function incompatibleOptions(left: string, right: string, argv: readonly string[]): DomainResult<never> {
  return failure(
    providerError(`Projected rg options '${left}' and '${right}' cannot be combined; the backend was not invoked.`, {
      options: [left, right],
      argv: [...argv],
    }),
  );
}

function isRepositoryRelativePath(value: string): boolean {
  if (value.length === 0 || path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized !== ".." && !normalized.startsWith("../");
}

function validateRepositoryPaths(
  positionals: readonly string[],
  filesMode: boolean,
  argv: readonly string[],
): DomainResult<null> {
  const paths = filesMode ? positionals : positionals.slice(1);
  const invalid = paths.find((value) => !isRepositoryRelativePath(value));
  if (invalid === undefined) return success(null);
  return failure(
    providerError(`Projected rg requires repository-relative paths; '${invalid}' is not allowed`, {
      path: invalid,
      argv: [...argv],
      action: "use a path below the session worktree",
    }),
  );
}

/** Translate one raw rg argv using only the closed compatibility matrix. */
export function translateTgrepRgArguments(argv: readonly string[]): DomainResult<TgrepRgTranslation> {
  const options: string[] = [];
  const beforeDelimiter: string[] = [];
  const afterDelimiter: string[] = [];
  const seenGroups = new Map<string, { readonly id: string; readonly spelling: string }>();
  const seenOptions = new Set<string>();
  let delimiter = false;
  let filesMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (delimiter) {
      afterDelimiter.push(token);
      continue;
    }
    if (token === "--") {
      delimiter = true;
      continue;
    }
    if (token === "-") return unsupportedOption(token, argv);
    if (!token.startsWith("-") || token === "") {
      beforeDelimiter.push(token);
      continue;
    }

    const equal = token.indexOf("=");
    const spelling = equal === -1 ? token : token.slice(0, equal);
    const inlineValue = equal === -1 ? null : token.slice(equal + 1);
    const spec = OPTION_BY_SPELLING.get(spelling);
    if (spec === undefined || spec.status !== "supported") return unsupportedOption(spelling, argv);
    if (inlineValue !== null && spec.value === "none") {
      return failure(
        providerError(
          `Projected rg option '${spelling}' does not accept an inline value; the backend was not invoked.`,
          {
            option: spelling,
            argv: [...argv],
          },
        ),
      );
    }

    if (spec.conflict_group !== undefined) {
      const prior = seenGroups.get(spec.conflict_group);
      if (prior !== undefined && prior.id !== spec.id) return incompatibleOptions(prior.spelling, spelling, argv);
      seenGroups.set(spec.conflict_group, { id: spec.id, spelling });
    }
    if (spec.id === "files-mode" && beforeDelimiter.length > 0) {
      return failure(
        providerError("Projected rg --files must appear before search paths; the backend was not invoked.", {
          option: "--files",
          argv: [...argv],
        }),
      );
    }
    seenOptions.add(spec.id);
    if (spec.id === "files-mode") filesMode = true;

    options.push(...spec.backend);
    if (spec.value === "required") {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.length === 0 || (inlineValue === null && value.startsWith("-"))) {
        return missingOptionValue(spelling, argv);
      }
      if (inlineValue === null) index += 1;
      options.push(value);
    }
  }

  const positionals = [...beforeDelimiter, ...afterDelimiter];
  if (positionals.includes("-")) return unsupportedOption("-", argv);
  if (filesMode) {
    const searchOnlyOption = [
      "ignore-case",
      "case-sensitive",
      "smart-case",
      "fixed-strings",
      "word-regexp",
      "invert-match",
      "with-filename",
      "no-filename",
      "line-number",
      "no-line-number",
      "files-with-matches",
      "files-without-match",
      "count",
      "only-matching",
      "max-count",
      "quiet",
    ].find((id) => seenOptions.has(id));
    if (searchOnlyOption !== undefined) {
      const option = OPTION_SPECS.find((entry) => entry.id === searchOnlyOption)?.rg[0] ?? searchOnlyOption;
      return incompatibleOptions("--files", option, argv);
    }
    const paths = validateRepositoryPaths(positionals, true, argv);
    if (!paths.ok) return paths;
    return success({ argv: [...options, "--", ...positionals], options, positionals, files_mode: true });
  }
  if (positionals.length === 0) {
    return failure(
      providerError("Projected rg requires a pattern before invoking the pinned backend.", {
        argv: [...argv],
        action: "provide <PATTERN> and optional <PATH> values",
      }),
    );
  }
  const paths = validateRepositoryPaths(positionals, false, argv);
  if (!paths.ok) return paths;
  return success({ argv: [...options, "--", ...positionals], options, positionals, files_mode: false });
}

function materializationError(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_MATERIALIZATION_MISSING", message, {
      requirement_id: TGREP_BACKEND_REQUIREMENT.id,
      requirement_kind: TGREP_BACKEND_REQUIREMENT.kind,
      ...details,
    }),
  );
}

function exactNodeSource(materialization: TgrepRuntimeMaterialization): DomainResult<string> {
  const nodePackage = materialization.closure.packages.find((candidate) => candidate.requirement_id === "node-runtime");
  if (nodePackage === undefined) {
    return materializationError("The rg adapter requires the selected exact node-runtime materialization.");
  }
  const source = path.posix.join(nodePackage.root, "bin", "node");
  const projected = materialization.closure.projection.filesystem.some(
    (entry) => entry.source === nodePackage.root && entry.target === nodePackage.root,
  );
  if (!projected || !sourceIsCanonical(source)) {
    return materializationError("The selected node-runtime executable is not in the exact strict closure projection.", {
      node_source: source,
    });
  }
  try {
    const inspected = inspectRuntimeFile(source, (_descriptor, stat) => {
      if ((stat.mode & 0o111n) === 0n) throw new Error("not executable");
      return undefined;
    });
    const resolved = inspected.source;
    const inClosure = materialization.closure.store_paths.some(
      (storePath) => resolved === storePath || resolved.startsWith(`${storePath}/`),
    );
    if (!inClosure) {
      return materializationError("The selected node-runtime executable is not a regular executable file.", {
        node_source: source,
        ...(inClosure ? {} : { resolved_source: resolved }),
      });
    }
  } catch {
    return materializationError("The selected node-runtime executable is unavailable.", { node_source: source });
  }
  if (/\s/u.test(source)) {
    return materializationError("The selected node-runtime executable cannot be used as a shebang path.", {
      node_source: source,
    });
  }
  return success(source);
}

function canonicalArtifactRoot(root: string): DomainResult<string> {
  if (!sourceIsCanonical(root)) {
    return materializationError("The rg adapter artifact root must be a canonical absolute directory.", {
      artifact_root: root,
    });
  }
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    if (!fs.lstatSync(root).isDirectory() || fs.realpathSync.native(root) !== root) {
      return materializationError("The rg adapter artifact root is not a canonical directory.", {
        artifact_root: root,
      });
    }
  } catch {
    return materializationError("The rg adapter artifact root is unavailable.", { artifact_root: root });
  }
  return success(root);
}

function renderAdapterSource(nodeSource: string, backendSource: string): string {
  const specs = JSON.stringify(OPTION_SPECS);
  const contract = JSON.stringify(TGREP_RG_COMPATIBILITY_CONTRACT_ID);
  const backend = JSON.stringify(backendSource);
  return `#!${nodeSource}
import { spawn } from "node:child_process";
import { posix } from "node:path";

const CONTRACT = ${contract};
const BACKEND = ${backend};
const SPECS = ${specs};
const BY_SPELLING = new Map(SPECS.flatMap((spec) => spec.rg.map((spelling) => [spelling, spec])));

function reject(message, details = {}) {
  const suffix = details.option === undefined ? "" : \` Option: \${details.option}.\`;
  process.stderr.write(\`Projected rg rejected argv before backend execution (\${CONTRACT}): \${message}.\${suffix}\\n\`);
  process.exitCode = 2;
  return null;
}

function isRepositoryRelativePath(value) {
  if (value.length === 0 || posix.isAbsolute(value)) return false;
  const normalized = posix.normalize(value);
  return normalized !== ".." && !normalized.startsWith("../");
}

function translate(argv) {
  const options = [], before = [], after = [], groups = new Map(), seen = new Set();
  let delimiter = false, filesMode = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (delimiter) { after.push(token); continue; }
    if (token === "--") { delimiter = true; continue; }
    if (token === "-") return reject("stdin search is unsupported", { option: token });
    if (!token.startsWith("-") || token === "") { before.push(token); continue; }
    const equal = token.indexOf("=");
    const spelling = equal === -1 ? token : token.slice(0, equal);
    const inlineValue = equal === -1 ? null : token.slice(equal + 1);
    const spec = BY_SPELLING.get(spelling);
    if (spec === undefined) return reject(\`unsupported option '\${spelling}'\`, { option: spelling });
    if (inlineValue !== null && spec.value === "none") return reject(\`option '\${spelling}' does not accept an inline value\`, { option: spelling });
    if (spec.conflict_group !== undefined) {
      const prior = groups.get(spec.conflict_group);
      if (prior !== undefined && prior.id !== spec.id) return reject(\`options '\${prior.spelling}' and '\${spelling}' are incompatible\`, { option: spelling });
      groups.set(spec.conflict_group, { id: spec.id, spelling });
    }
    if (spec.id === "files-mode" && before.length > 0) return reject("--files must precede search paths", { option: "--files" });
    seen.add(spec.id);
    if (spec.id === "files-mode") filesMode = true;
    options.push(...spec.backend);
    if (spec.value === "required") {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.length === 0 || (inlineValue === null && value.startsWith("-"))) return reject(\`option '\${spelling}' requires a value\`, { option: spelling });
      if (inlineValue === null) index += 1;
      options.push(value);
    }
  }
  const positionals = [...before, ...after];
  if (positionals.includes("-")) return reject("stdin search is unsupported", { option: "-" });
  if (filesMode) {
    const searchOnly = ["ignore-case", "case-sensitive", "smart-case", "fixed-strings", "word-regexp", "invert-match", "with-filename", "no-filename", "line-number", "no-line-number", "files-with-matches", "files-without-match", "count", "only-matching", "max-count", "quiet"].find((id) => seen.has(id));
    if (searchOnly !== undefined) return reject(\`--files cannot be combined with '\${searchOnly}'\`, { option: "--files" });
  }
  if (!filesMode && positionals.length === 0) return reject("a search pattern is required");
  const paths = filesMode ? positionals : positionals.slice(1);
  const invalidPath = paths.find((value) => !isRepositoryRelativePath(value));
  if (invalidPath !== undefined)
    return reject(\`repository-relative paths only; '\${invalidPath}' is not allowed\`);
  return [...options, "--", ...positionals];
}

const translated = translate(process.argv.slice(2));
if (translated !== null && process.exitCode !== 2) {
  const child = spawn(BACKEND, translated, { shell: false, stdio: "inherit" });
  let spawnFailed = false;
  child.once("error", (error) => {
    spawnFailed = true;
    process.stderr.write(\`Projected rg could not start its pinned backend: \${error.message.slice(0, 200)}\\n\`);
    process.exitCode = 127;
  });
  child.once("close", (code, signal) => {
    if (spawnFailed) return;
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}
`;
}

export type TgrepRgProviderMaterialization = Readonly<{
  readonly contract_id: typeof TGREP_RG_PROVIDER_CONTRACT_ID;
  readonly schema_version: typeof TGREP_RG_PROVIDER_SCHEMA_VERSION;
  readonly compatibility_contract_id: typeof TGREP_RG_COMPATIBILITY_CONTRACT_ID;
  readonly compatibility_schema_version: typeof TGREP_RG_COMPATIBILITY_SCHEMA_VERSION;
  readonly backend_source: string;
  readonly node_source: string;
  readonly adapter_source: string;
  readonly adapter_target: typeof TGREP_RG_ADAPTER_TARGET;
  readonly provider: typeof TGREP_RG_PROVIDER;
  readonly provider_materialization: RuntimeExecutableProviderMaterialization;
  readonly projection: SessionRuntimeProjection;
}>;

/**
 * Generate the concrete launcher artifact and feed it into #293's existing
 * filesystem/executable projection. The supplied #308 materialization is the
 * sole source of the tgrep backend and is never re-resolved here.
 */
export function materializeTgrepRgProvider(
  materialization: TgrepRuntimeMaterialization,
  options: Readonly<{ readonly artifact_root: string }>,
): DomainResult<TgrepRgProviderMaterialization> {
  if (!options || typeof options.artifact_root !== "string") {
    return materializationError("The rg provider requires an explicit artifact root.");
  }
  const policy = materialization.projection.policy;
  if (
    policy.mode !== STRICT_RUNTIME_POLICY.mode ||
    policy.host_visibility !== STRICT_RUNTIME_POLICY.host_visibility ||
    policy.compatibility !== STRICT_RUNTIME_POLICY.compatibility ||
    policy.unrestricted_host_fallback !== STRICT_RUNTIME_POLICY.unrestricted_host_fallback ||
    materialization.projection.executables.length !== 0
  ) {
    return materializationError("The rg provider requires the strict #308 runtime materialization policy.");
  }
  if (
    materialization.contract_id !== TGREP_RUNTIME_MATERIALIZATION_CONTRACT_ID ||
    materialization.schema_version !== TGREP_RUNTIME_MATERIALIZATION_SCHEMA_VERSION ||
    materialization.backend !== "tgrep" ||
    materialization.nixpkgs_ref !== TGREP_NIXPKGS_REF ||
    materialization.nix_installable !== TGREP_NIX_INSTALLABLE ||
    materialization.provider.id !== TGREP_BACKEND_PROVIDER.id ||
    materialization.provider.requirement_id !== TGREP_BACKEND_PROVIDER.requirement_id ||
    materialization.evidence.version !== TGREP_BACKEND_EVIDENCE.version ||
    materialization.evidence.help_sha256 !== TGREP_BACKEND_EVIDENCE.help_sha256 ||
    materialization.evidence.help_bytes !== TGREP_BACKEND_EVIDENCE.help_bytes
  ) {
    return materializationError("The supplied tgrep materialization is not the exact #308 artifact/evidence.");
  }
  const backendSource = materialization.executable_source;
  if (
    materialization.executable_target !== backendSource ||
    materialization.provider_materialization.source !== backendSource ||
    materialization.provider_materialization.provider.id !== TGREP_BACKEND_PROVIDER.id ||
    materialization.provider_materialization.provider.requirement_id !== TGREP_BACKEND_PROVIDER.requirement_id
  ) {
    return materializationError("The supplied tgrep provider materialization is not internally consistent.");
  }
  if (!sourceIsCanonical(backendSource)) {
    return materializationError("The supplied tgrep executable source is not canonical or is recursion-prone.", {
      backend_source: backendSource,
    });
  }
  const tgrepPackage = materialization.closure.packages.find(
    (candidate) => candidate.requirement_id === TGREP_BACKEND_REQUIREMENT.id,
  );
  if (
    tgrepPackage === undefined ||
    backendSource !== path.posix.join(tgrepPackage.root, "bin", "tgrep") ||
    !tgrepPackage.closure.every((storePath) =>
      materialization.projection.filesystem.some((entry) => entry.source === storePath && entry.target === storePath),
    )
  ) {
    return materializationError("The supplied tgrep executable is not backed by the exact #308 closure projection.");
  }

  const node = exactNodeSource(materialization);
  if (!node.ok) return node;
  const artifactRoot = canonicalArtifactRoot(options.artifact_root);
  if (!artifactRoot.ok) return artifactRoot;
  const adapterSource = path.join(artifactRoot.value, TGREP_RG_ENTRYPOINT_NAME);
  const content = renderAdapterSource(node.value, backendSource);
  try {
    try {
      inspectRuntimeFile(
        adapterSource,
        (descriptor, stat) => {
          if (stat.size > BigInt(MAX_ADAPTER_BYTES)) throw new Error("the adapter exceeds the bounded size");
          if (fs.readFileSync(descriptor, "utf8") !== content) throw new AdapterContentConflict();
          fs.fchmodSync(descriptor, 0o755);
          return undefined;
        },
        { requireCanonicalPath: true },
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      createRuntimeFile(adapterSource, (descriptor) => {
        fs.writeFileSync(descriptor, content, { encoding: "utf8" });
        fs.fchmodSync(descriptor, 0o755);
        return undefined;
      });
    }
  } catch (error: unknown) {
    if (error instanceof AdapterContentConflict) {
      return materializationError("The existing rg adapter artifact conflicts with the pinned materialization.", {
        adapter_source: adapterSource,
      });
    }
    return materializationError("The rg adapter artifact could not be materialized.", {
      adapter_source: adapterSource,
    });
  }

  const projection = projectSessionRuntimeProjection({
    ...materialization.projection,
    filesystem: [
      ...materialization.projection.filesystem,
      {
        source: adapterSource,
        target: TGREP_RG_ADAPTER_TARGET,
        access_mode: "read-only" as const,
        provenance: "package" as const,
      },
    ],
    executables: [
      {
        name: TGREP_RG_ENTRYPOINT_NAME,
        target: TGREP_RG_ADAPTER_TARGET,
        provider: TGREP_RG_PROVIDER,
        provenance: "package" as const,
      },
    ],
  });
  if (!projection.ok) return failure(projection.error);
  const providerMaterialization: RuntimeExecutableProviderMaterialization = Object.freeze({
    provider: TGREP_RG_PROVIDER,
    source: adapterSource,
  });
  // Exercise the same #293 materialization input used by consumers before
  // returning the artifact, so a malformed provider cannot escape this API.
  const compiled = compileRuntimeExecutableProjection(
    projection.value,
    new Map([[runtimeExecutableProviderKey(TGREP_RG_PROVIDER), providerMaterialization]]),
  );
  if (!compiled.ok) {
    return materializationError("The generated rg provider did not satisfy the canonical executable projection.", {
      reason: compiled.error.message,
    });
  }
  return success(
    Object.freeze({
      contract_id: TGREP_RG_PROVIDER_CONTRACT_ID,
      schema_version: TGREP_RG_PROVIDER_SCHEMA_VERSION,
      compatibility_contract_id: TGREP_RG_COMPATIBILITY_CONTRACT_ID,
      compatibility_schema_version: TGREP_RG_COMPATIBILITY_SCHEMA_VERSION,
      backend_source: backendSource,
      node_source: node.value,
      adapter_source: adapterSource,
      adapter_target: TGREP_RG_ADAPTER_TARGET,
      provider: TGREP_RG_PROVIDER,
      provider_materialization: providerMaterialization,
      projection: projection.value,
    }),
  );
}

export const materializeTgrepRgRuntime = materializeTgrepRgProvider;
export const projectTgrepRgRuntime = materializeTgrepRgProvider;
