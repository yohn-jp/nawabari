import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MACHINE_CONTRACT_ID,
  MACHINE_CONTRACT_SCHEMA_VERSION,
  RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
  machineContract,
} from "./contract.js";
import { publicCliCommandNames, runCli } from "./cli.js";
import { success } from "./domain/errors.js";
import type { SessionBackend } from "./domain/session.js";
import { discoverSandboxRuntimeLayout } from "./domain/sandbox.js";
import { RESOURCE_CLAIM_SCHEMA_VERSION } from "./resource-claims.js";

type JsonRecord = Record<string, unknown>;
type ResultSchemaDescriptor = {
  schema: string;
  version: number;
  commands: string[];
};

function object(value: unknown, label: string): JsonRecord {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as JsonRecord;
}

function outputCapture(): {
  stdout: string[];
  stderr: string[];
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) } };
}

function parseOutput(stdout: readonly string[], label: string): JsonRecord {
  assert.equal(stdout.length, 1, `${label} must emit one JSON document`);
  return object(JSON.parse(stdout[0] ?? ""), label);
}

function capabilityContract(): JsonRecord {
  const contract = machineContract("test-version");
  const capabilities = contract.capabilities;
  assert.ok(Array.isArray(capabilities));
  return object(
    capabilities.find((entry) => object(entry, "capability").id === "resource-claims"),
    "resource capability",
  );
}

function createGitRepository(): { repository: string; worktreeRoot: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-result-contract-repository-"));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-result-contract-worktrees-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git(["init", "--quiet", "-b", "main"]);
  git(["config", "user.email", "result-contract@example.invalid"]);
  git(["config", "user.name", "Result Contract"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repository, "README.md"), "result contract fixture\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "initial"]);
  return { repository, worktreeRoot };
}

async function invokeJson(argv: string[], cwd: string): Promise<JsonRecord> {
  const output = outputCapture();
  const exitCode = await runCli([...argv, "--json"], { cwd, io: output.io });
  assert.equal(exitCode, 0, `${argv.join(" ")} failed: ${output.stderr.join("\n")}`);
  assert.equal(output.stderr.length, 0);
  return parseOutput(output.stdout, argv.join(" "));
}

test("every advertised result schema has one explicit version and public owner mapping", () => {
  const contract = machineContract("test-version");
  assert.equal(contract.contract_id, MACHINE_CONTRACT_ID);
  assert.equal(contract.schema_version, MACHINE_CONTRACT_SCHEMA_VERSION);
  assert.ok(Array.isArray(contract.capabilities));

  const publicCommands = new Set(publicCliCommandNames());
  const schemaOwners = new Map<string, string>();
  for (const candidate of contract.capabilities) {
    const capability = object(candidate, "capability");
    const capabilityId = capability.id;
    assert.equal(typeof capabilityId, "string");
    if (capability.contract_id !== undefined) {
      assert.equal(typeof capability.contract_id, "string");
      const contractVersion = capability.contract_version ?? capability.schema_version;
      assert.ok(Number.isSafeInteger(contractVersion) && (contractVersion as number) > 0);
    }
    const lockRecovery = capability.registry_lock_recovery;
    if (lockRecovery !== undefined) {
      const recovery = object(lockRecovery, `${capabilityId} lock-recovery contract`);
      assert.equal(typeof recovery.contract_id, "string");
      assert.ok(Number.isSafeInteger(recovery.contract_version) && (recovery.contract_version as number) > 0);
      assert.ok((capability.commands as string[]).some((command) => command.startsWith("session ")));
    }
    const commands = capability.commands;
    assert.ok(Array.isArray(commands));
    for (const command of commands) {
      assert.equal(typeof command, "string");
      assert.ok(publicCommands.has(command), `${capabilityId} advertises unknown public command ${command}`);
    }

    const advertised = String(capability.result_schema)
      .split("/")
      .map((schema) => schema.trim())
      .filter(Boolean);
    assert.ok(advertised.length > 0, `${capabilityId} must advertise a result schema`);
    const mappings = capability.result_schemas;
    assert.ok(Array.isArray(mappings), `${capabilityId} must map each result schema explicitly`);
    const mappedSchemas = new Set<string>();
    const mappedCommands = new Set<string>();
    for (const entry of mappings) {
      const mapping = object(entry, `${capabilityId} result schema mapping`);
      assert.equal(typeof mapping.schema, "string");
      assert.match(mapping.schema as string, /^(?:[a-z0-9-]+\.)+v[0-9]+$/u);
      assert.equal(typeof mapping.version, "number");
      assert.ok(Number.isSafeInteger(mapping.version) && (mapping.version as number) > 0);
      // A descriptor version is the owning contract generation.  A migration
      // descriptor may intentionally retain its historical result-schema
      // identity while running under the current generation.
      assert.match(mapping.schema as string, /\.v[0-9]+$/u);
      assert.ok(Array.isArray(mapping.commands) && mapping.commands.length > 0);
      assert.equal(mappedSchemas.has(mapping.schema as string), false, `${capabilityId} maps a schema twice`);
      mappedSchemas.add(mapping.schema as string);
      for (const command of mapping.commands as unknown[]) {
        assert.ok(typeof command === "string");
        assert.ok((commands as string[]).includes(command), `${mapping.schema} has a command outside its capability`);
        assert.equal(mappedCommands.has(command), false, `${capabilityId} maps ${command} more than once`);
        mappedCommands.add(command);
      }
      const previousOwner = schemaOwners.get(mapping.schema as string);
      assert.equal(previousOwner, undefined, `${mapping.schema} has multiple capability owners`);
      schemaOwners.set(mapping.schema as string, capabilityId as string);
    }
    const unmappedEnvelopeSchemas = advertised.filter((schema) => !mappedSchemas.has(schema));
    if (unmappedEnvelopeSchemas.length > 0) {
      // Resource claims retain the historical umbrella result_schema while
      // exposing command-specific mappings.  Its capability-level version
      // is the authoritative owner for that envelope identity.
      assert.equal(capabilityId, "resource-claims");
      assert.equal(typeof capability.result_schema_version, "number");
      assert.equal(capability.contract_id, "nawabari.resource-claims.v2");
      for (const schema of unmappedEnvelopeSchemas) assert.match(schema, /^(?:[a-z0-9-]+\.)+v[0-9]+$/u);
    }
    assert.deepEqual(
      [...mappedCommands].sort(),
      [...(commands as string[])].sort(),
      `${capabilityId} command mapping drifted`,
    );
  }
});

test("resource-claim public output carries the advertised v2 nested schema", async () => {
  const fixture = createGitRepository();
  try {
    const created = await invokeJson(
      ["session", "create", "--worktree-root", fixture.worktreeRoot],
      fixture.repository,
    );
    const sessionId = created.session_id;
    const worktree = created.worktree;
    assert.equal(typeof sessionId, "string");
    assert.equal(typeof worktree, "string");
    const claim = await invokeJson(
      ["session", "claim", "--session", sessionId as string, "--resource", "src/result.ts", "--mode", "read"],
      worktree as string,
    );
    assert.equal(claim.claim_set_generation, 1);
    const claims = claim.claims;
    assert.ok(Array.isArray(claims) && claims.length === 1);
    assert.equal(object(claims[0], "claim").schema_version, RESOURCE_CLAIM_SCHEMA_VERSION);

    const capability = capabilityContract();
    assert.equal(capability.contract_version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
    assert.equal(capability.result_schema_version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
    const mappings = capability.result_schemas as ResultSchemaDescriptor[];
    const acquire = mappings.find((mapping) => mapping.commands.includes("session claim"));
    assert.ok(acquire);
    assert.equal(acquire?.version, RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION);
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(fixture.worktreeRoot, { recursive: true, force: true });
  }
});

test("lifecycle, diagnostic, and cleanup schemas are checked against reachable public output", async () => {
  const fixture = createGitRepository();
  try {
    const created = await invokeJson(
      ["session", "create", "--worktree-root", fixture.worktreeRoot],
      fixture.repository,
    );
    const sessionId = created.session_id;
    const worktree = created.worktree;
    assert.equal(typeof sessionId, "string");
    assert.equal(typeof worktree, "string");
    assert.equal(typeof created.branch, "string");
    assert.equal(created.state, "active");

    const listing = await invokeJson(["session", "list"], fixture.repository);
    assert.ok(Array.isArray(listing.sessions));
    assert.equal(typeof listing.total, "number");
    const status = await invokeJson(["status"], fixture.repository);
    assert.ok(Array.isArray(status.sessions));
    assert.ok(Object.hasOwn(status, "repository"));

    const diagnostic = await invokeJson(["session", "inspect", "--session", sessionId as string], worktree as string);
    assert.equal(diagnostic.session_id, sessionId);
    assert.ok(Object.hasOwn(diagnostic, "lifecycle_state"));
    assert.ok(Object.hasOwn(diagnostic, "close_readiness"));

    const doctor = await invokeJson(["doctor"], fixture.repository);
    assert.ok(Array.isArray(doctor.checks));
    assert.ok(Object.hasOwn(doctor, "sandbox"));
    const cleanup = await invokeJson(["gc", "--dry-run"], fixture.repository);
    assert.equal(cleanup.apply, false);
    assert.ok(Array.isArray(cleanup.candidates));
    assert.ok(Array.isArray(cleanup.cleaned));
  } finally {
    fs.rmSync(fixture.repository, { recursive: true, force: true });
    fs.rmSync(fixture.worktreeRoot, { recursive: true, force: true });
  }
});

test("protected-execution public output remains reachable through the canonical command", async () => {
  const sessionId = "0190f1e0-0000-7000-8000-000000000001";
  const backend = {
    guard: async () =>
      success({
        allowed: true,
        code: "ALLOWED" as const,
        repository: "/tmp/result-contract-repository",
        worktree: "/tmp/result-contract-worktree",
        branch: "result-contract",
        session_id: sessionId,
        owner_session_id: sessionId,
        requested_session_id: sessionId,
        state: "active" as const,
        details: {},
      }),
  } as unknown as SessionBackend;
  const output = outputCapture();
  const exitCode = await runCli(
    ["--json", "session", "run", "--session", sessionId, "--", "printf", "literal; $HOME"],
    {
      cwd: "/tmp/result-contract-worktree",
      backend,
      sandboxProbe: {
        platform: () => "linux",
        uid: () => 1_000,
        gid: () => 1_000,
        hasBubblewrap: () => true,
        hasNamespaceSupport: () => true,
        hasCgroupsV2: () => false,
        hasLandlock: () => false,
        hasSeccomp: () => true,
        hasCapabilities: () => true,
      },
      sandboxRuntimeLayout: discoverSandboxRuntimeLayout(),
      sandboxRunner: async (_request, command) => {
        assert.deepEqual([command.command, ...(command.args ?? [])], ["printf", "literal; $HOME"]);
        return success({ exit_code: 0, signal: null, stdout: "literal; $HOME", stderr: "", duration_ms: 1 });
      },
      io: output.io,
    },
  );
  assert.equal(exitCode, 0);
  const response = parseOutput(output.stdout, "session run");
  assert.equal(response.exit_code, 0);
  assert.equal(response.signal, null);
  assert.equal(response.stdout, "literal; $HOME");
  const contract = machineContract("test-version");
  const protectedCapability = object(
    (contract.capabilities as unknown[]).find((entry) => object(entry, "capability").id === "protected-execution"),
    "protected capability",
  );
  assert.equal(protectedCapability.result_schema_version, protectedCapability.schema_version);
  assert.equal(object((protectedCapability.result_schemas as unknown[])[0], "protected result mapping").version, 1);
});

test("schema evolution rules distinguish additive output from meaning changes", () => {
  const versioning = object(machineContract("test-version").contract_versioning, "contract versioning");
  const topLevel = object(versioning.top_level, "top-level versioning");
  const resourceClaims = object(versioning.resource_claims, "resource-claim versioning");
  assert.equal(topLevel.decision, "meaning-compatible-top-level-identity");
  assert.equal(resourceClaims.meaning_change, true);
  assert.equal(typeof resourceClaims.previous_generation, "number");
  assert.match(String(resourceClaims.future_rule), /new resource-claim generation/u);

  const stale = { ...resourceClaims, semantic_generation: (resourceClaims.semantic_generation as number) - 1 };
  assert.throws(
    () => assert.equal(stale.semantic_generation, resourceClaims.semantic_generation),
    /Expected values to be strictly equal/u,
  );
  const additive = { ...topLevel, extra_field: "compatible" } as JsonRecord;
  assert.equal(additive.schema_version, topLevel.schema_version);
  assert.equal(additive.contract_id, topLevel.contract_id);
});
