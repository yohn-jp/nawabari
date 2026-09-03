import type { JsonObject, JsonValue } from "./domain/errors.js";
import { IMPLEMENTATION_FAILURE_CODE_VOCABULARY } from "./failure-code-vocabulary.js";
import { OPERATION_AUTHORIZATION_POLICY, OPERATION_VOCABULARY } from "./operation-authorization.js";
import {
  RESOURCE_CLAIM_COMPATIBILITY_MATRIX,
  RESOURCE_CLAIM_MODES,
  RESOURCE_CLAIM_RECOVERY_ACTION_ID,
  RESOURCE_CLAIM_SCHEMA_VERSION,
  RESOURCE_CLAIM_TRANSITION_MATRIX,
  RESOURCE_CLAIM_TRANSITION_MODES,
  RESOURCE_CLAIM_TRANSITIONS,
  LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION,
} from "./resource-claims.js";
import {
  SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  SESSION_LIFECYCLE_TRANSITION_TABLE,
} from "./session-lifecycle-classification.js";
import {
  SANDBOX_CONTRACT_ID,
  SANDBOX_CONTRACT_SCHEMA_VERSION,
  SANDBOX_OPTIONAL_CAPABILITIES,
  SANDBOX_REQUIRED_CAPABILITIES,
} from "./domain/sandbox.js";

/** Stable discovery identifier for the standalone local execution contract. */
export const MACHINE_CONTRACT_ID = "nawabari.standalone-execution.v1" as const;
export const MACHINE_CONTRACT_SCHEMA_VERSION = 1 as const;

/**
 * Resource-claim semantics changed when schema v2 became authoritative.  The
 * standalone envelope remains meaning-compatible, so the child capability
 * carries the semantic generation callers must inspect before claiming.
 */
export const RESOURCE_CLAIM_MACHINE_CONTRACT_ID = "nawabari.resource-claims.v2" as const;
export const RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION = 2 as const;
export const RESOURCE_CLAIM_RESULT_SCHEMA = "resource-claim.v2" as const;
export const RESOURCE_CLAIM_TRANSITION_MATRIX_ID = "resource-claim-transition-matrix.v1" as const;
export const RESOURCE_CLAIM_RECOVERY_SCHEMA = "resource-claim-recovery.v1" as const;

/**
 * Registry-lock recovery has a separate public platform contract because a
 * package can run on more platforms than it can safely reclaim stale locks.
 */
export const REGISTRY_LOCK_RECOVERY_CONTRACT_ID = "nawabari.registry-lock-recovery.v1" as const;
export const REGISTRY_LOCK_RECOVERY_CONTRACT_VERSION = 1 as const;

/** Public discovery projection of the authoritative protected-execution contract. */
const PROTECTED_EXECUTION_CAPABILITY = Object.freeze({
  id: "protected-execution",
  contract_id: SANDBOX_CONTRACT_ID,
  schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
  commands: ["session run", "session exec"],
  command_aliases: [{ alias: "session exec", canonical: "session run" }],
  result_schema: "sandbox-execution.v1",
  result_schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
  result_schemas: [
    {
      schema: "sandbox-execution.v1",
      version: SANDBOX_CONTRACT_SCHEMA_VERSION,
      commands: ["session run", "session exec"],
    },
  ],
  identities: ["session_id", "repository", "worktree", "branch", "network_mode"],
  required_capabilities: SANDBOX_REQUIRED_CAPABILITIES,
  optional_capabilities: SANDBOX_OPTIONAL_CAPABILITIES,
  network_mode: "inherited",
  fail_closed: true,
  ambient_fallback: false,
  readiness: {
    command: "doctor",
    report_field: "sandbox",
    authority: "sandboxDoctorReport",
    fields: ["platform", "platform_supported", "capabilities", "ready", "missing_required", "network_mode"],
  },
  failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["protected-execution"],
  failure_code_policy: {
    source: "implementation-owned protected-execution vocabulary",
    missing_or_extra: "deterministic conformance failure",
    internal_exceptions: [],
  },
});

/** Public lifecycle names are projections of the existing dispatcher/help identities. */
const RESOURCE_CLAIM_COMMANDS = Object.freeze([
  "session claim",
  "resource claim",
  "session update",
  "resource update",
  "session mutate",
  "resource mutate",
  "session transition",
  "resource transition",
  "session claims",
  "resource list",
  "resource claims",
  "session release",
  "resource release",
  "migrate",
] as const);

const RESOURCE_CLAIM_COMMAND_ALIASES = Object.freeze([
  { alias: "resource claim", canonical: "session claim" },
  { alias: "resource update", canonical: "session update" },
  { alias: "resource mutate", canonical: "session mutate" },
  { alias: "resource transition", canonical: "session transition" },
  { alias: "resource list", canonical: "session claims" },
  { alias: "resource claims", canonical: "session claims" },
  { alias: "resource release", canonical: "session release" },
] as const);

const RESOURCE_CLAIM_RESULT_MAPPINGS = Object.freeze([
  {
    schema: "resource-claim.acquire.v2",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["session claim", "resource claim"],
    required: ["session", "claims", "added", "released", "idempotent", "claim_set_generation"],
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
  },
  {
    schema: "resource-claim.replacement.v2",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["session update", "resource update"],
    required: ["session", "claims", "added", "released", "idempotent", "claim_set_generation"],
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
  },
  {
    schema: "resource-claim.delta.v2",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["session mutate", "resource mutate", "session transition", "resource transition"],
    required: [
      "session",
      "claims",
      "previous_claim_set_generation",
      "claim_set_generation",
      "added",
      "changed",
      "released",
      "unchanged",
      "idempotent",
    ],
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
  },
  {
    schema: "resource-claim.release.v2",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["session release", "resource release"],
    required: ["session_id", "released", "remaining", "idempotent", "claim_set_generation"],
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
  },
  {
    schema: "resource-claim.snapshot.v2",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["session claims", "resource list", "resource claims"],
    required: ["claims", "claim_set_generation"],
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
  },
  {
    schema: "resource-claim.migration.v1",
    version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    commands: ["migrate"],
    required: ["migrated", "registry_schema_version", "claim_schema_version"],
    source_claim_schema_version: LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION,
    target_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
    nested_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
    atomic: true,
    idempotent_retry: true,
    fail_closed: true,
  },
] as const);

function jsonMatrix(): JsonObject {
  return Object.fromEntries(
    RESOURCE_CLAIM_TRANSITION_MODES.map((source) => [
      source,
      RESOURCE_CLAIM_TRANSITION_MODES.map((target) => RESOURCE_CLAIM_TRANSITION_MATRIX[source][target]).join(","),
    ]),
  ) as JsonObject;
}

function jsonCompatibilityMatrix(): JsonObject {
  return Object.fromEntries(
    RESOURCE_CLAIM_MODES.map((source) => [
      source,
      RESOURCE_CLAIM_MODES.map((target) => RESOURCE_CLAIM_COMPATIBILITY_MATRIX[source][target]).join(","),
    ]),
  ) as JsonObject;
}

function operationRequiredModes(): JsonObject {
  return Object.fromEntries(
    OPERATION_VOCABULARY.map((operation) => {
      const policy = OPERATION_AUTHORIZATION_POLICY[operation];
      return [
        operation,
        {
          required_access: policy.requiredAccess,
          isolation_rationale: policy.isolationRationale,
          authority_rationale: "OPERATION_AUTHORIZATION_POLICY",
          enforcement: policy.enforcement,
        },
      ];
    }),
  ) as JsonObject;
}

function jsonClone(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

const MACHINE_CONTRACT_CAPABILITIES = Object.freeze([
  PROTECTED_EXECUTION_CAPABILITY,
  {
    id: "session-lifecycle",
    commands: ["session create", "session id", "session show", "session list", "status", "session close"],
    result_schema: "session.v1",
    result_schema_version: 1,
    result_schemas: [
      {
        schema: "session.v1",
        version: 1,
        commands: ["session create", "session id", "session show", "session list", "status", "session close"],
      },
    ],
    identities: ["session_id", "repository", "worktree", "branch", "state"],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["session-lifecycle"],
    failure_code_policy: {
      source: "implementation-owned session-lifecycle vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
    registry_lock_recovery: {
      contract_id: REGISTRY_LOCK_RECOVERY_CONTRACT_ID,
      contract_version: REGISTRY_LOCK_RECOVERY_CONTRACT_VERSION,
      supported_platforms: ["linux"],
      unsupported_platforms: "non-linux",
      owner_identity: ["hostname", "pid", "processStartTime"],
      process_generation_provider: "linux:/proc/<pid>/stat:starttime",
      stale_recovery: {
        live_owner: "never-reclaim-by-age",
        unknown_or_remote_owner: "fail-closed",
        pid_only_identity: "not-sufficient",
        unsupported_platform: "LOCK_STALE; deliberate operator remediation required",
      },
    },
  },
  {
    id: "session-discard",
    commands: ["session discard"],
    result_schema: "session-discard.v1",
    result_schema_version: 1,
    result_schemas: [{ schema: "session-discard.v1", version: 1, commands: ["session discard"] }],
    identities: [
      "session_id",
      "previous_head",
      "worktree_path",
      "branch_name",
      "worktree_removed",
      "branch_removed",
      "released_claims",
      "released_claim_count",
      "final_state",
      "final_session_state",
      "idempotent",
    ],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["session-discard"],
    failure_code_policy: {
      source: "implementation-owned session-discard vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
  {
    id: "session-diagnostics",
    commands: ["session inspect"],
    result_schema: "session-diagnostic.v1",
    result_schema_version: 1,
    result_schemas: [{ schema: "session-diagnostic.v1", version: 1, commands: ["session inspect"] }],
    identities: [
      "session_id",
      "repository",
      "worktree",
      "branch",
      "state",
      "physical_state",
      "close_readiness",
      "cleanup_readiness",
      "result_state",
      "blockers",
      "safe_actions",
      "integration_evidence",
      "lifecycle_state",
      "lifecycle",
      "garbage_collection",
    ],
    lifecycle: {
      schema_version: SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION,
      states: [...SESSION_LIFECYCLE_STATES],
      transition_table: SESSION_LIFECYCLE_TRANSITION_TABLE,
      authority: "local-session-registry-observation",
      age_rule: "elapsed-age-is-diagnostic-only",
    },
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["session-diagnostics"],
    failure_code_policy: {
      source: "implementation-owned session-diagnostics vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
  {
    id: "resource-claims",
    contract_id: RESOURCE_CLAIM_MACHINE_CONTRACT_ID,
    contract_version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
    commands: RESOURCE_CLAIM_COMMANDS,
    command_aliases: RESOURCE_CLAIM_COMMAND_ALIASES,
    result_schema: RESOURCE_CLAIM_RESULT_SCHEMA,
    result_schema_version: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
    result_schemas: RESOURCE_CLAIM_RESULT_MAPPINGS,
    identities: [
      "claim_id",
      "session_id",
      "repository",
      "worktree",
      "resource",
      "mode",
      "created_at",
      "updated_at",
      "claim_set_generation",
      "previous_claim_set_generation",
      "migrated",
      "registry_schema_version",
      "claim_schema_version",
    ],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["resource-claims"],
    failure_code_policy: {
      source: "implementation-owned resource-claim lifecycle vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
    transition_matrix: {
      id: RESOURCE_CLAIM_TRANSITION_MATRIX_ID,
      version: 1,
      modes: [...RESOURCE_CLAIM_TRANSITION_MODES],
      transitions: [...RESOURCE_CLAIM_TRANSITIONS],
      matrix: jsonMatrix(),
      semantics: {
        acquire: "none -> read|write|exclusive-write",
        change: "read|write|exclusive-write -> a different mode",
        release: "read|write|exclusive-write -> none",
        no_op: "none -> none or a mode -> the same mode",
      },
    },
    compatibility: {
      overlap_matrix_id: "resource-claim-compatibility-matrix.v1",
      matrix: jsonCompatibilityMatrix(),
      non_overlapping_claims: "compatible",
    },
    mutation: {
      atomic: true,
      rejected_non_mutation: true,
      one_locked_transaction: true,
      claim_set_generation: {
        field: "claim_set_generation",
        monotonic_material_changes: true,
        no_op_unchanged: true,
        cas_option: "--if-generation",
        stale_failure: "STALE_CLAIM_SET",
      },
      force: {
        option: "--force",
        explicit_intent_required: true,
        mutually_exclusive_with: "--if-generation",
      },
    },
    semantics: {
      additive_claim: {
        commands: ["session claim", "resource claim"],
        additive: true,
        complete_replacement: false,
        contradictory_claim: "CONTRADICTORY_CLAIM",
      },
      complete_replacement: {
        commands: ["session update", "resource update"],
        atomic: true,
        semantics: "complete desired set; omission releases",
      },
      delta: {
        commands: ["session mutate", "resource mutate"],
        exact_resource_only: true,
        atomic: true,
      },
      transition: {
        commands: ["session transition", "resource transition"],
        exact_resource_only: true,
        unrelated_claims_preserved: true,
      },
      release: {
        commands: ["session release", "resource release"],
        selectors: ["--resource", "--claim-id", "--all"],
        exactly_one_selector_family: true,
        explicit_all: "--all",
        selected_preserves_unrelated: true,
        absent_exact_resource: "idempotent",
      },
    },
    recovery: {
      schema: RESOURCE_CLAIM_RECOVERY_SCHEMA,
      action_id: RESOURCE_CLAIM_RECOVERY_ACTION_ID,
      source_failure: "CONTRADICTORY_CLAIM",
      command: "session transition",
      exact_resource_only: true,
      includes: ["actionId", "command", "resource", "mode", "claimSetGeneration"],
      deterministic: true,
      cas_generation: "claimSetGeneration",
      ambiguous_overlaps: "no action",
    },
    operation_required_claim_modes: operationRequiredModes(),
  },
  {
    id: "authorization-and-evidence",
    commands: ["guard", "authorize", "checkpoint"],
    result_schema: "decision.v1 / evidence.v1",
    result_schema_version: 1,
    result_schemas: [
      { schema: "decision.v1", version: 1, commands: ["guard", "authorize"] },
      { schema: "evidence.v1", version: 1, commands: ["checkpoint"] },
    ],
    identities: ["operation", "allowed", "code", "claim_ids", "head", "in_claim", "out_of_claim"],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["authorization-and-evidence"],
    failure_code_policy: {
      source: "implementation-owned authorization-and-evidence vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
  {
    id: "repository-evidence",
    commands: ["evidence snapshot", "diff"],
    result_schema: "repository-evidence.v1 / diff.v1",
    result_schema_version: 1,
    result_schemas: [
      { schema: "repository-evidence.v1", version: 1, commands: ["evidence snapshot"] },
      { schema: "diff.v1", version: 1, commands: ["diff"] },
    ],
    identities: [
      "session_id",
      "repository",
      "worktree",
      "branch_id",
      "branch",
      "session_state",
      "base_revision",
      "head",
      "evidence_hash",
    ],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["repository-evidence"],
    failure_code_policy: {
      source: "implementation-owned repository-evidence vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
  {
    id: "governed-git-mutation",
    commands: ["commit", "push"],
    result_schema: "commit.v1 / push.v1",
    result_schema_version: 1,
    result_schemas: [
      { schema: "commit.v1", version: 1, commands: ["commit"] },
      { schema: "push.v1", version: 1, commands: ["push"] },
    ],
    identities: [
      "commit_sha",
      "reconciliation",
      "source_sha",
      "remote",
      "branch",
      "target",
      "target_ref",
      "observed_remote_sha",
      "relation",
    ],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["governed-git-mutation"],
    failure_code_policy: {
      source: "implementation-owned governed-git-mutation vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
  {
    id: "reconciliation-and-cleanup",
    commands: ["doctor", "gc"],
    result_schema: "reconciliation.v1 / cleanup.v1",
    result_schema_version: 1,
    result_schemas: [
      { schema: "reconciliation.v1", version: 1, commands: ["doctor"] },
      { schema: "cleanup.v1", version: 1, commands: ["gc"] },
    ],
    identities: [
      "clean",
      "issues",
      "candidates",
      "eligible",
      "cleaned",
      "blocked",
      "recovery_hints",
      "suspicion",
      "destructive_eligibility",
      "lifecycle_state",
    ],
    failure_codes: IMPLEMENTATION_FAILURE_CODE_VOCABULARY["reconciliation-and-cleanup"],
    failure_code_policy: {
      source: "implementation-owned reconciliation-and-cleanup vocabulary",
      missing_or_extra: "deterministic conformance failure",
      internal_exceptions: [],
    },
  },
] as const);

/**
 * Return a JSON-safe description of the installed machine contract.
 * Discovery intentionally has no repository or network precondition.
 */
export function machineContract(packageVersion: string): JsonObject {
  return {
    schema_version: MACHINE_CONTRACT_SCHEMA_VERSION,
    contract_id: MACHINE_CONTRACT_ID,
    capability_id: MACHINE_CONTRACT_ID,
    package: "nawabari",
    package_version: packageVersion,
    contract_versioning: {
      top_level: {
        contract_id: MACHINE_CONTRACT_ID,
        schema_version: MACHINE_CONTRACT_SCHEMA_VERSION,
        decision: "meaning-compatible-top-level-identity",
        rationale: "Resource-claim semantics are versioned by their child capability; the JSON envelope is unchanged.",
      },
      resource_claims: {
        contract_id: RESOURCE_CLAIM_MACHINE_CONTRACT_ID,
        semantic_generation: RESOURCE_CLAIM_MACHINE_CONTRACT_VERSION,
        claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
        previous_generation: 1,
        meaning_change: true,
        future_rule: "Meaning-changing claim semantics require a new resource-claim generation and identity.",
      },
    },
    capabilities: MACHINE_CONTRACT_CAPABILITIES.map((capability) => ({
      id: capability.id,
      commands: [...capability.commands],
      result_schema: capability.result_schema,
      ...(capability.id !== "resource-claims"
        ? {
            result_schema_version: capability.result_schema_version,
            result_schemas: jsonClone(capability.result_schemas),
          }
        : {}),
      identities: [...capability.identities],
      failure_codes: [...capability.failure_codes],
      failure_code_policy: jsonClone(capability.failure_code_policy),
      ...(capability.id === "resource-claims"
        ? {
            contract_id: capability.contract_id,
            contract_version: capability.contract_version,
            claim_schema_version: capability.claim_schema_version,
            result_schema_version: capability.result_schema_version,
            command_aliases: jsonClone(capability.command_aliases),
            result_schemas: jsonClone(capability.result_schemas),
            failure_code_policy: jsonClone(capability.failure_code_policy),
            transition_matrix: jsonClone(capability.transition_matrix),
            compatibility: jsonClone(capability.compatibility),
            mutation: jsonClone(capability.mutation),
            semantics: jsonClone(capability.semantics),
            recovery: jsonClone(capability.recovery),
            operation_required_claim_modes: capability.operation_required_claim_modes,
            help_dispatcher: {
              commands: [...capability.commands],
              identity_rule: "each command and alias resolves to an existing dispatcher and help identity",
            },
            claim_set_replacement: {
              commands: ["session update", "resource update"],
              atomic: true,
              pairing: "adjacent-resource-mode",
              idempotent_retry: true,
              unchanged_on_rejection: true,
            },
            migration: {
              command: "migrate",
              source_claim_schema_version: LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION,
              target_claim_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
              result_schema: "resource-claim.migration.v1",
              atomic: true,
              idempotent_retry: true,
              fail_closed: true,
            },
          }
        : {}),
      ...(capability.id === "session-lifecycle"
        ? { registry_lock_recovery: jsonClone(capability.registry_lock_recovery) }
        : {}),
      ...(capability.id === "protected-execution"
        ? {
            contract_id: capability.contract_id,
            schema_version: capability.schema_version,
            command_aliases: jsonClone(capability.command_aliases),
            required_capabilities: [...capability.required_capabilities],
            optional_capabilities: [...capability.optional_capabilities],
            network_mode: capability.network_mode,
            fail_closed: capability.fail_closed,
            ambient_fallback: capability.ambient_fallback,
            readiness: jsonClone(capability.readiness),
          }
        : {}),
    })),
    json: {
      schema_version: 1,
      success: {
        required: ["ok", "command"],
        ok: true,
        exit_code: 0,
      },
      failure: {
        required: ["ok", "command", "code", "message"],
        ok: false,
        exit_codes: {
          usage: 2,
          rejected: 3,
          unavailable: 4,
          doctor: 5,
          internal: 70,
        },
        stderr: "empty",
      },
      one_document: true,
      human_output_is_not_contract: true,
    },
    bounded_local_execution: {
      git_timeout_ms: 10_000,
      git_max_output_bytes: 65_536,
      checkpoint_max_paths: 4_096,
      evidence_max_paths: 4_096,
      diff_max_paths: 64,
      diff_max_bytes: 65_536,
      diff_max_hunks: 128,
    },
    session_targeting: {
      canonical: "--session <id>",
      positional_alias: "<session-id> as the first argument after a session-scoped subcommand",
      commands: ["show", "inspect", "claim", "claims", "release", "update", "close", "discard"],
      ambiguity: "supplying both positional and --session is rejected",
      discard_requires_explicit_target: true,
    },
    destructive_lifecycle: {
      command: "session discard",
      explicit_target_required: true,
      implicit_from: [],
      generic_force_bypass: false,
      non_interactive_json: true,
      ordinary_close_safety_unchanged: true,
    },
    dependencies: {
      local_git: true,
      network: false,
      github: false,
      gh: false,
      mottainai: false,
      llm: false,
      agent_runtime: false,
    },
    explicit_network: {
      default: false,
      operations: [
        {
          command: "session close",
          options: ["--integrated-revision", "--fetch-remote", "--fetch-branch"],
          requires: ["--integrated-revision", "--fetch-remote", "--fetch-branch"],
          scope: "one named remote branch into one disposable internal proof ref",
        },
      ],
    },
  };
}
