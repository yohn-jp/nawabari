import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  machineContract,
  MACHINE_CONTRACT_ID,
  nawabariMachineContract,
  nawabariVerificationContract,
  nawabariWorkingSetContract,
} from "./public-contract.js";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as { version: string };

const FORBIDDEN_XSTATE_SURFACE = /\b(?:ActorRef|Snapshot|StateValue|createActor|createMachine)\b/u;

test("public-contract module never exports raw XState runtime objects", () => {
  const source = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./public-contract.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, FORBIDDEN_XSTATE_SURFACE);
});

test("nawabariMachineContract() defaults to the installed package's own version", () => {
  const contract = nawabariMachineContract();
  assert.equal(contract.contract_id, MACHINE_CONTRACT_ID);
  assert.equal(contract.package_version, packageJson.version);
  assert.deepEqual(contract, machineContract(packageJson.version));
});

test("nawabariMachineContract(version) still describes an explicit generation", () => {
  const contract = nawabariMachineContract("explicit-test-version");
  assert.equal(contract.package_version, "explicit-test-version");
});

test("public contract exposes the product-neutral working-set capability", () => {
  const contract = nawabariWorkingSetContract();
  assert.equal(contract.contract_id, "effective-working-set");
  assert.equal(contract.contract_version, 1);
  assert.deepEqual(contract.artifact_kinds, [
    "implementation-execution-scope",
    "candidate-working-set",
    "effective-working-set",
  ]);
  assert.equal(contract.resource_claims_separate, true);
});

test("public contract exposes isolated verification authority", () => {
  const contract = nawabariVerificationContract();
  assert.equal(contract.contract_id, "nawabari.verification-profile.v1");
  assert.equal(contract.contract_version, 1);
  assert.deepEqual(contract.read_visibility, ["declared", "repository"]);
  assert.equal(contract.write_policy, "deny");
  assert.equal(contract.execution, "fixed-argv-no-shell");
  assert.equal(contract.mutates_working_set, false);
});
