import {
  compileFilesystemMountArguments,
  compileFilesystemPolicyEnforcement,
  type FilesystemPolicyEnforcementOptions,
  type FilesystemPolicyEnforcementPlan,
} from "./filesystem-policy-enforcement.js";
import { selectFilesystemEnforcement, type MaterializedFilesystemPolicy } from "./filesystem-policy-materialization.js";
import type { FilesystemPolicyToken } from "./filesystem-policy-revision.js";
import { validateFilesystemPolicyToken } from "./filesystem-policy-revision.js";
import { DomainError, failure, success, type DomainResult } from "./errors.js";
import type { LandlockRule } from "./landlock.js";

export type FilesystemEnforcementIntegrationInput = Readonly<{
  readonly materialized_policy: MaterializedFilesystemPolicy;
  readonly policy_token: FilesystemPolicyToken;
  readonly expected_policy_token: FilesystemPolicyToken;
  readonly enforcement_options: FilesystemPolicyEnforcementOptions;
}>;

export type FilesystemEnforcementIntegrationResult = Readonly<{
  readonly policy_token: FilesystemPolicyToken;
  readonly enforcement: FilesystemPolicyEnforcementPlan;
  readonly mount_arguments: readonly string[];
  readonly landlock_rules: readonly LandlockRule[];
}>;

/**
 * Compile one materialized policy into the exact bwrap/Landlock bundle used by
 * protected execution.  The token fence is deliberately the first operation
 * so stale authority cannot reach any launch compiler.
 */
export function compileFilesystemEnforcementIntegration(
  input: FilesystemEnforcementIntegrationInput,
): DomainResult<FilesystemEnforcementIntegrationResult> {
  const token = validateFilesystemPolicyToken(input.policy_token, input.expected_policy_token);
  if (!token.ok) return token;

  const selection = selectFilesystemEnforcement(input.materialized_policy);
  if (selection.status !== "representable") {
    return failure(
      new DomainError(
        "SANDBOX_TOPOLOGY_INVALID",
        "Filesystem policy contains capabilities that cannot be safely represented.",
        {
          unsupported: selection.unsupported.length,
          worktree: input.materialized_policy.worktree,
        },
      ),
    );
  }

  const enforcement = compileFilesystemPolicyEnforcement(input.materialized_policy, input.enforcement_options);
  if (!enforcement.ok) return enforcement;

  const mountArguments = compileFilesystemMountArguments(input.materialized_policy);
  if (!mountArguments.ok) return mountArguments;

  return success(
    Object.freeze({
      policy_token: token.value,
      enforcement: enforcement.value,
      mount_arguments: mountArguments.value,
      landlock_rules: enforcement.value.landlock_rules,
    }),
  );
}
