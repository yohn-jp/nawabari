#!/usr/bin/env node

const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER = `(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_BUILD_IDENTIFIER = "[0-9A-Za-z-]+";

export const RELEASE_BRANCH_PATTERN = new RegExp(
  `^release/${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}` +
    `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?` +
    `(?:\\+${SEMVER_BUILD_IDENTIFIER}(?:\\.${SEMVER_BUILD_IDENTIFIER})*)?$`,
);

/**
 * Classify a release-prefixed branch independently from ordinary branch
 * conventions used by an individual consumer.
 *
 * @param {string} branch
 * @returns {{kind: "release"|"invalid-release", valid: boolean, version?: string, errors: string[]}|undefined}
 */
export function classifyReleaseBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith("release/")) {
    return undefined;
  }
  if (RELEASE_BRANCH_PATTERN.test(branch)) {
    return {
      kind: "release",
      valid: true,
      version: branch.slice("release/".length),
      errors: [],
    };
  }
  return {
    kind: "invalid-release",
    valid: false,
    errors: [`release branch "${branch}" must match release/<semver> (for example release/1.2.3)`],
  };
}
