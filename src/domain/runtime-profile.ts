import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import type { RuntimeProfileIdentity, RuntimeRequirement } from "./runtime-projection.js";

/** Versioned identity for the logical runtime-profile/material contract. */
export const RUNTIME_PROFILE_CONTRACT_ID = "nawabari.runtime-profile.v1" as const;
export const RUNTIME_PROFILE_SCHEMA_VERSION = 1 as const;

export const RUNTIME_PROFILE_REQUIREMENT_KINDS = Object.freeze(["runtime", "package"] as const);
export type RuntimeProfileRequirement = RuntimeRequirement;
export type RuntimeProfileRequirementKind = (typeof RUNTIME_PROFILE_REQUIREMENT_KINDS)[number];

/** A profile is material identity plus logical requirements, never mounts or commands. */
export type RuntimeProfileDefinition = Readonly<{
  readonly id: string;
  readonly version: string;
  readonly extends: readonly string[];
  readonly requirements: readonly RuntimeProfileRequirement[];
}>;

export type RuntimeProfileRequirementOperation =
  | Readonly<{ readonly operation: "add"; readonly requirement: RuntimeProfileRequirement }>
  | Readonly<{ readonly operation: "remove"; readonly requirement_id: string }>
  | Readonly<{ readonly operation: "override"; readonly requirement: RuntimeProfileRequirement }>;

/** Profile IDs are an explicit composition set; operation order is explicit and significant. */
export type RuntimeProfileSelection = Readonly<{
  readonly profiles: readonly string[];
  readonly operations?: readonly RuntimeProfileRequirementOperation[];
}>;

export type ResolvedRuntimeProfile = Readonly<{
  readonly contract_id: typeof RUNTIME_PROFILE_CONTRACT_ID;
  readonly schema_version: typeof RUNTIME_PROFILE_SCHEMA_VERSION;
  readonly profile: RuntimeProfileIdentity;
  readonly selected_profiles: readonly RuntimeProfileIdentity[];
  readonly requirements: readonly RuntimeProfileRequirement[];
}>;

export type RuntimeProfileErrorCode = Extract<
  ErrorCode,
  | "RUNTIME_PROFILE_INVALID"
  | "RUNTIME_PROFILE_AMBIGUOUS"
  | "RUNTIME_PROFILE_MISSING"
  | "RUNTIME_PROFILE_REQUIREMENT_MISSING"
  | "RUNTIME_PROFILE_REQUIREMENT_CONFLICT"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
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

function requirementKey(requirement: RuntimeProfileRequirement): string {
  return requirement.id;
}

function requirementSortKey(requirement: RuntimeProfileRequirement): string {
  return `${requirement.kind}:${requirement.id}`;
}

function sameRequirement(left: RuntimeProfileRequirement, right: RuntimeProfileRequirement): boolean {
  return left.id === right.id && left.kind === right.kind && left.name === right.name && left.version === right.version;
}

function profileFailure(
  code: RuntimeProfileErrorCode,
  field: string,
  reason: string,
  details: JsonObject = {},
): DomainResult<never> {
  return failure(
    new DomainError(code, `Runtime profile field '${field}' is invalid: ${reason}.`, {
      field,
      ...details,
    }),
  );
}

function profileAmbiguity(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_AMBIGUOUS", `Runtime profile field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function missingProfile(profileId: string, referencedBy?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROFILE_MISSING", `Runtime profile '${profileId}' is not declared.`, {
      profile_id: profileId,
      ...(referencedBy === undefined ? {} : { referenced_by: referencedBy }),
    }),
  );
}

function missingRequirement(requirementId: string, operation: "remove" | "override"): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROFILE_REQUIREMENT_MISSING",
      `Runtime profile requirement '${requirementId}' cannot be ${operation}d because it is not selected.`,
      { requirement_id: requirementId, operation },
    ),
  );
}

function validateRequirement(value: unknown, field: string): DomainResult<RuntimeProfileRequirement> {
  if (!isRecord(value)) return profileFailure("RUNTIME_PROFILE_INVALID", field, "expected a requirement object");
  if (
    !isStableIdentifier(value.id) ||
    !RUNTIME_PROFILE_REQUIREMENT_KINDS.includes(value.kind as RuntimeProfileRequirementKind) ||
    !isNonEmptyText(value.name) ||
    !isNonEmptyText(value.version)
  ) {
    return profileFailure("RUNTIME_PROFILE_INVALID", field, "expected stable id, kind, name, and version");
  }
  if (
    value.name.startsWith("/") ||
    value.name.startsWith("~") ||
    value.name.startsWith("$") ||
    value.version.startsWith("/") ||
    value.version.startsWith("~") ||
    value.version.startsWith("$")
  ) {
    return profileFailure("RUNTIME_PROFILE_INVALID", field, "host paths are not logical package names or versions");
  }
  if ("source" in value || "target" in value || "provider" in value || "executable" in value) {
    return profileFailure(
      "RUNTIME_PROFILE_INVALID",
      field,
      "runtime profiles declare material only and cannot contain projection or executable fields",
    );
  }
  return success(
    Object.freeze({
      id: value.id,
      kind: value.kind as RuntimeProfileRequirementKind,
      name: value.name,
      version: value.version,
    }),
  );
}

function validateDefinition(value: unknown, index: number): DomainResult<RuntimeProfileDefinition> {
  const field = `catalog[${index}]`;
  if (!isRecord(value)) return profileFailure("RUNTIME_PROFILE_INVALID", field, "expected a profile object");
  if (!isStableIdentifier(value.id) || !isNonEmptyText(value.version)) {
    return profileFailure("RUNTIME_PROFILE_INVALID", field, "expected a stable id and non-empty version");
  }
  if (!Array.isArray(value.extends)) {
    return profileFailure("RUNTIME_PROFILE_INVALID", `${field}.extends`, "expected an array");
  }
  if (!Array.isArray(value.requirements)) {
    return profileFailure("RUNTIME_PROFILE_INVALID", `${field}.requirements`, "expected an array");
  }
  if ("filesystem" in value || "executables" in value) {
    return profileFailure(
      "RUNTIME_PROFILE_INVALID",
      field,
      "runtime profiles cannot contain filesystem or executable projections",
    );
  }

  const parents: string[] = [];
  for (const [parentIndex, parent] of value.extends.entries()) {
    if (!isStableIdentifier(parent)) {
      return profileFailure(
        "RUNTIME_PROFILE_INVALID",
        `${field}.extends[${parentIndex}]`,
        "expected a stable profile id",
      );
    }
    if (parents.includes(parent)) return profileAmbiguity(`${field}.extends`, "duplicate parent profile", parent);
    parents.push(parent);
  }

  const requirements: RuntimeProfileRequirement[] = [];
  const ids = new Set<string>();
  for (const [requirementIndex, requirement] of value.requirements.entries()) {
    const result = validateRequirement(requirement, `${field}.requirements[${requirementIndex}]`);
    if (!result.ok) return failure(result.error);
    if (ids.has(result.value.id)) {
      return profileAmbiguity(`${field}.requirements`, "duplicate requirement id", result.value.id);
    }
    ids.add(result.value.id);
    requirements.push(result.value);
  }

  return success(
    Object.freeze({
      id: value.id,
      version: value.version,
      extends: Object.freeze(parents.sort(compareText)),
      requirements: Object.freeze(
        requirements.sort((left, right) => compareText(requirementSortKey(left), requirementSortKey(right))),
      ),
    }),
  );
}

function validateCatalog(value: unknown): DomainResult<ReadonlyMap<string, RuntimeProfileDefinition>> {
  if (!Array.isArray(value)) return profileFailure("RUNTIME_PROFILE_INVALID", "catalog", "expected an array");
  const catalog = new Map<string, RuntimeProfileDefinition>();
  for (const [index, definition] of value.entries()) {
    const result = validateDefinition(definition, index);
    if (!result.ok) return failure(result.error);
    if (catalog.has(result.value.id)) return profileAmbiguity("catalog", "duplicate profile id", result.value.id);
    catalog.set(result.value.id, result.value);
  }
  return success(catalog);
}

function validateSelection(value: unknown): DomainResult<{
  readonly profiles: readonly string[];
  readonly operations: readonly RuntimeProfileRequirementOperation[];
}> {
  if (!isRecord(value) || !Array.isArray(value.profiles) || value.profiles.length === 0) {
    return profileFailure("RUNTIME_PROFILE_INVALID", "selection.profiles", "expected a non-empty array");
  }
  const profiles: string[] = [];
  for (const [index, profile] of value.profiles.entries()) {
    if (!isStableIdentifier(profile)) {
      return profileFailure("RUNTIME_PROFILE_INVALID", `selection.profiles[${index}]`, "expected a stable profile id");
    }
    if (profiles.includes(profile))
      return profileAmbiguity("selection.profiles", "duplicate selected profile", profile);
    profiles.push(profile);
  }

  if (value.operations !== undefined && !Array.isArray(value.operations)) {
    return profileFailure("RUNTIME_PROFILE_INVALID", "selection.operations", "expected an array");
  }
  const operations: RuntimeProfileRequirementOperation[] = [];
  for (const [index, operation] of (value.operations ?? []).entries()) {
    const field = `selection.operations[${index}]`;
    if (
      !isRecord(operation) ||
      (operation.operation !== "add" && operation.operation !== "remove" && operation.operation !== "override")
    ) {
      return profileFailure("RUNTIME_PROFILE_INVALID", field, "expected add, remove, or override");
    }
    if (operation.operation === "remove") {
      if (!isStableIdentifier(operation.requirement_id)) {
        return profileFailure("RUNTIME_PROFILE_INVALID", `${field}.requirement_id`, "expected a stable requirement id");
      }
      operations.push(Object.freeze({ operation: "remove", requirement_id: operation.requirement_id }));
      continue;
    }
    const requirement = validateRequirement(operation.requirement, `${field}.requirement`);
    if (!requirement.ok) return failure(requirement.error);
    operations.push(Object.freeze({ operation: operation.operation, requirement: requirement.value }));
  }

  return success({
    profiles: Object.freeze(profiles.sort(compareText)),
    operations: Object.freeze(operations),
  });
}

function mergeRequirements(
  target: Map<string, RuntimeProfileRequirement>,
  requirements: readonly RuntimeProfileRequirement[],
  source: string,
): DomainResult<null> {
  for (const requirement of requirements) {
    const key = requirementKey(requirement);
    const existing = target.get(key);
    if (existing === undefined) {
      target.set(key, requirement);
      continue;
    }
    if (!sameRequirement(existing, requirement)) {
      return failure(
        new DomainError(
          "RUNTIME_PROFILE_REQUIREMENT_CONFLICT",
          `Runtime profile requirement '${requirement.id}' has conflicting definitions.`,
          {
            requirement_id: requirement.id,
            existing_name: existing.name,
            existing_version: existing.version,
            conflicting_name: requirement.name,
            conflicting_version: requirement.version,
            source,
          },
        ),
      );
    }
  }
  return success(null);
}

function resolveDefinition(
  profileId: string,
  catalog: ReadonlyMap<string, RuntimeProfileDefinition>,
  states: Map<string, "visiting" | "resolved">,
  resolved: Map<string, readonly RuntimeProfileRequirement[]>,
): DomainResult<readonly RuntimeProfileRequirement[]> {
  const cached = resolved.get(profileId);
  if (cached !== undefined) return success(cached);
  if (states.get(profileId) === "visiting") {
    return profileAmbiguity("catalog.extends", "profile inheritance cycle", profileId);
  }
  const definition = catalog.get(profileId);
  if (definition === undefined) return missingProfile(profileId);
  states.set(profileId, "visiting");

  const requirements = new Map<string, RuntimeProfileRequirement>();
  for (const parent of definition.extends) {
    const result = resolveDefinition(parent, catalog, states, resolved);
    if (!result.ok) {
      if (result.error.code === "RUNTIME_PROFILE_MISSING") {
        return missingProfile(parent, profileId);
      }
      return failure(result.error);
    }
    const merged = mergeRequirements(requirements, result.value, parent);
    if (!merged.ok) return failure(merged.error);
  }
  const merged = mergeRequirements(requirements, definition.requirements, profileId);
  if (!merged.ok) return failure(merged.error);
  const canonical = Object.freeze(
    [...requirements.values()].sort((left, right) => compareText(requirementSortKey(left), requirementSortKey(right))),
  );
  states.set(profileId, "resolved");
  resolved.set(profileId, canonical);
  return success(canonical);
}

function applyOperations(
  requirements: Map<string, RuntimeProfileRequirement>,
  operations: readonly RuntimeProfileRequirementOperation[],
): DomainResult<null> {
  for (const operation of operations) {
    if (operation.operation === "remove") {
      if (!requirements.has(operation.requirement_id)) return missingRequirement(operation.requirement_id, "remove");
      requirements.delete(operation.requirement_id);
      continue;
    }
    const key = requirementKey(operation.requirement);
    if (operation.operation === "add") {
      if (requirements.has(key)) {
        return failure(
          new DomainError(
            "RUNTIME_PROFILE_REQUIREMENT_CONFLICT",
            `Runtime profile requirement '${operation.requirement.id}' is added twice.`,
            {
              requirement_id: operation.requirement.id,
              operation: "add",
            },
          ),
        );
      }
      requirements.set(key, operation.requirement);
      continue;
    }
    const existing = requirements.get(key);
    if (existing === undefined) return missingRequirement(operation.requirement.id, "override");
    if (existing.kind !== operation.requirement.kind) {
      return failure(
        new DomainError(
          "RUNTIME_PROFILE_REQUIREMENT_CONFLICT",
          `Runtime profile requirement '${operation.requirement.id}' cannot change kind during override.`,
          {
            requirement_id: operation.requirement.id,
            existing_kind: existing.kind,
            conflicting_kind: operation.requirement.kind,
            operation: "override",
          },
        ),
      );
    }
    requirements.set(key, operation.requirement);
  }
  return success(null);
}

function composedIdentity(
  definitions: readonly RuntimeProfileDefinition[],
  operationCount: number,
  requirements: readonly RuntimeProfileRequirement[],
): RuntimeProfileIdentity {
  if (definitions.length === 1 && operationCount === 0) {
    return Object.freeze({ id: definitions[0].id, version: definitions[0].version });
  }
  const id = `composition-${definitions.map((definition) => definition.id).join("--")}${operationCount === 0 ? "" : "-custom"}`;
  const material = requirements
    .map((requirement) => `${requirement.id}=${requirement.kind}:${requirement.name}@${requirement.version}`)
    .join(",");
  const version = `${definitions.map((definition) => definition.version).join("+")}:${material}`;
  return Object.freeze({ id, version });
}

/**
 * Resolve an explicit, backend-neutral profile selection without consulting
 * PATH, home directories, shell configuration, package managers, or the host.
 */
export function resolveRuntimeProfile(
  selection: unknown,
  catalog: unknown = CANONICAL_RUNTIME_PROFILES,
): DomainResult<ResolvedRuntimeProfile> {
  const catalogResult = validateCatalog(catalog);
  if (!catalogResult.ok) return failure(catalogResult.error);
  const selectionResult = validateSelection(selection);
  if (!selectionResult.ok) return failure(selectionResult.error);

  const states = new Map<string, "visiting" | "resolved">();
  const resolved = new Map<string, readonly RuntimeProfileRequirement[]>();
  const requirements = new Map<string, RuntimeProfileRequirement>();
  const definitions: RuntimeProfileDefinition[] = [];
  for (const profileId of selectionResult.value.profiles) {
    const definition = catalogResult.value.get(profileId);
    if (definition === undefined) return missingProfile(profileId);
    definitions.push(definition);
    const result = resolveDefinition(profileId, catalogResult.value, states, resolved);
    if (!result.ok) return failure(result.error);
    const merged = mergeRequirements(requirements, result.value, profileId);
    if (!merged.ok) return failure(merged.error);
  }

  const operations = selectionResult.value.operations;
  const applied = applyOperations(requirements, operations);
  if (!applied.ok) return failure(applied.error);

  const selectedProfiles = Object.freeze(
    [...definitions]
      .sort((left, right) => compareText(left.id, right.id))
      .map((definition) => Object.freeze({ id: definition.id, version: definition.version })),
  );
  return success(
    Object.freeze({
      contract_id: RUNTIME_PROFILE_CONTRACT_ID,
      schema_version: RUNTIME_PROFILE_SCHEMA_VERSION,
      profile: composedIdentity(
        definitions,
        operations.length,
        [...requirements.values()].sort((left, right) =>
          compareText(requirementSortKey(left), requirementSortKey(right)),
        ),
      ),
      selected_profiles: selectedProfiles,
      requirements: Object.freeze(
        [...requirements.values()].sort((left, right) =>
          compareText(requirementSortKey(left), requirementSortKey(right)),
        ),
      ),
    }),
  );
}

/** Convenience form for callers that already have explicit profile IDs. */
export function composeRuntimeProfiles(
  profiles: readonly string[],
  operations: readonly RuntimeProfileRequirementOperation[] = [],
  catalog: readonly RuntimeProfileDefinition[] = CANONICAL_RUNTIME_PROFILES,
): DomainResult<ResolvedRuntimeProfile> {
  return resolveRuntimeProfile({ profiles, operations }, catalog);
}

export const selectRuntimeProfile = resolveRuntimeProfile;

export const BASE_RUNTIME_PROFILE: RuntimeProfileDefinition = Object.freeze({
  id: "base",
  version: "1",
  extends: Object.freeze([]),
  requirements: Object.freeze([Object.freeze({ id: "node-runtime", kind: "runtime", name: "node", version: ">=24" })]),
});

export const MINIMAL_RUNTIME_PROFILE = BASE_RUNTIME_PROFILE;

export const DEVELOPMENT_RUNTIME_PROFILE: RuntimeProfileDefinition = Object.freeze({
  id: "development",
  version: "1",
  extends: Object.freeze(["base"]),
  requirements: Object.freeze([
    Object.freeze({ id: "git-package", kind: "package", name: "git", version: ">=2" }),
    Object.freeze({ id: "ls-runtime", kind: "runtime", name: "ls", version: ">=1" }),
  ]),
});

export const DEFAULT_DEVELOPMENT_RUNTIME_PROFILE = DEVELOPMENT_RUNTIME_PROFILE;
export const CANONICAL_RUNTIME_PROFILES: readonly RuntimeProfileDefinition[] = Object.freeze([
  BASE_RUNTIME_PROFILE,
  DEVELOPMENT_RUNTIME_PROFILE,
]);

export function isRuntimeProfileError(
  error: DomainError,
): error is DomainError & { readonly code: RuntimeProfileErrorCode } {
  return (
    error.code === "RUNTIME_PROFILE_INVALID" ||
    error.code === "RUNTIME_PROFILE_AMBIGUOUS" ||
    error.code === "RUNTIME_PROFILE_MISSING" ||
    error.code === "RUNTIME_PROFILE_REQUIREMENT_MISSING" ||
    error.code === "RUNTIME_PROFILE_REQUIREMENT_CONFLICT"
  );
}

/** JSON-safe descriptor for consumers that need to identify this contract. */
export const RUNTIME_PROFILE_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: RUNTIME_PROFILE_CONTRACT_ID,
  schema_version: RUNTIME_PROFILE_SCHEMA_VERSION,
  fields: ["profile", "selected_profiles", "requirements"],
  ownership: {
    describes: "logical runtime/package material",
    excludes: ["filesystem", "executables", "providers", "host-discovery"],
  },
});
