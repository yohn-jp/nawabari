#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateExistingIssueArtifact } from "gh-inari/artifact";
import { compileLocalGovernedContract, compileLocalIssueFormContracts } from "gh-inari/governance";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Validate an Issue event against the checked-out repository's Inari snapshot. */
export async function validateIssue({ body, root = REPOSITORY_ROOT, template, contract }) {
  const contracts =
    contract === undefined
      ? template === undefined
        ? await compileLocalIssueFormContracts(root)
        : [await compileLocalGovernedContract("issue", root, template)]
      : [contract];
  const outcomes = contracts.map((candidate) => ({
    contract: candidate,
    result: validateExistingIssueArtifact(candidate, body),
  }));
  const valid = outcomes.filter(({ result }) => result.valid);
  if (valid.length === 1) return report(valid[0]);
  if (valid.length > 1) {
    return report({
      contract: valid[0].contract,
      result: {
        valid: false,
        classification: "wrong-template",
        violations: [
          {
            code: "GOVERNANCE_TEMPLATE_AMBIGUOUS",
            path: "$.template",
            message: "Issue body matches more than one repository-native Issue Form.",
          },
        ],
      },
    });
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
          message: "No repository-native Issue Form is available for validation.",
        },
      ],
    };
  }
  return report(selected);
}

function report(outcome) {
  const violations = [...outcome.result.violations];
  return {
    valid: violations.length === 0,
    contract: outcome.contract,
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
  if (!event.issue) throw new Error("event has no issue");

  const templateIndex = process.argv.indexOf("--template");
  const template = templateIndex === -1 ? undefined : process.argv[templateIndex + 1];
  const reportPathIndex = process.argv.indexOf("--report");
  const result = await validateIssue({
    body: event.issue.body ?? "",
    root: process.cwd(),
    template,
  });
  console.log(
    JSON.stringify({
      valid: result.valid,
      ...(result.contract === undefined ? {} : { template: result.contract.templateIdentity }),
      ...(result.result === undefined ? {} : { classification: result.result.classification }),
      violations: result.violations,
    }),
  );
  if (!result.valid) {
    if (reportPathIndex !== -1 && process.argv[reportPathIndex + 1] !== undefined) {
      const lines = [
        "Issue governance contract violation:",
        "",
        ...result.violations.map((violation) => `- [${violation.code}] ${violation.path}: ${violation.message}`),
      ];
      fs.writeFileSync(process.argv[reportPathIndex + 1], `${lines.join("\n")}\n`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
