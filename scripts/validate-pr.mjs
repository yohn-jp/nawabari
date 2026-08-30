#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateExistingPullRequestArtifact, validateRequiredMetadataString } from "gh-inari/artifact";
import { compileLocalGovernedContract } from "gh-inari/governance";
import { compilePullRequestTemplate } from "gh-inari/pull-request-template";
import { PullRequestPolicyError } from "gh-inari/pr-policy";
import { resolvePullRequestTemplate } from "./pr-contract-routing.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validate a pull-request event against the checked-out repository's local
 * Inari snapshot. The workflow owns event plumbing; gh-inari owns contract
 * compilation, Markdown parsing, and semantic validation.
 */
export async function validatePullRequest({ title, body, root = REPOSITORY_ROOT, template, branch }) {
  const routing = resolvePullRequestTemplate({ branch, template });
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

  const contracts = await candidateContracts(root, routing.template, routing.classification);
  const outcomes = contracts.map((contract) => ({
    contract,
    result: validateExistingPullRequestArtifact(contract, body),
  }));
  const valid = outcomes.filter(({ result }) => result.valid);
  if (valid.length === 1) return report(valid[0], title, routing.classification);
  if (valid.length > 1) {
    return report(
      {
        contract: valid[0].contract,
        result: {
          valid: false,
          classification: "wrong-template",
          violations: [
            {
              code: "GOVERNANCE_TEMPLATE_AMBIGUOUS",
              path: "$.template",
              message: "Pull-request body matches more than one repository-native PR template.",
            },
          ],
        },
      },
      title,
      routing.classification,
    );
  }

  const selected = [...outcomes].sort((left, right) => {
    const leftParsed = left.result.parse.parsed ? 0 : 1;
    const rightParsed = right.result.parse.parsed ? 0 : 1;
    if (leftParsed !== rightParsed) return leftParsed - rightParsed;
    if (left.result.violations.length !== right.result.violations.length) {
      return left.result.violations.length - right.result.violations.length;
    }
    return left.contract.templateIdentity.id.localeCompare(right.contract.templateIdentity.id);
  })[0];

  if (selected === undefined) {
    return {
      valid: false,
      violations: [
        {
          code: "GOVERNANCE_TEMPLATE_UNAVAILABLE",
          path: "$.template",
          message: "No repository-native PR template is available for validation.",
        },
      ],
    };
  }
  return report(selected, title, routing.classification);
}

async function candidateContracts(root, template, classification) {
  if (template !== undefined && template.length > 0) {
    // release/<semver> is already an explicit, deterministic template route.
    // Repository pr-policy.yml commonly targets the ordinary `default`
    // template and must not be projected onto the independent release
    // contract merely because both are pull-request artifacts.
    if (classification === "release") {
      const contract = await compilePullRequestTemplate(root, template);
      // gh-inari's native compiler derives an identity from the filesystem
      // path. Branch routing, however, selects the repository's canonical
      // contract id (the local Inari snapshot uses `release`).
      return [
        {
          ...contract,
          templateIdentity: {
            ...contract.templateIdentity,
            id: template,
          },
        },
      ];
    }
    return [await compileLocalGovernedContract("pr", root, template)];
  }

  const directory = path.join(root, ".github", "inari", "pull-requests");
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort();
  const outcomes = await Promise.all(
    names.map(async (name) => {
      try {
        return { compiled: await compileLocalGovernedContract("pr", root, path.basename(name, ".json")) };
      } catch (error) {
        // A repository PR policy commonly binds to one native template (e.g.
        // `template: default`). During auto-detection every native template is
        // a candidate, so an unrelated candidate this policy does not target
        // is expected and must not abort discovery of the applicable one; it
        // is simply not a candidate. Any other failure (including a policy
        // mismatch against the template it *does* target) still propagates,
        // preserving fail-closed behavior for genuine misconfiguration.
        if (error instanceof PullRequestPolicyError && error.code === "PR_POLICY_TEMPLATE_MISMATCH") {
          return { compiled: undefined };
        }
        throw error;
      }
    }),
  );
  return outcomes.flatMap(({ compiled }) => (compiled === undefined ? [] : [compiled]));
}

function report(outcome, title, branchClassification) {
  const violations = [...outcome.result.violations];
  const titleViolation = validateRequiredMetadataString(title, "title");
  if (titleViolation !== undefined) violations.unshift(titleViolation);
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

  const templateIndex = process.argv.indexOf("--template");
  const template = templateIndex === -1 ? undefined : process.argv[templateIndex + 1];
  const branchIndex = process.argv.indexOf("--branch");
  const pullRequest = event.pull_request;
  const branch = branchIndex === -1 ? pullRequest.head?.ref : process.argv[branchIndex + 1];
  const result = await validatePullRequest({
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    root: process.cwd(),
    template,
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
