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
