#!/usr/bin/env node

// A governed PR body carries gh-inari's invisible template-identity marker
// (see Issue #211): a trailing `<!-- inari:template {...} -->` HTML comment
// that already states which template produced the body. Once that marker is
// present, template resolution must use it directly instead of inferring the
// template from branch names, changed paths, repository conditions, or by
// compiling every candidate contract and picking the closest match.
//
// gh-inari's own extractTemplateIdentityMarker() only ever looks at the last
// non-blank line, so it cannot notice an earlier, unrelated line that also
// starts with the reserved `<!-- inari:template ` prefix (for example a
// marker pasted into the PR description by hand, or left over from a
// copy-pasted body). Multiple markers are ambiguous input and must fail
// deterministically rather than silently resolving from whichever one
// extractTemplateIdentityMarker happens to read, so that check is done here
// before handing the body to gh-inari.

const TEMPLATE_IDENTITY_MARKER_LINE_PATTERN = /^<!-- inari:template \{.*\} -->$/u;

/**
 * Count how many lines in the body attempt the reserved template-identity
 * marker prefix, independent of whether each attempt actually parses.
 *
 * @param {string} body
 * @returns {number}
 */
export function countTemplateIdentityMarkerAttempts(body) {
  if (typeof body !== "string" || body.length === 0) return 0;
  return body.split("\n").filter((line) => TEMPLATE_IDENTITY_MARKER_LINE_PATTERN.test(line.trim())).length;
}
