#!/usr/bin/env node

// Canonical Epic classes: the epic/<issue-number>-<slug> integration branch
// and the epic(<scope>): <description> PR title.
//
// An Epic branch is a temporary integration boundary for one tracking/Epic
// Issue and its independently implemented child Issues (see Issue #177). It
// is a distinct branch class, not a variant of the ordinary
// <type>/<issue-number>-<slug> convention: it is always Issue-bound (unlike
// release/<semver>) but is an integration branch, not an implementation
// leaf, so it must be classified and validated independently of the
// consumer-configured ordinary branch-name-pattern.
//
// The Epic PR title is a separate, independent class: no existing shared
// governance validates a PR title's <type>(<scope>): <description> form at
// all (ordinary and release titles are only checked for being non-empty).
// classifyEpicPrTitle() therefore only recognizes and validates titles that
// are themselves attempting the epic type (starting "epic(" or "epic:");
// every other title — ordinary, release, or anything else — is left
// completely unclassified and unaffected, exactly as before.
//
// This module intentionally mirrors release-branch.mjs's shape and
// precedence guarantees. It stops at branch-name/PR-title classification:
// automatic Epic-child PR routing, a distinct PR *content* contract,
// merge-method semantics, certification freshness, and lifecycle automation
// are explicitly out of scope for #177 and belong to the follow-up Epic
// development model (#178).

export const EPIC_BRANCH_PATTERN = /^epic\/\d+-[a-z0-9-]+$/;

/**
 * Classify an epic-prefixed branch independently from ordinary branch
 * conventions used by an individual consumer.
 *
 * @param {string} branch
 * @returns {{kind: "epic"|"invalid-epic", valid: boolean, issueNumber?: string, slug?: string, errors: string[]}|undefined}
 */
export function classifyEpicBranch(branch) {
  if (typeof branch !== "string" || !branch.startsWith("epic/")) {
    return undefined;
  }
  if (EPIC_BRANCH_PATTERN.test(branch)) {
    const rest = branch.slice("epic/".length);
    const separatorIndex = rest.indexOf("-");
    return {
      kind: "epic",
      valid: true,
      issueNumber: rest.slice(0, separatorIndex),
      slug: rest.slice(separatorIndex + 1),
      errors: []
    };
  }
  return {
    kind: "invalid-epic",
    valid: false,
    errors: [
      `epic branch "${branch}" must match epic/<issue-number>-<slug> (for example epic/890-runtime-certification)`
    ]
  };
}

export const EPIC_PR_TITLE_PATTERN =
  /^epic\([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\): .+$/;

// Only a title that is itself attempting the epic type (starts "epic(" or
// "epic:") is classified at all. This keeps every other title — including
// one that merely mentions "epic" elsewhere ("feat: improve epic filters")
// — completely outside this governance, exactly as before.
const EPIC_PR_TITLE_ATTEMPT_PATTERN = /^epic[(:]/;

/**
 * Classify a PR title independently from ordinary/release PR conventions.
 * Returns undefined for any title not attempting the epic type at all, so
 * every non-epic title (ordinary or release) is left completely unaffected.
 *
 * @param {string} title
 * @returns {{kind: "epic"|"invalid-epic-title", valid: boolean, scope?: string, description?: string, errors: string[]}|undefined}
 */
export function classifyEpicPrTitle(title) {
  if (typeof title !== "string" || !EPIC_PR_TITLE_ATTEMPT_PATTERN.test(title)) {
    return undefined;
  }
  if (EPIC_PR_TITLE_PATTERN.test(title)) {
    const separatorIndex = title.indexOf("): ");
    return {
      kind: "epic",
      valid: true,
      scope: title.slice("epic(".length, separatorIndex),
      description: title.slice(separatorIndex + "): ".length),
      errors: []
    };
  }
  return {
    kind: "invalid-epic-title",
    valid: false,
    errors: [
      `PR title "${title}" must match epic(<scope>): <description> (for example epic(runtime): integrate certification pipeline)`
    ]
  };
}
