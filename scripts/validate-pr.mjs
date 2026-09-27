#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractTemplateIdentityMarker,
  validateExistingPullRequestArtifact,
  validateRequiredMetadataString
} from "gh-inari/artifact";
import { compileLocalGovernedContract } from "gh-inari/governance";
import { countTemplateIdentityMarkerAttempts } from "./pr-template-marker.mjs";
import { classifyEpicPrTitle } from "./epic-branch.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/**
 * Validate a pull-request event against the checked-out repository's local
 * Inari snapshot. The workflow owns event plumbing; gh-inari owns contract
 * compilation, Markdown parsing, semantic validation, branch/release routing,
 * and (when route evidence is supplied) Integration Routing projection.
 *
 * Template selection (Issue #211) is resolved directly from the PR body's
 * own gh-inari template-identity marker: `default`, `release`, `epic`, and
 * `authority` all go through the same marker mechanism, and there is no
 * branch/path/body-shape inference here. Branch-name governance
 * still validates the head ref as its own independent contract, but it no
 * longer participates in template selection. gh-inari itself only checks
 * that a title is non-empty; the canonical
 * `epic(<scope>): <description>` title form (Issue #177) is a separate,
 * narrow addition owned directly here — see epic-branch.mjs. It only ever
 * classifies a title that is itself attempting the epic type; every
 * ordinary/release title remains unaffected.
 */
export async function validatePullRequest({
  title,
  body,
  root = REPOSITORY_ROOT,
  branch,
  routing: routingEvidence,
  observedPullRequest
}) {
  const releaseBranch =
    typeof branch === "string" && branch.startsWith("release/");
  let branchClassification = releaseBranch
    ? "release"
    : branch === undefined || branch === ""
      ? "unclassified"
      : "ordinary";

  if (routingEvidence?.invalid !== undefined) {
    const violation = routingEvidence.invalid;
    return {
      valid: false,
      branchClassification,
      violations: [violation],
      errors: [violation.message]
    };
  }

  let routingProjection;
  if (releaseBranch || isReleaseRoutingEvidence(routingEvidence)) {
    const suppliedNonReleaseRoute =
      routingEvidence !== undefined &&
      !isReleaseRoutingEvidence(routingEvidence);
    const routeResult =
      releaseBranch && suppliedNonReleaseRoute
        ? await validateIntegrationRouting(routingEvidence, observedPullRequest)
        : await validateReleaseRouting({
            branch,
            routingEvidence,
            observedPullRequest
          });
    if (!routeResult.valid) {
      if (releaseBranch) branchClassification = "invalid-release";
      return {
        valid: false,
        branchClassification,
        ...(routeResult.projection === undefined
          ? {}
          : { routing: routeResult.projection }),
        violations: routeResult.diagnostics,
        errors: routeResult.diagnostics.map((violation) => violation.message)
      };
    }
    routingProjection = routeResult.projection;
  } else if (routingEvidence !== undefined) {
    const routeResult = await validateIntegrationRouting(
      routingEvidence,
      observedPullRequest
    );
    if (!routeResult.valid) {
      return {
        valid: false,
        branchClassification,
        ...(routeResult.projection === undefined
          ? {}
          : { routing: routeResult.projection }),
        violations: routeResult.diagnostics,
        errors: routeResult.diagnostics.map((violation) => violation.message)
      };
    }
    routingProjection = routeResult.projection;
  }

  const resolution = await resolveTemplateContract(root, body);
  if (!resolution.valid) {
    return {
      valid: false,
      branchClassification,
      ...(routingProjection === undefined
        ? {}
        : { routing: routingProjection }),
      violations: resolution.violations,
      errors: resolution.violations.map((violation) => violation.message)
    };
  }

  const result = validateExistingPullRequestArtifact(
    resolution.contract,
    resolution.body
  );
  const outcome = report(
    { contract: resolution.contract, result },
    title,
    branchClassification
  );
  return {
    ...outcome,
    ...(routingProjection === undefined ? {} : { routing: routingProjection })
  };
}

/**
 * Validate explicit integration-route evidence through the published Inari
 * projector, then bind it to the observed pull-request evidence through
 * Inari's publication-request validator.
 */
async function validateIntegrationRouting(input, observedPullRequest) {
  let inari;
  try {
    inari = await import("gh-inari");
  } catch (cause) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_UNAVAILABLE",
          path: "$.routing",
          message: `Canonical Inari routing could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`
        }
      ]
    };
  }

  const projector = inari.tryProjectIntegrationRouting;
  if (typeof projector !== "function") {
    return {
      valid: false,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_UNAVAILABLE",
          path: "$.routing",
          message:
            "Canonical Inari routing is unavailable; route evidence cannot be validated."
        }
      ]
    };
  }

  try {
    const result = projector(input);
    const projected = {
      valid: result?.valid === true,
      projection: result?.projection,
      diagnostics: Array.isArray(result?.diagnostics)
        ? result.diagnostics
        : [
            {
              code: "GOVERNANCE_INARI_ROUTING_INVALID",
              path: "$.routing",
              message:
                "Canonical Inari routing returned no structured diagnostics."
            }
          ]
    };
    if (!projected.valid || observedPullRequest === undefined) return projected;
    if (projected.projection === undefined) {
      return {
        valid: false,
        diagnostics: [
          {
            code: "GOVERNANCE_INARI_ROUTING_INVALID",
            path: "$.routing",
            message: "Canonical Inari routing returned no route projection."
          }
        ]
      };
    }

    const workIdentity = workIdentityFromProjection(projected.projection);
    return validatePublishedPullRequestEvidence(
      inari,
      projected.projection,
      workIdentity,
      observedPullRequest
    );
  } catch (cause) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_INVALID",
          path: "$.routing",
          message: `Canonical Inari routing failed closed: ${cause instanceof Error ? cause.message : String(cause)}`
        }
      ]
    };
  }
}

async function validateReleaseRouting({
  branch,
  routingEvidence,
  observedPullRequest
}) {
  let inari;
  try {
    inari = await import("gh-inari");
  } catch (cause) {
    return unavailableRoutingResult(cause);
  }

  if (typeof inari.tryValidatePrPublicationRequest !== "function") {
    return {
      valid: false,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_UNAVAILABLE",
          path: "$.routing",
          message:
            "Canonical Inari release routing is unavailable; release route evidence cannot be validated."
        }
      ]
    };
  }

  const suppliedRoute = unwrapRoutingEvidence(routingEvidence);
  const targetVersion =
    suppliedRoute?.targetVersion ??
    (typeof branch === "string" && branch.startsWith("release/")
      ? branch.slice("release/".length)
      : undefined);
  const sourceRevision = observedPullRequest?.headRevision;
  const workIdentity = {
    release: { targetVersion, sourceRevision }
  };
  if (observedPullRequest === undefined) {
    return {
      valid: false,
      ...(suppliedRoute === undefined ? {} : { projection: suppliedRoute }),
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_PR_EVIDENCE_INVALID",
          path: "$.pull_request",
          message:
            "Observed repository and pull-request evidence is required for release route validation."
        }
      ]
    };
  }
  return validatePublishedPullRequestEvidence(
    inari,
    suppliedRoute,
    workIdentity,
    observedPullRequest
  );
}

function validatePublishedPullRequestEvidence(
  inari,
  routing,
  workIdentity,
  observedPullRequest
) {
  if (observedPullRequest.invalid !== undefined) {
    return {
      valid: false,
      projection: routing,
      diagnostics: [observedPullRequest.invalid]
    };
  }
  const validator = inari.tryValidatePrPublicationRequest;
  if (typeof validator !== "function") {
    return {
      valid: false,
      projection: routing,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_UNAVAILABLE",
          path: "$.routing",
          message:
            "Canonical Inari pull-request evidence validation is unavailable."
        }
      ]
    };
  }
  try {
    const result = validator({
      version: 1,
      kind: "pr-publication",
      repository: observedPullRequest.repository,
      workIdentity,
      routing,
      expectedHead: observedPullRequest.head,
      expectedBase: observedPullRequest.base,
      headRevision: observedPullRequest.headRevision,
      title: observedPullRequest.title,
      body: observedPullRequest.body
    });
    return {
      valid: result?.valid === true,
      projection: result?.routing ?? routing,
      diagnostics: Array.isArray(result?.diagnostics)
        ? result.diagnostics
        : [
            {
              code: "GOVERNANCE_INARI_ROUTING_INVALID",
              path: "$.routing",
              message:
                "Canonical Inari pull-request validation returned no structured diagnostics."
            }
          ]
    };
  } catch (cause) {
    return {
      valid: false,
      projection: routing,
      diagnostics: [
        {
          code: "GOVERNANCE_INARI_ROUTING_INVALID",
          path: "$.routing",
          message: `Canonical Inari pull-request validation failed closed: ${cause instanceof Error ? cause.message : String(cause)}`
        }
      ]
    };
  }
}

function workIdentityFromProjection(projection) {
  if (projection.implementation === undefined) return undefined;
  return {
    implementation: projection.implementation,
    ...(projection.sourceIssue === undefined
      ? {}
      : { sourceIssue: projection.sourceIssue })
  };
}

function isReleaseRoutingEvidence(input) {
  const route = unwrapRoutingEvidence(input);
  return (
    typeof route === "object" &&
    route !== null &&
    !Array.isArray(route) &&
    route.kind === "release-pr-publication"
  );
}

function unwrapRoutingEvidence(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const keys = Object.keys(input);
  if (keys.length === 1 && Object.hasOwn(input, "routing")) {
    return input.routing;
  }
  if (keys.length === 1 && Object.hasOwn(input, "input")) {
    return input.input;
  }
  return input;
}

function unavailableRoutingResult(cause) {
  return {
    valid: false,
    diagnostics: [
      {
        code: "GOVERNANCE_INARI_ROUTING_UNAVAILABLE",
        path: "$.routing",
        message: `Canonical Inari routing could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    ]
  };
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
          message:
            "Pull-request body contains more than one inari:template marker."
        }
      ]
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
          message:
            "Pull-request body is missing the required inari:template marker."
        }
      ]
    };
  }
  if (
    extracted.status === "malformed" ||
    extracted.status === "unsupported-version"
  ) {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_MARKER_INVALID",
          path: "$.pull_request.body",
          message: "Pull-request body has a malformed inari:template marker."
        }
      ]
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
          message: `Pull-request body's inari:template marker declares kind "${marker.kind}", not "pull_request".`
        }
      ]
    };
  }

  try {
    const contract = await compileLocalGovernedContract(
      "pr",
      root,
      marker.path
    );
    return { valid: true, contract, body: extracted.body };
  } catch {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_UNAVAILABLE",
          path: "$.pull_request.body",
          message: `Pull-request body's inari:template marker references an unavailable template: "${marker.path}".`
        }
      ]
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
        message: epicTitle.errors[0]
      });
    }
  }
  return {
    valid: violations.length === 0,
    contract: outcome.contract,
    branchClassification,
    result: outcome.result,
    violations,
    errors: violations.map((violation) => violation.message)
  };
}

function readRoutingEvidence(event) {
  const pullRequest = event.pull_request;
  const configured = process.env.INARI_ROUTING;
  let input;
  if (configured !== undefined && configured.trim() !== "") {
    try {
      const source = configured.trim();
      input = fs.existsSync(source)
        ? JSON.parse(fs.readFileSync(source, "utf8"))
        : JSON.parse(source);
    } catch (cause) {
      return {
        invalid: {
          code: "GOVERNANCE_INARI_ROUTING_INVALID",
          path: "$.routing",
          message: `Configured Inari routing evidence is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`
        }
      };
    }
  } else {
    input =
      pullRequest?.routing ??
      pullRequest?.integration_routing ??
      pullRequest?.inari?.routing;
  }
  if (input === undefined) return undefined;
  input = unwrapRoutingEvidence(input);
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      invalid: {
        code: "GOVERNANCE_INARI_ROUTING_INVALID",
        path: "$.routing",
        message: "Inari routing evidence must be an object."
      }
    };
  }

  const observed = {
    ...(pullRequest?.head?.ref === undefined
      ? {}
      : { head: pullRequest.head.ref }),
    ...(pullRequest?.base?.ref === undefined
      ? {}
      : { base: pullRequest.base.ref })
  };
  const route = { ...input, ...observed };
  if (
    typeof input.pullRequest === "object" &&
    input.pullRequest !== null &&
    !Array.isArray(input.pullRequest)
  ) {
    route.pullRequest = { ...input.pullRequest, ...observed };
  }
  return route;
}

function readObservedPullRequest(event) {
  const repository = event.repository;
  const pullRequest = event.pull_request;
  try {
    if (typeof repository?.html_url !== "string") {
      throw new TypeError("GitHub event repository html_url is missing.");
    }
    const repositoryHost = new URL(repository.html_url).host;
    return {
      repository: {
        repositoryHost,
        repositoryId: String(repository.id ?? ""),
        repository: repository.full_name
      },
      head: pullRequest?.head?.ref,
      base: pullRequest?.base?.ref,
      headRevision: pullRequest?.head?.sha,
      title: pullRequest?.title ?? "",
      body: pullRequest?.body ?? ""
    };
  } catch (cause) {
    return {
      invalid: {
        code: "GOVERNANCE_INARI_PR_EVIDENCE_INVALID",
        path: "$.pull_request",
        message: `Observed repository evidence is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
      }
    };
  }
}

async function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1)
    throw new Error("--event <path-to-github-event-json> is required");
  const eventPath = process.argv[eventPathArgIndex + 1];
  if (eventPath === undefined) throw new Error("--event requires a path");
  const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
  if (!event.pull_request) throw new Error("event has no pull_request");

  const branchIndex = process.argv.indexOf("--branch");
  const pullRequest = event.pull_request;
  const branch =
    branchIndex === -1 ? pullRequest.head?.ref : process.argv[branchIndex + 1];
  const routingEvidence = readRoutingEvidence(event);
  const observedPullRequest = readObservedPullRequest(event);
  const result = await validatePullRequest({
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    root: process.cwd(),
    branch,
    routing: routingEvidence,
    observedPullRequest
  });
  console.log(
    JSON.stringify({
      valid: result.valid,
      ...(result.contract === undefined
        ? {}
        : { template: result.contract.templateIdentity }),
      ...(result.branchClassification === undefined
        ? {}
        : { branchClassification: result.branchClassification }),
      ...(result.result === undefined
        ? {}
        : { classification: result.result.classification }),
      ...(result.routing === undefined ? {} : { routing: result.routing }),
      violations: result.violations
    })
  );
  if (!result.valid) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
