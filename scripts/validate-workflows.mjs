#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_DIRECTORY = ".github/workflows";
const TOP_LEVEL_KEY_PATTERN = /^([A-Za-z0-9_.-]+):(?:\s|$)/u;
const JOB_KEY_PATTERN = /^  ([A-Za-z0-9_.-]+):(?:\s|$)/u;
const REQUIRED_PUBLISH_PERMISSIONS = Object.freeze({
  contents: "read",
  "id-token": "write",
});

function isTopLevelKey(line) {
  return line.length > 0 && !line.startsWith(" ") && !line.startsWith("\t");
}

export function duplicateTopLevelKeys(source, filePath = "<text>") {
  const seen = new Map();
  const errors = [];

  source.split(/\r?\n/u).forEach((line, index) => {
    if (!isTopLevelKey(line)) return;
    const match = line.match(TOP_LEVEL_KEY_PATTERN);
    if (match === null) return;

    const key = match[1];
    const lineNumber = index + 1;
    const previousLine = seen.get(key);
    if (previousLine !== undefined) {
      errors.push(`${filePath}:${lineNumber}: duplicate top-level key "${key}" (previously line ${previousLine})`);
    } else {
      seen.set(key, lineNumber);
    }
  });

  return errors;
}

function workflowJobBlock(source, jobName) {
  const lines = source.split(/\r?\n/u);
  const jobsLine = lines.findIndex((line) => /^jobs:\s*$/u.test(line));
  if (jobsLine === -1) return null;

  const jobPattern = new RegExp(`^  ${jobName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*$`, "u");
  const start = lines.findIndex((line, index) => index > jobsLine && jobPattern.test(line));
  if (start === -1) return null;

  const end = lines.findIndex((line, index) => index > start && JOB_KEY_PATTERN.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function hasJobPermission(jobBlock, name, value) {
  const lines = jobBlock.split(/\r?\n/u);
  const permissionsLine = lines.findIndex((line) => /^    permissions:\s*$/u.test(line));
  if (permissionsLine === -1) return false;

  return lines.slice(permissionsLine + 1).some((line) => {
    const match = line.match(
      new RegExp(`^      ${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s+([^#]+?)(?:\\s+#.*)?$`, "u"),
    );
    return match !== null && match[1].trim() === value;
  });
}

export function validateWorkflowText(source, filePath = "<text>") {
  const errors = duplicateTopLevelKeys(source, filePath);
  if (/^(<<<<<<<|=======|>>>>>>>)/mu.test(source)) {
    errors.push(`${filePath}: unresolved merge-conflict marker`);
  }
  if (!/^jobs:\s*$/mu.test(source)) errors.push(`${filePath}: missing top-level jobs mapping`);

  if (filePath.endsWith("/.github/workflows/publish.yml") || filePath === ".github/workflows/publish.yml") {
    const publishJob = workflowJobBlock(source, "publish");
    if (publishJob === null) {
      errors.push(`${filePath}: missing jobs.publish mapping`);
    } else {
      for (const [name, value] of Object.entries(REQUIRED_PUBLISH_PERMISSIONS)) {
        if (!hasJobPermission(publishJob, name, value)) {
          errors.push(`${filePath}: jobs.publish.permissions must include ${name}: ${value}`);
        }
      }
    }
  }

  return { file: filePath, errors };
}

export function repositoryWorkflowFiles(root) {
  const directory = path.join(path.resolve(root), WORKFLOW_DIRECTORY);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => path.join(WORKFLOW_DIRECTORY, entry.name))
    .sort();
}

export function validateRepositoryWorkflows(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) {
  const resolvedRoot = path.resolve(root);
  const files = repositoryWorkflowFiles(resolvedRoot);
  const errors = [];

  for (const file of files) {
    const result = validateWorkflowText(fs.readFileSync(path.join(resolvedRoot, file), "utf8"), file);
    errors.push(...result.errors);
  }

  return { root: resolvedRoot, files, errors };
}

function runAsCommand() {
  const result = validateRepositoryWorkflows();
  if (result.errors.length > 0) {
    console.error("GitHub Actions workflow structure validation failed");
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`GitHub Actions workflow structure validation passed: ${result.files.length} workflow(s).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runAsCommand();
}
