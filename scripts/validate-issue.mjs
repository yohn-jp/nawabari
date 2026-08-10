#!/usr/bin/env node
// Minimal Issue contract: body isn't empty and clears a floor length, so
// "blank Issues disabled" (see ISSUE_TEMPLATE/config.yml) has teeth in CI too.
import fs from "node:fs";

const MINIMUM_BODY_LENGTH = 20;

export function validateIssue(body) {
  const errors = [];
  const trimmed = (body ?? "").trim();
  if (trimmed.length === 0) errors.push("Issue body must not be empty");
  else if (trimmed.length < MINIMUM_BODY_LENGTH)
    errors.push(`Issue body must be at least ${MINIMUM_BODY_LENGTH} characters`);
  return errors;
}

function main() {
  const eventPathArgIndex = process.argv.indexOf("--event");
  if (eventPathArgIndex === -1) throw new Error("--event <path-to-github-event-json> is required");
  const event = JSON.parse(fs.readFileSync(process.argv[eventPathArgIndex + 1], "utf8"));
  const errors = validateIssue(event.issue?.body ?? "");

  const reportPathArgIndex = process.argv.indexOf("--report");
  if (errors.length > 0) {
    const report = ["Issue governance contract violation:", "", ...errors.map((error) => `- ${error}`)].join("\n");
    if (reportPathArgIndex !== -1) fs.writeFileSync(process.argv[reportPathArgIndex + 1], `${report}\n`);
    console.error(report);
    process.exitCode = 1;
    return;
  }
  console.log("Issue contract valid.");
}

if (process.argv[1]?.endsWith("validate-issue.mjs")) main();
