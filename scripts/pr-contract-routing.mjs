#!/usr/bin/env node

import { classifyReleaseBranch } from "./release-branch.mjs";

/**
 * Classify the trusted pull_request head ref into its own independent
 * branch-name contract.
 *
 * This is branch-name validation only (Issue #211): it never selects the PR
 * body template. A release branch must still look like release/<semver>, but
 * which contract the PR body itself must satisfy is resolved solely from the
 * body's own gh-inari template-identity marker.
 *
 * @param {{branch?: string}} options
 * @returns {{classification: string, version?: string, errors: string[]}}
 */
export function classifyPullRequestBranch({ branch } = {}) {
  if (branch === undefined || branch === "") {
    return { classification: "unclassified", errors: [] };
  }

  const release = classifyReleaseBranch(branch);
  if (release?.kind === "invalid-release") {
    return {
      classification: release.kind,
      errors: release.errors
    };
  }
  if (release?.kind === "release") {
    return {
      classification: release.kind,
      version: release.version,
      errors: []
    };
  }
  return { classification: "ordinary", errors: [] };
}
