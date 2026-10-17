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
  assert.equal(contract.result_schema, "verification-result.v1");
  assert.equal(contract.source_bound_result_schema, "verification-result.v2");
  assert.equal(contract.source_bound_result_contract_id, "nawabari.verification-result.v2");
  assert.equal(contract.source_witness_contract_id, "nawabari.verification-source-witness.v1");
  assert.equal(contract.source_bound_evidence_contract_id, "nawabari.verification-execution-evidence.v2");
  assert.equal(contract.session_snapshot_contract_id, "nawabari.session-verification-snapshot.v1");
  assert.equal(contract.session_snapshot_schema_version, 1);
  assert.equal(contract.session_bound_execution_contract_id, "nawabari.session-bound-verification.v1");
  assert.equal(contract.session_bound_execution_schema_version, 1);
  assert.equal(contract.session_bound_execution_result_schema, "nawabari.session-bound-verification.v1");
  assert.deepEqual(contract.session_bound_operations, [
    "snapshot",
    "execute",
    "candidate-paths",
    "stage-candidate",
    "release-candidate",
  ]);
  assert.equal(contract.candidate_bundle_contract_id, "nawabari.session-candidate-bundle.v1");
  assert.equal(contract.candidate_bundle_schema_version, 1);
  assert.equal(contract.candidate_bundle_result_schema, "nawabari.session-candidate-bundle.v1");
  assert.equal(contract.candidate_bundle_paths_contract_id, "nawabari.session-candidate-bundle-paths.v1");
  assert.equal(contract.candidate_bundle_paths_result_schema, "nawabari.session-candidate-bundle-paths.v1");
  assert.equal(contract.candidate_bundle_release_contract_id, "nawabari.session-candidate-bundle-release.v1");
  assert.equal(contract.candidate_bundle_release_result_schema, "nawabari.session-candidate-bundle-release.v1");
  assert.equal(contract.candidate_bundle_path_operation, "candidate-paths");
  assert.equal(contract.candidate_bundle_max_bytes, 64 * 1024 * 1024);
  assert.deepEqual(contract.candidate_release, {
    requires_exact_snapshot: true,
    admission: "closed-during-owned-empty-drain-and-release",
    finalization: "existing-session-close-drain-authority",
    removes_only: "clean-deterministic-candidate-source-subtree",
    rejects_dirty_or_unexpected_recoverable_data: true,
  });
  assert.deepEqual(contract.candidate_staging, {
    mutates_agent_working_set: false,
    owner_operation_scratch: "deterministic-candidate-source-subtree-under-owned-session-worktree",
    stage_write_policy: "owner-operation-only",
    verifier_read_visibility: "invocation-local",
    verifier_write_policy: "deny",
  });
  assert.equal(contract.legacy_result_freshness, "unproven");
  assert.deepEqual(contract.read_visibility, ["declared", "repository"]);
  assert.equal(contract.write_policy, "deny");
  assert.equal(contract.execution, "fixed-argv-no-shell");
  assert.equal(contract.filesystem_boundary, "owner-operation-bounded-scratch-and-invocation-local-read-only-verifier");
  assert.equal(contract.enforcement, "strict-protected-execution-landlock");
  assert.equal(contract.mutates_working_set, false);
});
