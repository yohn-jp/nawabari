/**
 * Stable, transport-neutral package boundary for Nawabari machine-contract
 * discovery (#257; see docs/architecture/xstate-state-architecture.md,
 * "Public library boundary").
 *
 * This module lets a cross-product caller discover the installed package's
 * versioned capability inventory, result-schema mappings, failure-code
 * vocabulary, and public session-lifecycle projection (#256) without
 * spawning the CLI's `capabilities --json` command and parsing its output.
 * It is a thin, version-defaulted wrapper over the existing `contract.ts`
 * projection; it introduces no independent contract authority.
 */

import { createRequire } from "node:module";

import type { JsonObject } from "./domain/errors.js";
import {
  machineContract,
  MACHINE_CONTRACT_ID,
  MACHINE_CONTRACT_SCHEMA_VERSION,
  REGISTRY_LOCK_RECOVERY_CONTRACT_ID,
  REGISTRY_LOCK_RECOVERY_CONTRACT_VERSION,
  RESOURCE_CLAIM_MACHINE_CONTRACT_ID,
  RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
  RESOURCE_CLAIM_RECOVERY_SCHEMA,
  RESOURCE_CLAIM_RESULT_SCHEMA,
  RESOURCE_CLAIM_TRANSITION_MATRIX_ID,
} from "./contract.js";
import {
  SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID,
  SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA,
  SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA_VERSION,
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_PROFILE_SCHEMA_VERSION,
  VERIFICATION_RESULT_SCHEMA_VERSION,
  VERIFICATION_RESULT_SCHEMA,
  VERIFICATION_SOURCE_WITNESS_CONTRACT_ID,
  VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION,
} from "./verification-executor.js";
import {
  SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
  SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
} from "./domain/filesystem-policy-evidence.js";
import {
  SESSION_BOUND_VERIFICATION_CONTRACT_ID,
  SESSION_BOUND_VERIFICATION_RESULT_SCHEMA,
  SESSION_BOUND_VERIFICATION_SCHEMA_VERSION,
  executeSessionBoundVerification,
  getSessionVerificationSnapshot,
} from "./session-bound-verification.js";
import {
  SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID,
  SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION,
} from "./domain/session.js";
import {
  SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
  SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID,
  SESSION_CANDIDATE_BUNDLE_PATHS_RESULT_SCHEMA,
  SESSION_CANDIDATE_BUNDLE_RESULT_SCHEMA,
  SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
  MAX_SESSION_CANDIDATE_BUNDLE_BYTES,
  sessionCandidateBundleTransferPath,
  sessionCandidateBundleStagingRootPath,
  describeSessionCandidateBundlePaths,
  stageSessionCandidateBundle,
} from "./session-candidate-bundle.js";

export {
  SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
  SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID,
  SESSION_CANDIDATE_BUNDLE_PATHS_RESULT_SCHEMA,
  SESSION_CANDIDATE_BUNDLE_RESULT_SCHEMA,
  SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
  MAX_SESSION_CANDIDATE_BUNDLE_BYTES,
  sessionCandidateBundleTransferPath,
  sessionCandidateBundleStagingRootPath,
  describeSessionCandidateBundlePaths,
  stageSessionCandidateBundle,
};
export type {
  SessionCandidateBundleRequest,
  SessionCandidateBundleSource,
  SessionCandidateBundlePathsResult,
  SessionCandidateBundleStageResult,
} from "./session-candidate-bundle.js";

export {
  SESSION_BOUND_VERIFICATION_CONTRACT_ID,
  SESSION_BOUND_VERIFICATION_RESULT_SCHEMA,
  SESSION_BOUND_VERIFICATION_SCHEMA_VERSION,
  executeSessionBoundVerification,
  getSessionVerificationSnapshot,
};
export type {
  ManagedVerificationExecution,
  SessionBoundVerificationDependencies,
  SessionBoundVerificationRequest,
  SessionBoundVerificationResult,
  SessionBoundVerificationSource,
} from "./session-bound-verification.js";

export {
  captureVerificationSourceWitness,
  executeVerification,
  executeSourceBoundVerification,
  isVerificationSourceWitnessCurrent,
  runVerification,
  validateVerificationProfile,
  validateVerificationSourceWitness,
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_PROFILE_SCHEMA_VERSION,
  VERIFICATION_RESULT_SCHEMA,
  VERIFICATION_RESULT_SCHEMA_VERSION,
  SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID,
  SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA,
  SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA_VERSION,
  VERIFICATION_SOURCE_WITNESS_CONTRACT_ID,
  VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION,
} from "./verification-executor.js";
export type {
  SourceBoundVerificationResult,
  VerificationDiagnosticStream,
  VerificationExecutorDependencies,
  VerificationFilesystemPolicyFence,
  VerificationProfile,
  VerificationProfileInput,
  VerificationReadVisibility,
  VerificationResult,
  VerificationSourceWitness,
} from "./verification-executor.js";
export {
  SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
  SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
  serializeSourceBoundVerificationExecutionEvidence,
} from "./domain/filesystem-policy-evidence.js";
export type { SourceBoundVerificationExecutionEvidence } from "./domain/filesystem-policy-evidence.js";

/** Stable identity of Nawabari's bounded Effective Working Set capability. */
export const EFFECTIVE_WORKING_SET_CONTRACT_ID = "effective-working-set" as const;
export const EFFECTIVE_WORKING_SET_CONTRACT_VERSION = 1 as const;
export const EFFECTIVE_WORKING_SET_RESULT_SCHEMA = "effective-working-set.v1" as const;

export {
  machineContract,
  MACHINE_CONTRACT_ID,
  MACHINE_CONTRACT_SCHEMA_VERSION,
  REGISTRY_LOCK_RECOVERY_CONTRACT_ID,
  REGISTRY_LOCK_RECOVERY_CONTRACT_VERSION,
  RESOURCE_CLAIM_MACHINE_CONTRACT_ID,
  RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
  RESOURCE_CLAIM_RECOVERY_SCHEMA,
  RESOURCE_CLAIM_RESULT_SCHEMA,
  RESOURCE_CLAIM_TRANSITION_MATRIX_ID,
};

/** Schema generation for this public contract-discovery API module itself. */
export const NAWABARI_CONTRACT_API_SCHEMA_VERSION = 1 as const;

const installedPackageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * Discover the installed Nawabari package's machine contract: capability
 * inventory, result-schema mappings, failure-code vocabulary, and the
 * XState-derived public session-lifecycle projection. Defaults to the
 * installed package's own version; pass an explicit version only to
 * describe a different generation of this same contract shape.
 */
export function nawabariMachineContract(packageVersion: string = installedPackageMetadata.version): JsonObject {
  return machineContract(packageVersion);
}

/**
 * Public, product-neutral discovery for the additive working-set contract.
 * The executable machine contract remains owned by `contract.ts`; this
 * descriptor only advertises the consumer boundary and its artifact kinds.
 */
export function nawabariWorkingSetContract(): JsonObject {
  return {
    contract_id: EFFECTIVE_WORKING_SET_CONTRACT_ID,
    contract_version: EFFECTIVE_WORKING_SET_CONTRACT_VERSION,
    result_schema: EFFECTIVE_WORKING_SET_RESULT_SCHEMA,
    artifact_kinds: ["implementation-execution-scope", "candidate-working-set", "effective-working-set"],
    operations: ["READONLY", "WRITE", "CREATE", "DELETE", "DENY"],
    fail_closed: true,
    resource_claims_separate: true,
  };
}

/**
 * Public discovery for the isolated verification authority. The executor is
 * transport-neutral; interactive session execution and working-set state
 * remain separate authorities.
 */
export function nawabariVerificationContract(): JsonObject {
  return {
    contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
    contract_version: VERIFICATION_PROFILE_SCHEMA_VERSION,
    result_schema: VERIFICATION_RESULT_SCHEMA,
    source_bound_result_schema: SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA,
    source_bound_result_contract_id: SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID,
    source_witness_contract_id: VERIFICATION_SOURCE_WITNESS_CONTRACT_ID,
    source_witness_schema_version: VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION,
    source_bound_evidence_contract_id: SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
    source_bound_evidence_schema_version: SOURCE_BOUND_VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
    session_snapshot_contract_id: SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID,
    session_snapshot_schema_version: SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION,
    session_bound_execution_contract_id: SESSION_BOUND_VERIFICATION_CONTRACT_ID,
    session_bound_execution_schema_version: SESSION_BOUND_VERIFICATION_SCHEMA_VERSION,
    session_bound_execution_result_schema: SESSION_BOUND_VERIFICATION_RESULT_SCHEMA,
    session_bound_operations: ["snapshot", "execute", "candidate-paths", "stage-candidate"],
    candidate_bundle_contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    candidate_bundle_schema_version: SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
    candidate_bundle_result_schema: SESSION_CANDIDATE_BUNDLE_RESULT_SCHEMA,
    candidate_bundle_paths_contract_id: SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID,
    candidate_bundle_paths_result_schema: SESSION_CANDIDATE_BUNDLE_PATHS_RESULT_SCHEMA,
    candidate_bundle_max_bytes: MAX_SESSION_CANDIDATE_BUNDLE_BYTES,
    candidate_bundle_path_operation: "candidate-paths",
    candidate_staging: {
      mutates_agent_working_set: false,
      owner_operation_scratch: "deterministic-candidate-source-subtree-under-owned-session-worktree",
      stage_write_policy: "owner-operation-only",
      verifier_read_visibility: "invocation-local",
      verifier_write_policy: "deny",
    },
    legacy_result_freshness: "unproven",
    read_visibility: ["declared", "repository"],
    write_policy: "deny",
    execution: "fixed-argv-no-shell",
    filesystem_boundary: "owner-operation-bounded-scratch-and-invocation-local-read-only-verifier",
    enforcement: "strict-protected-execution-landlock",
    bounded_diagnostics: true,
    mutates_working_set: false,
    mutates_session_registry: false,
  };
}
