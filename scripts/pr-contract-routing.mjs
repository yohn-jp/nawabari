#!/usr/bin/env node

import { classifyReleaseBranch } from "./release-branch.mjs";

/**
 * Resolve the PR contract from the trusted pull_request head ref.
 *
 * A release branch always selects the canonical release contract, even when a
 * caller supplied another template input. Ordinary PRs retain the caller's
 * explicit template or the existing generic auto-detection behavior.
 *
 * @param {{branch?: string, template?: string}} options
 * @returns {{classification: string, template?: string, version?: string, errors: string[]}}
 */
export function resolvePullRequestTemplate({ branch, template } = {}) {
  if (branch === undefined || branch === "") {
    return {
      classification: "unclassified",
      ...(template === undefined ? {} : { template }),
      errors: [],
    };
  }

  const release = classifyReleaseBranch(branch);
  if (release?.kind === "invalid-release") {
    return {
      classification: release.kind,
      errors: release.errors,
    };
  }
  if (release?.kind === "release") {
    return {
      classification: release.kind,
      template: "release",
      version: release.version,
      errors: [],
    };
  }
  return {
    classification: "ordinary",
    ...(template === undefined ? {} : { template }),
    errors: [],
  };
}
