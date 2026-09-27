import assert from "node:assert/strict";
import test from "node:test";

import {
  CANDIDATE_WORKING_SET_KIND,
  IMPLEMENTATION_EXECUTION_SCOPE_KIND,
  IMPLEMENTATION_EXECUTION_SCOPE_VERSION,
  type EffectiveWorkingSetProvenance,
  type ImplementationExecutionScopeArtifact,
  composeEffectiveWorkingSet,
} from "../working-set.js";
import {
  resolveLatestImplementationExecutionScope,
  type ImplementationExecutionScopeResolver,
  type ImplementationExecutionScopeResolverResult,
} from "./implementation-execution-scope-resolver.js";

const repository = { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" };
const base = { branch: "main", revision: "a".repeat(40), freshness: `main@${"a".repeat(40)}` };
const producer = { repositoryHost: repository.repositoryHost, repositoryId: repository.repositoryId, number: 727 };

function persistedProvenance(): EffectiveWorkingSetProvenance {
  const composed = composeEffectiveWorkingSet({
    executionScope: artifact({ bodyDigest: "b".repeat(64) }),
    candidateWorkingSet: {
      kind: CANDIDATE_WORKING_SET_KIND,
      schemaVersion: 1,
      workingSetId: "candidate-727",
      repository,
      revision: base.revision,
      entries: [],
    },
    repository,
    base,
  });
  assert.equal(composed.status, "satisfied");
  if (composed.status !== "satisfied") throw new Error("fixture Effective Working Set could not be composed");
  return JSON.parse(JSON.stringify(composed.workingSet.provenance)) as EffectiveWorkingSetProvenance;
}

function artifact(
  overrides: {
    repository?: typeof repository;
    base?: typeof base;
    producer?: typeof producer;
    bodyDigest?: string;
  } = {},
): ImplementationExecutionScopeArtifact {
  const currentRepository = overrides.repository ?? repository;
  const currentProducer = overrides.producer ?? producer;
  return {
    version: 1,
    kind: IMPLEMENTATION_EXECUTION_SCOPE_KIND,
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: currentProducer,
      governedBodyDigest: overrides.bodyDigest ?? "d".repeat(64),
    },
    repository: currentRepository,
    base: overrides.base ?? base,
    scope: { readOnly: ["src/**"], write: ["src/new.ts"], create: [], delete: [], deny: [] },
  };
}

function resolver(result: ImplementationExecutionScopeResolverResult): ImplementationExecutionScopeResolver {
  return { resolveLatest: async () => result };
}

test("resolves a changed current artifact by persisted producer locator after restart", async () => {
  const input = persistedProvenance();
  const before = structuredClone(input);
  let requestCount = 0;
  const currentArtifact = artifact({ bodyDigest: "f".repeat(64) });
  const configuredResolver: ImplementationExecutionScopeResolver = {
    async resolveLatest(request) {
      requestCount += 1;
      assert.deepEqual(request.source, input.executionScope);
      assert.deepEqual(request.repository, repository);
      assert.deepEqual(request.base, base);
      assert.equal(Object.isFrozen(request), true);
      assert.equal(Object.isFrozen(request.source), true);
      assert.equal(Object.isFrozen(request.source.producer), true);
      return { status: "resolved", artifact: currentArtifact };
    },
  };

  const result = await resolveLatestImplementationExecutionScope(configuredResolver, input);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.artifact.authorization.governedBodyDigest, "f".repeat(64));
    assert.deepEqual(result.artifact.scope.write, ["src/new.ts"]);
  }
  assert.equal(requestCount, 1);
  assert.deepEqual(input, before);
});

test("legacy provenance without a producer locator remains readable but cannot resolve", async () => {
  const current = persistedProvenance();
  const legacyExecutionScope = { ...current.executionScope };
  delete legacyExecutionScope.producer;
  const legacyProvenance: EffectiveWorkingSetProvenance = {
    ...current,
    executionScope: legacyExecutionScope,
  };
  let requestCount = 0;
  const configuredResolver: ImplementationExecutionScopeResolver = {
    async resolveLatest() {
      requestCount += 1;
      return { status: "resolved", artifact: artifact() };
    },
  };

  const result = await resolveLatestImplementationExecutionScope(configuredResolver, legacyProvenance);
  assert.deepEqual(result, {
    status: "unavailable",
    reason: "Persisted execution scope has no implementation producer locator",
  });
  assert.equal(requestCount, 0);
});

test("malformed persisted producer locator is invalid and never reaches the resolver", async () => {
  const current = persistedProvenance();
  const malformed: EffectiveWorkingSetProvenance = {
    ...current,
    executionScope: {
      ...current.executionScope,
      producer: { ...producer, number: 0 },
    },
  };
  let requestCount = 0;
  const configuredResolver: ImplementationExecutionScopeResolver = {
    async resolveLatest() {
      requestCount += 1;
      return { status: "resolved", artifact: artifact() };
    },
  };

  const result = await resolveLatestImplementationExecutionScope(configuredResolver, malformed);
  assert.deepEqual(result, { status: "invalid", reason: "Persisted implementation producer locator is invalid" });
  assert.equal(requestCount, 0);
});

test("missing resolver cannot turn persisted provenance into current authorization", async () => {
  const result = await resolveLatestImplementationExecutionScope(undefined, persistedProvenance());
  assert.deepEqual(result, { status: "unavailable", reason: "No implementation scope resolver is configured" });
});

test("propagates explicit unavailable, stale, and invalid producer outcomes without artifacts", async (t) => {
  for (const status of ["unavailable", "stale", "invalid"] as const) {
    await t.test(status, async () => {
      const result = await resolveLatestImplementationExecutionScope(
        resolver({ status, reason: `producer ${status}` }),
        persistedProvenance(),
      );
      assert.deepEqual(result, { status, reason: `producer ${status}` });
    });
  }
});

test("rejects a resolved artifact with a different repository or base", async (t) => {
  const differentRepository = {
    ...repository,
    repositoryId: "999999999",
  };
  const differentBase = { ...base, revision: "9".repeat(40), freshness: `main@${"9".repeat(40)}` };

  for (const [name, currentArtifact] of [
    ["repository", artifact({ repository: differentRepository, producer: { ...producer, repositoryId: "999999999" } })],
    ["base", artifact({ base: differentBase })],
  ] as const) {
    await t.test(name, async () => {
      const result = await resolveLatestImplementationExecutionScope(
        resolver({ status: "resolved", artifact: currentArtifact }),
        persistedProvenance(),
      );
      assert.equal(result.status, "stale");
      assert.equal("artifact" in result, false);
    });
  }
});

test("rejects an artifact from another implementation producer", async () => {
  const result = await resolveLatestImplementationExecutionScope(
    resolver({ status: "resolved", artifact: artifact({ producer: { ...producer, number: 728 } }) }),
    persistedProvenance(),
  );
  assert.deepEqual(result, {
    status: "stale",
    reason: "Resolved implementation scope belongs to another producer",
  });
});

test("rejects malformed artifacts and resolver outcomes", async (t) => {
  await t.test("invalid artifact", async () => {
    const result = await resolveLatestImplementationExecutionScope(
      resolver({ status: "resolved", artifact: { kind: IMPLEMENTATION_EXECUTION_SCOPE_KIND } }),
      persistedProvenance(),
    );
    assert.equal(result.status, "invalid");
    assert.equal("artifact" in result, false);
  });

  await t.test("unknown resolver status", async () => {
    const result = await resolveLatestImplementationExecutionScope(
      resolver({ status: "current" } as unknown as ImplementationExecutionScopeResolverResult),
      persistedProvenance(),
    );
    assert.deepEqual(result, {
      status: "invalid",
      reason: "Implementation scope resolver returned an unknown status",
    });
  });
});

test("resolver exceptions fail closed as unavailable", async () => {
  const result = await resolveLatestImplementationExecutionScope(
    {
      async resolveLatest() {
        throw new Error("transport detail is not surfaced");
      },
    },
    persistedProvenance(),
  );
  assert.deepEqual(result, {
    status: "unavailable",
    reason: "Implementation scope producer could not be observed",
  });
});
