#!/usr/bin/env node
// Minimal PR contract: body links a closing Issue, and the required
// template sections are still present (not stripped by the author).
import fs from "node:fs";

const REQUIRED_SECTIONS = ["## Summary", "## Validation"];
const CLOSING_KEYWORD_PATTERN = /\b(closes|fixes|resolves)\s+#\d+/iu;
const RELEASE_BRANCH_PATTERN = /^release\/\d+\.\d+\.\d+$/;

export function validatePullRequest({ title, body, headRef }) {
  const errors = [];
  if (!title || title.trim().length === 0) errors.push("PR title must not be empty");
  const isReleaseBranch = RELEASE_BRANCH_PATTERN.test(headRef ?? "");
  if (!isReleaseBranch && !CLOSING_KEYWORD_PATTERN.test(body ?? "")) {
    errors.push('PR body must link a closing Issue (e.g. "Closes #123")');
  }
  for (const section of REQUIRED_SECTIONS) {
    if (!(body ?? "").includes(section)) errors.push(`PR body is missing required section: ${section}`);
  }
  return { errors };
}

function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) throw new Error("--event <path-to-github-event-json> is required");
  const event = JSON.parse(fs.readFileSync(process.argv[eventPathArgIndex + 1], "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error("event has no pull_request");

  const { errors } = validatePullRequest({
    title: pullRequest.title ?? "",
    body: pullRequest.body ?? "",
    headRef: pullRequest.head?.ref ?? "",
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log("PR contract valid.");
}

if (process.argv[1]?.endsWith("validate-pr.mjs")) main();
