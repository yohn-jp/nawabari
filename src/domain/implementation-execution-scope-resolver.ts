import {
  IMPLEMENTATION_EXECUTION_SCOPE_KIND,
  IMPLEMENTATION_EXECUTION_SCOPE_VERSION,
  parseImplementationExecutionScope,
  type BaseIdentity,
  type ImplementationExecutionScopeArtifact,
  type ImplementationExecutionScopeProducerLocator,
  type ImplementationExecutionScopeSourceIdentity,
  type RepositoryIdentity,
} from "../working-set.js";

export type ImplementationExecutionScopeResolutionRequest = {
  readonly source: ImplementationExecutionScopeSourceIdentity & {
    readonly producer: ImplementationExecutionScopeProducerLocator;
  };
  readonly repository: RepositoryIdentity;
  readonly base: BaseIdentity;
};

/** The configured application adapter attests that `resolved` is the producer's current artifact. */
export type ImplementationExecutionScopeResolverResult =
  | { readonly status: "resolved"; readonly artifact: unknown }
  | { readonly status: "unavailable" | "stale" | "invalid"; readonly reason?: string };

export interface ImplementationExecutionScopeResolver {
  resolveLatest(
    request: ImplementationExecutionScopeResolutionRequest,
  ): Promise<ImplementationExecutionScopeResolverResult>;
}

export type ImplementationExecutionScopeResolution =
  | { readonly status: "resolved"; readonly artifact: ImplementationExecutionScopeArtifact }
  | { readonly status: "unavailable" | "stale" | "invalid"; readonly reason: string };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedReason(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, 200) : fallback;
}

function resolutionFailure(
  status: "unavailable" | "stale" | "invalid",
  reason: string,
): ImplementationExecutionScopeResolution {
  return Object.freeze({ status, reason: reason.slice(0, 200) });
}

function producerLocator(value: unknown): ImplementationExecutionScopeProducerLocator | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.repositoryHost) ||
    !isNonEmptyString(value.repositoryId) ||
    !Number.isSafeInteger(value.number) ||
    (value.number as number) < 1
  ) {
    return undefined;
  }
  return Object.freeze({
    repositoryHost: value.repositoryHost,
    repositoryId: value.repositoryId,
    number: value.number as number,
  });
}

function sameRepository(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return left.repositoryHost === right.repositoryHost && left.repositoryId === right.repositoryId;
}

function sameBase(left: BaseIdentity, right: BaseIdentity): boolean {
  return (
    left.branch === right.branch &&
    left.revision === right.revision &&
    (left.freshness === undefined || right.freshness === undefined || left.freshness === right.freshness)
  );
}

function validRepository(value: unknown): value is RepositoryIdentity {
  return (
    isRecord(value) &&
    isNonEmptyString(value.repositoryHost) &&
    isNonEmptyString(value.repositoryId) &&
    (value.repository === undefined || isNonEmptyString(value.repository))
  );
}

function validBase(value: unknown): value is BaseIdentity {
  return (
    isRecord(value) &&
    isNonEmptyString(value.branch) &&
    isNonEmptyString(value.revision) &&
    (value.freshness === undefined || isNonEmptyString(value.freshness))
  );
}

function validSource(value: unknown): value is ImplementationExecutionScopeSourceIdentity {
  return (
    isRecord(value) &&
    value.kind === IMPLEMENTATION_EXECUTION_SCOPE_KIND &&
    value.version === IMPLEMENTATION_EXECUTION_SCOPE_VERSION &&
    typeof value.digest === "string" &&
    /^[a-f0-9]{64}$/u.test(value.digest) &&
    typeof value.identity === "string" &&
    /^[a-f0-9]{64}$/u.test(value.identity)
  );
}

function immutableRequest(
  source: ImplementationExecutionScopeSourceIdentity,
  producer: ImplementationExecutionScopeProducerLocator,
  repository: RepositoryIdentity,
  base: BaseIdentity,
): ImplementationExecutionScopeResolutionRequest {
  return Object.freeze({
    source: Object.freeze({
      kind: source.kind,
      version: source.version,
      digest: source.digest,
      identity: source.identity,
      producer,
    }),
    repository: Object.freeze({
      repositoryHost: repository.repositoryHost,
      repositoryId: repository.repositoryId,
      ...(repository.repository === undefined ? {} : { repository: repository.repository }),
    }),
    base: Object.freeze({
      branch: base.branch,
      revision: base.revision,
      ...(base.freshness === undefined ? {} : { freshness: base.freshness }),
    }),
  });
}

/**
 * Resolve a fresh producer artifact using only persisted source provenance.
 * Persisted scope is comparison evidence and is never returned as a fallback.
 */
export async function resolveLatestImplementationExecutionScope(
  resolver: ImplementationExecutionScopeResolver | undefined,
  provenance: unknown,
): Promise<ImplementationExecutionScopeResolution> {
  if (!isRecord(provenance)) return resolutionFailure("invalid", "Effective Working Set provenance is malformed");
  const source = provenance.executionScope;
  if (!validSource(source)) return resolutionFailure("invalid", "Execution scope source provenance is invalid");
  if (source.producer === undefined) {
    return resolutionFailure("unavailable", "Persisted execution scope has no implementation producer locator");
  }
  const producer = producerLocator(source.producer);
  if (producer === undefined)
    return resolutionFailure("invalid", "Persisted implementation producer locator is invalid");
  if (!validRepository(provenance.repository) || !validBase(provenance.base)) {
    return resolutionFailure("invalid", "Effective Working Set repository or base provenance is invalid");
  }
  if (resolver === undefined) return resolutionFailure("unavailable", "No implementation scope resolver is configured");

  const request = immutableRequest(source, producer, provenance.repository, provenance.base);
  let result: unknown;
  try {
    result = await resolver.resolveLatest(request);
  } catch {
    return resolutionFailure("unavailable", "Implementation scope producer could not be observed");
  }
  if (!isRecord(result)) return resolutionFailure("invalid", "Implementation scope resolver result is malformed");
  if (result.status === "unavailable" || result.status === "stale" || result.status === "invalid") {
    return resolutionFailure(result.status, boundedReason(result.reason, `Implementation scope is ${result.status}`));
  }
  if (result.status !== "resolved") {
    return resolutionFailure("invalid", "Implementation scope resolver returned an unknown status");
  }

  let artifact: ImplementationExecutionScopeArtifact;
  try {
    artifact = parseImplementationExecutionScope(result.artifact);
  } catch {
    return resolutionFailure("invalid", "Resolved implementation scope artifact is invalid");
  }

  if (!sameRepository(artifact.repository, provenance.repository) || !sameBase(artifact.base, provenance.base)) {
    return resolutionFailure("stale", "Resolved implementation scope repository or base has changed");
  }
  const implementation = artifact.authorization.implementation;
  if (
    !isRecord(implementation) ||
    implementation.repositoryHost !== producer.repositoryHost ||
    implementation.repositoryId !== producer.repositoryId ||
    implementation.number !== producer.number
  ) {
    return resolutionFailure("stale", "Resolved implementation scope belongs to another producer");
  }
  return Object.freeze({ status: "resolved", artifact });
}
