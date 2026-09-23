#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTemplateIdentityMarker,
  validateExistingPullRequestArtifact,
  validateRequiredMetadataString,
} from "gh-inari/artifact";
import { compileLocalGovernedContract } from "gh-inari/governance";
import { classifyPullRequestBranch } from "./pr-contract-routing.mjs";
import { countTemplateIdentityMarkerAttempts } from "./pr-template-marker.mjs";
import { classifyEpicPrTitle } from "./epic-branch.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a pull-request event against the checked-out repository's local
 * Inari snapshot. The workflow owns event plumbing; gh-inari owns contract
 * compilation, Markdown parsing, and semantic validation.
 *
 * Template selection (Issue #211) is resolved directly from the PR body's
 * own gh-inari template-identity marker: `default`, `release`, `epic`, and
 * `authority` all go through the same marker mechanism, and there is no
 * branch/path/body-shape inference here. Branch-name governance
 * (classifyPullRequestBranch) still validates the head ref as its own
 * independent contract, but it no longer participates in template
 * selection. gh-inari itself only checks that a title is non-empty; the
 * canonical epic(<scope>): <description> title form (Issue #177) is a
 * separate, narrow addition owned directly here, exactly like branch-name
 * validation — see epic-branch.mjs. It only ever classifies a title that is
 * itself attempting the epic type; every ordinary/release title remains
 * unaffected.
 */
export async function validatePullRequest({ title, body, root = REPOSITORY_ROOT, branch }) {
  const routing = classifyPullRequestBranch({ branch });
  if (routing.errors.length > 0) {
    const violations = routing.errors.map((message) => ({
      code: "GOVERNANCE_RELEASE_BRANCH_INVALID",
      path: "$.pull_request.head.ref",
      message,
    }));
    return {
      valid: false,
      branchClassification: routing.classification,
      violations,
      errors: violations.map((violation) => violation.message),
    };
  }

  const resolution = await resolveTemplateContract(root, body);
  if (!resolution.valid) {
    return {
      valid: false,
      branchClassification: routing.classification,
      violations: resolution.violations,
      errors: resolution.violations.map((violation) => violation.message),
    };
  }

  const result = validateExistingPullRequestArtifact(resolution.contract, resolution.body);
  return report({ contract: resolution.contract, result }, title, routing.classification);
}

/**
 * Parse exactly one valid `inari:template` marker from the PR body and
 * resolve the referenced template/semantic contract directly from its
 * declared identity/path. Every failure mode is deterministic: there is no
 * fallback to inference or candidate matching once a marker is expected.
 */
async function resolveTemplateContract(root, body) {
  if (countTemplateIdentityMarkerAttempts(body) > 1) {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_MARKER_AMBIGUOUS",
          path: "$.pull_request.body",
          message: "Pull-request body contains more than one inari:template marker.",
        },
      ],
    };
  }

  const extracted = extractTemplateIdentityMarker(body ?? "");
  if (extracted.status === "absent") {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_MARKER_MISSING",
          path: "$.pull_request.body",
          message: "Pull-request body is missing the required inari:template marker.",
        },
      ],
    };
  }
  if (extracted.status === "malformed" || extracted.status === "unsupported-version") {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_MARKER_INVALID",
          path: "$.pull_request.body",
          message: "Pull-request body has a malformed inari:template marker.",
        },
      ],
    };
  }

  const { marker } = extracted;
  if (marker.kind !== "pull_request") {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_MARKER_WRONG_KIND",
          path: "$.pull_request.body",
          message: `Pull-request body's inari:template marker declares kind "${marker.kind}", not "pull_request".`,
        },
      ],
    };
  }

  try {
    const contract = await compileLocalGovernedContract("pr", root, marker.path);
    return { valid: true, contract, body: extracted.body };
  } catch {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_UNAVAILABLE",
          path: "$.pull_request.body",
          message: `Pull-request body's inari:template marker references an unavailable template: "${marker.path}".`,
        },
      ],
    };
  }
}

function report(outcome, title, branchClassification) {
  const violations = [...outcome.result.violations];
  const titleViolation = validateRequiredMetadataString(title, "title");
  if (titleViolation !== undefined) {
    violations.unshift(titleViolation);
  } else {
    // Only a title itself attempting the epic type is classified at all
    // (see epic-branch.mjs); every ordinary/release title is unaffected.
    const epicTitle = classifyEpicPrTitle(title);
    if (epicTitle?.kind === "invalid-epic-title") {
      violations.unshift({
        code: "GOVERNANCE_EPIC_PR_TITLE_INVALID",
        path: "$.pull_request.title",
        message: epicTitle.errors[0],
      });
    }
  }
  return {
    valid: violations.length === 0,
    contract: outcome.contract,
    branchClassification,
    result: outcome.result,
    violations,
    errors: violations.map((violation) => violation.message),
  };
}

async function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) throw new Error("--event <path-to-github-event-json> is required");
  const eventPath = process.argv[eventPathArgIndex + 1];
  if (eventPath === undefined) throw new Error("--event requires a path");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  if (!event.pull_request) throw new Error("event has no pull_request");

  const branchIndex = process.argv.indexOf("--branch");
  const pullRequest = event.pull_request;
  const branch = branchIndex === -1 ? pullRequest.head?.ref : process.argv[branchIndex + 1];
  const result = await validatePullRequest({
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    root: process.cwd(),
    branch,
  });
  console.log(
    JSON.stringify({
      valid: result.valid,
      ...(result.contract === undefined ? {} : { template: result.contract.templateIdentity }),
      ...(result.branchClassification === undefined ? {} : { branchClassification: result.branchClassification }),
      ...(result.result === undefined ? {} : { classification: result.result.classification }),
      violations: result.violations,
    }),
  );
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
