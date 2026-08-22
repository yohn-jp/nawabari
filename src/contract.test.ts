import assert from "node:assert/strict";
import test from "node:test";

import {
  MACHINE_CONTRACT_ID,
  MACHINE_CONTRACT_SCHEMA_VERSION,
  RESOURCE_CLAIM_MACHINE_CONTRACT_ID,
  RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
  machineContract,
} from "./contract.js";
import { RESOURCE_CLAIM_FAILURE_CODES } from "./domain/errors.js";
import { RESOURCE_CLAIM_SCHEMA_VERSION } from "./resource-claims.js";
import { runCli } from "./cli.js";

type JsonRecord = Record<string, unknown>;

function resourceCapability(): JsonRecord {
  const contract = machineContract("test-version");
  assert.ok(Array.isArray(contract.capabilities));
  const capability = contract.capabilities.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      candidate.id === "resource-claims",
  );
  assert.ok(capability && typeof capability === "object" && !Array.isArray(capability));
  return capability as JsonRecord;
}

function assertKeysMatchSchema(value: JsonRecord, required: readonly string[], label: string): void {
  for (const key of required) assert.ok(key in value, `${label} is missing advertised field ${key}`);
}

function assertFailureVocabulary(
  advertised: readonly string[],
  implementation: readonly string[],
  fixtureLabel = "resource lifecycle",
): void {
  const expected = new Set(implementation);
  const actual = new Set(advertised);
  const missing = implementation.filter((code) => !actual.has(code));
  const extra = advertised.filter((code) => !expected.has(code));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] }, `${fixtureLabel} failure vocabulary drifted`);
}

function assertResultSchema(
  capability: JsonRecord,
  command: string,
  result: JsonRecord,
  nestedClaimSchemaVersion: number,
): void {
  const mappings = capability.result_schemas;
  assert.ok(Array.isArray(mappings));
  const mapping = mappings.find(
    (candidate) =>
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Array.isArray((candidate as JsonRecord).commands) &&
      ((candidate as JsonRecord).commands as unknown[]).includes(command),
  );
  assert.ok(mapping && typeof mapping === "object" && !Array.isArray(mapping));
  const required = (mapping as JsonRecord).required;
  assert.ok(Array.isArray(required));
  assertKeysMatchSchema(result, required as string[], `${command} result`);
  assert.equal((mapping as JsonRecord).nested_claim_schema_version, nestedClaimSchemaVersion);
  assert.equal((mapping as JsonRecord).version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
}

test("resource-claim capability publishes the current semantic generation without changing the envelope identity", () => {
  const contract = machineContract("test-version");
  assert.equal(contract.contract_id, MACHINE_CONTRACT_ID);
  assert.equal(contract.schema_version, MACHINE_CONTRACT_SCHEMA_VERSION);

  const versioning = contract.contract_versioning as JsonRecord;
  const topLevel = versioning.top_level as JsonRecord;
  const resourceClaims = versioning.resource_claims as JsonRecord;
  assert.equal(topLevel.decision, "meaning-compatible-top-level-identity");
  assert.equal(resourceClaims.contract_id, RESOURCE_CLAIM_MACHINE_CONTRACT_ID);
  assert.equal(resourceClaims.semantic_generation, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
  assert.equal(resourceClaims.claim_schema_version, RESOURCE_CLAIM_SCHEMA_VERSION);
  assert.equal(resourceClaims.meaning_change, true);

  const capability = resourceCapability();
  assert.equal(capability.contract_id, RESOURCE_CLAIM_MACHINE_CONTRACT_ID);
  assert.equal(capability.contract_version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
  assert.equal(capability.claim_schema_version, RESOURCE_CLAIM_SCHEMA_VERSION);
  assert.equal(capability.result_schema_version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
});

test("every advertised resource lifecycle command has a result mapping and resolves through help", async () => {
  const capability = resourceCapability();
  const commands = capability.commands;
  assert.ok(Array.isArray(commands));
  const mappings = capability.result_schemas;
  assert.ok(Array.isArray(mappings));

  const mappedCommands = mappings.flatMap((mapping) => {
    assert.ok(typeof mapping === "object" && mapping !== null && !Array.isArray(mapping));
    const commandList = (mapping as JsonRecord).commands;
    assert.ok(Array.isArray(commandList));
    return commandList as string[];
  });
  assert.deepEqual(new Set(mappedCommands), new Set(commands as string[]));

  for (const command of commands as string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli([...command.split(" "), "--help", "--json"], {
      io: {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    });
    assert.equal(exitCode, 0, `${command} help failed: ${stderr.join("\n")}`);
    assert.equal(stderr.length, 0);
    const result = JSON.parse(stdout[0] ?? "") as JsonRecord;
    assert.equal(result.ok, true);
    assert.equal(result.command, "help");
    assert.ok(typeof result.help_for === "string");
  }
});

test("representative public claim results conform to every advertised lifecycle schema", () => {
  const capability = resourceCapability();
  const claim = {
    schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
    claim_id: "claim-fixture",
    session_id: "0190f1e0-0000-7000-8000-000000000001",
    repository: "repo-fixture",
    worktree: "/tmp/worktree-fixture",
    resource: "src/a.ts",
    mode: "write",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  assertResultSchema(
    capability,
    "session claim",
    { session: {}, claims: [claim], added: [claim], released: [], idempotent: false, claim_set_generation: 1 },
    RESOURCE_CLAIM_SCHEMA_VERSION,
  );
  assertResultSchema(
    capability,
    "session update",
    { session: {}, claims: [claim], added: [claim], released: [], idempotent: false, claim_set_generation: 2 },
    RESOURCE_CLAIM_SCHEMA_VERSION,
  );
  assertResultSchema(
    capability,
    "session mutate",
    {
      session: {},
      claims: [claim],
      previous_claim_set_generation: 2,
      claim_set_generation: 3,
      added: [claim],
      changed: [],
      released: [],
      unchanged: [],
      idempotent: false,
    },
    RESOURCE_CLAIM_SCHEMA_VERSION,
  );
  assertResultSchema(
    capability,
    "session release",
    { session_id: claim.session_id, released: [claim], remaining: [], idempotent: false, claim_set_generation: 4 },
    RESOURCE_CLAIM_SCHEMA_VERSION,
  );
  assertResultSchema(
    capability,
    "session claims",
    { claims: [claim], claim_set_generation: 4 },
    RESOURCE_CLAIM_SCHEMA_VERSION,
  );
});

test("stale result-schema and failure-vocabulary fixtures fail deterministically", () => {
  const capability = resourceCapability();
  const mappings = capability.result_schemas as JsonRecord[];
  const staleMapping = { ...(mappings[0] as JsonRecord), version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION - 1 };
  assert.notEqual(staleMapping.version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
  assert.throws(
    () => assert.equal(staleMapping.version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION),
    /Expected values to be strictly equal/u,
  );

  const advertised = capability.failure_codes as string[];
  assertFailureVocabulary(advertised, RESOURCE_CLAIM_FAILURE_CODES);
  assert.throws(
    () =>
      assertFailureVocabulary(
        advertised.filter((code) => code !== "STALE_CLAIM_SET"),
        RESOURCE_CLAIM_FAILURE_CODES,
      ),
    /failure vocabulary drifted/u,
  );
  assert.throws(
    () => assertFailureVocabulary([...advertised, "UNEXPECTED_FIXTURE_FAILURE"], RESOURCE_CLAIM_FAILURE_CODES),
    /failure vocabulary drifted/u,
  );
});
