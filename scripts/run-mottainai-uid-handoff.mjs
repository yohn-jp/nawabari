#!/usr/bin/env node
// Prove the external Mottainai -> packed Nawabari UID handoff.  This script
// owns no task, policy, credential, or principal semantics; the fixture runner
// only supplies the caller's preselected OS UID/GID view.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { seedOfflineRuntimeDependencyOverrides } from "./seed-offline-runtime-dependencies.mjs";

export const UID_HANDOFF_CONTRACT_ID = "nawabari.mottainai-packed-uid-handoff.v1";
export const SANDBOX_CONTRACT_ID = "nawabari.sandbox-execution.v1";
export const PACKED_EVIDENCE_CONTRACT_ID = "nawabari.packed-standalone-protected-execution.v1";
export const DEFAULT_UIDS = Object.freeze([23001, 23002]);
const MAX_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const defaultRunner = path.join(repoRoot, "scripts", "test-fixtures", "mottainai-preselected-uid-runner.sh");

function usage() {
  return [
    "Usage: node scripts/run-mottainai-uid-handoff.mjs [options]",
    "",
    "Options:",
    "  --tarball <path>               Exact #149 tarball to consume (required)",
    "  --artifact-evidence <path>     Exact #149 evidence JSON for that tarball",
    `  --fixture-runner <path>         External UID-only runner (default: ${defaultRunner})`,
    `  --uids <uid,uid>                Two preselected unprivileged UIDs (default: ${DEFAULT_UIDS.join(",")})`,
    "  --output <path>                 Bounded handoff evidence output",
    "  --keep-temp                     Keep the disposable consumer fixture",
    "  --help                          Show this help",
  ].join("\n");
}

export function parseArgs(argv) {
  const options = {
    tarball: undefined,
    artifactEvidence: undefined,
    fixtureRunner: defaultRunner,
    uids: [...DEFAULT_UIDS],
    output: path.join(repoRoot, "test-artifacts", "mottainai-packed-uid-handoff.json"),
    keepTemp: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (argument === "--keep-temp") {
      options.keepTemp = true;
      continue;
    }
    const [name, ...inlineParts] = argument.split("=");
    const inlineValue = inlineParts.length === 0 ? undefined : inlineParts.join("=");
    const names = new Map([
      ["--tarball", "tarball"],
      ["--artifact-evidence", "artifactEvidence"],
      ["--fixture-runner", "fixtureRunner"],
      ["--uids", "uids"],
      ["--output", "output"],
    ]);
    const field = names.get(name);
    if (field === undefined) throw new Error(`unknown option: ${argument}`);
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.length === 0) throw new Error(`${name} requires a value`);
    if (field === "uids") {
      options.uids = parseUids(value);
    } else {
      options[field] = value;
    }
  }
  if (options.help) return options;
  if (options.tarball === undefined || options.artifactEvidence === undefined) {
    throw new Error("--tarball and --artifact-evidence are required");
  }
  return options;
}

export function parseUids(value) {
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length !== 2 || entries.some((entry) => !/^\d+$/u.test(entry))) {
    throw new Error("--uids must contain exactly two numeric UIDs separated by a comma");
  }
  const uids = entries.map((entry) => Number(entry));
  if (uids.some((uid) => !Number.isSafeInteger(uid) || uid < 1_000 || uid > 65_533)) {
    throw new Error("--uids must contain two unprivileged UIDs in the range 1000..65533");
  }
  if (uids[0] === uids[1]) throw new Error("--uids must contain two distinct UIDs");
  return uids;
}

function bounded(value, limit = 2_000) {
  return String(value ?? "").slice(0, limit);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}\n${bounded(result.stdout)}\n${bounded(result.stderr)}`,
    );
  }
  return result;
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileIdentity(filePath) {
  const stat = fs.statSync(filePath);
  return {
    filename: path.basename(filePath),
    bytes: stat.size,
    sha256: sha256(filePath),
  };
}

function readJson(filePath, label) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > MAX_OUTPUT_BYTES) throw new Error(`${label} exceeds the evidence bound`);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertPackedArtifact(tarballPath, evidencePath) {
  if (!fs.existsSync(tarballPath)) throw new Error(`packed artifact not found: ${tarballPath}`);
  const evidence = readJson(evidencePath, "#149 artifact evidence");
  if (evidence.contract_id !== PACKED_EVIDENCE_CONTRACT_ID || typeof evidence.source_revision !== "string") {
    throw new Error("artifact evidence is not the accepted #149 packed protected-execution contract");
  }
  const artifact = evidence.artifact;
  if (
    artifact === null ||
    typeof artifact !== "object" ||
    artifact.package !== packageJson.name ||
    artifact.version !== packageJson.version ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(artifact.sha256) ||
    !Number.isSafeInteger(artifact.bytes)
  ) {
    throw new Error("#149 artifact evidence has an invalid bounded identity");
  }
  const identity = fileIdentity(tarballPath);
  if (
    path.basename(tarballPath) !== artifact.filename ||
    identity.bytes !== artifact.bytes ||
    identity.sha256 !== artifact.sha256
  ) {
    throw new Error("the supplied tarball does not match the exact #149 artifact evidence");
  }
  const metadata = JSON.parse(run("tar", ["-xOf", tarballPath, "package/package.json"]).stdout);
  if (metadata.name !== packageJson.name || metadata.version !== packageJson.version) {
    throw new Error("the supplied tarball metadata does not match the accepted package identity");
  }
  return {
    contract_id: evidence.contract_id,
    source_revision: evidence.source_revision,
    package: artifact.package,
    version: artifact.version,
    ...identity,
    files: Array.isArray(artifact.files) ? artifact.files.slice(0, 256) : [],
  };
}

function makeWorldReadable(root) {
  const entries = [root];
  while (entries.length > 0) {
    const current = entries.pop();
    if (current === undefined) continue;
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o777);
      for (const child of fs.readdirSync(current)) entries.push(path.join(current, child));
    } else if (stat.isFile()) {
      fs.chmodSync(current, (stat.mode & 0o111) === 0 ? 0o666 : 0o777);
    }
  }
}

function gitEnv(home) {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

function git(repository, args, home) {
  return run("git", args, { cwd: repository, env: gitEnv(home) }).stdout.trim();
}

function createRepository(repository, remote, home) {
  fs.mkdirSync(repository, { recursive: true, mode: 0o777 });
  fs.mkdirSync(home, { recursive: true, mode: 0o777 });
  git(repository, ["init", "--quiet", "--initial-branch", "main", repository], home);
  git(repository, ["config", "user.name", "Mottainai UID fixture"], home);
  git(repository, ["config", "user.email", "mottainai-uid-fixture@nawabari.invalid"], home);
  git(repository, ["config", "commit.gpgsign", "false"], home);
  fs.writeFileSync(path.join(repository, "README.md"), "same-display-repository\n");
  git(repository, ["add", "README.md"], home);
  git(repository, ["commit", "--quiet", "-m", "fixture base"], home);
  git(repository, ["init", "--quiet", "--bare", remote], home);
  git(repository, ["remote", "add", "origin", remote], home);
  makeWorldReadable(repository);
  makeWorldReadable(remote);
}

function parseCli(result, label) {
  if (result.error) throw result.error;
  if (result.stdout.trim().length === 0) {
    throw new Error(
      `${label} returned no bounded JSON (status=${String(result.status)}, stderr=${bounded(result.stderr)})`,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function invoke(runner, root, cwd, home, uid, binary, args) {
  const environment = {
    ...gitEnv(home),
    PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    TMPDIR: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    NAWABARI_UID_HANDOFF_FIXTURE: "1",
  };
  const result = spawnSync(runner, ["--uid", String(uid), "--root", root, "--cwd", cwd, "--", binary, ...args], {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const response = parseCli(result, args.join(" "));
  return { result, response };
}

function assertOk(invocation, label) {
  if (invocation.result.status !== 0 || invocation.response.ok !== true) {
    throw new Error(
      `${label} failed: ${bounded(JSON.stringify(invocation.response))}\n${bounded(invocation.result.stderr)}`,
    );
  }
  return invocation.response;
}

function assertNoPrincipalRegistry(repository) {
  const registryPath = path.join(repository, ".git", "nawabari", "session-registry.json");
  if (!fs.existsSync(registryPath)) throw new Error("Nawabari session registry was not recorded");
  const registry = readJson(registryPath, "Nawabari session registry");
  const forbiddenKeys = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (/(?:principal|mottainai|(?:^|_)uid|(?:^|_)gid)/iu.test(key)) forbiddenKeys.push(key);
      visit(nested);
    }
  };
  visit(registry);
  if (forbiddenKeys.length > 0) {
    throw new Error(`Nawabari registry contains external principal fields: ${forbiddenKeys.join(", ")}`);
  }
  if (fs.existsSync(path.join(repository, ".mottainai"))) {
    throw new Error("fixture unexpectedly introduced Mottainai repository state");
  }
}

function invokePrincipal({ runner, root, binary, uid, context }) {
  const { repository, home, worktree } = context;
  const repositoryId = path.join(repository, ".git");
  const common = (args, label, cwd = repository) => {
    const invocation = invoke(runner, root, cwd, home, uid, binary, ["--json", ...args]);
    return assertOk(invocation, `${uid} ${label}`);
  };
  const callerIdentity = invoke(runner, root, repository, home, uid, process.execPath, [
    "-e",
    "process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid()}))",
  ]);
  if (
    callerIdentity.result.status !== 0 ||
    callerIdentity.response.uid !== uid ||
    callerIdentity.response.gid !== uid
  ) {
    throw new Error(
      `${uid} runner did not supply the selected OS identity: ${bounded(JSON.stringify(callerIdentity.response))}`,
    );
  }
  const capabilities = common(["capabilities"], "capabilities");
  const protectedCapability = capabilities.capabilities?.find((entry) => entry.commands?.includes("session run"));
  if (
    capabilities.contract_id !== "nawabari.standalone-execution.v1" ||
    capabilities.dependencies?.mottainai !== false ||
    capabilities.dependencies?.network !== false ||
    protectedCapability === undefined
  ) {
    throw new Error(`${uid} did not expose the standalone/protected machine contract`);
  }
  const doctor = common(["doctor"], "doctor");
  if (doctor.sandbox?.contract_id !== SANDBOX_CONTRACT_ID || doctor.sandbox?.ready !== true) {
    throw new Error(`${uid} protected doctor contract was not ready: ${bounded(JSON.stringify(doctor.sandbox))}`);
  }

  const created = common(
    ["session", "create", "--branch", "fixture/uid-handoff", "--worktree", worktree, "--label", "same-display"],
    "session create",
  );
  const sessionId = created.session_id;
  if (typeof sessionId !== "string" || created.repository !== repositoryId || created.worktree !== worktree) {
    throw new Error(
      `${uid} session identity did not retain canonical repository/worktree paths: ${bounded(JSON.stringify(created))}`,
    );
  }
  const id = common(["session", "id"], "session id", worktree);
  if (id.session_id !== sessionId) throw new Error(`${uid} session id was confused across the handoff`);
  common(
    ["session", "claim", "--session", sessionId, "--resource", "handoff-marker.txt", "--mode", "exclusive-write"],
    "claim",
    worktree,
  );

  const markerScript =
    "const fs=require('node:fs');const [uid,marker,session]=process.argv.slice(1);const record={namespace_uid:typeof process.getuid==='function'?process.getuid():null,uid:Number(uid),marker,session_id:process.env.NAWABARI_SESSION_ID,cwd:process.cwd()};fs.writeFileSync(marker,JSON.stringify(record)+'\\n');process.stdout.write(JSON.stringify(record));";
  const protectedRun = common(
    [
      "session",
      "run",
      "--session",
      sessionId,
      "--",
      "node",
      "-e",
      markerScript,
      String(uid),
      "handoff-marker.txt",
      sessionId,
    ],
    "protected session run",
    worktree,
  );
  if (
    protectedRun.exit_code !== 0 ||
    protectedRun.stderr !== "" ||
    protectedRun.stdout === undefined ||
    typeof protectedRun.stdout !== "string"
  ) {
    throw new Error(`${uid} protected session result was not successful`);
  }
  let childEvidence;
  try {
    childEvidence = JSON.parse(protectedRun.stdout);
  } catch (error) {
    throw new Error(
      `${uid} protected child did not return bounded JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    childEvidence.uid !== uid ||
    childEvidence.session_id !== sessionId ||
    childEvidence.cwd !== worktree ||
    childEvidence.namespace_uid !== 0 ||
    childEvidence.marker !== "handoff-marker.txt"
  ) {
    throw new Error(
      `${uid} protected child identity/path evidence was confused: ${bounded(JSON.stringify(childEvidence))}`,
    );
  }
  const marker = JSON.parse(fs.readFileSync(path.join(worktree, "handoff-marker.txt"), "utf8"));
  if (marker.uid !== uid || marker.session_id !== sessionId || marker.cwd !== worktree) {
    throw new Error(`${uid} marker metadata was confused with another principal`);
  }
  const checkpoint = common(["checkpoint", "--session", sessionId], "checkpoint", worktree);
  if (!checkpoint.in_claim?.includes("handoff-marker.txt") || checkpoint.out_of_claim?.length !== 0) {
    throw new Error(`${uid} checkpoint did not retain Nawabari resource authority`);
  }
  const committed = common(
    [
      "commit",
      "--session",
      sessionId,
      "--message",
      "test: record packed UID handoff",
      "--resource",
      "handoff-marker.txt",
    ],
    "commit",
    worktree,
  );
  if (!/^[0-9a-f]{40}$/u.test(committed.commit_sha ?? "")) throw new Error(`${uid} commit identity was missing`);
  const pushed = common(
    [
      "push",
      "--session",
      sessionId,
      "--remote",
      "origin",
      "--branch",
      "fixture/uid-handoff",
      "--resource",
      "handoff-marker.txt",
      "--create-upstream",
    ],
    "push",
    worktree,
  );
  if (pushed.target !== "origin/fixture/uid-handoff") throw new Error(`${uid} push target identity was confused`);
  git(repository, ["merge", "--ff-only", "fixture/uid-handoff"], home);
  const closed = common(["session", "close", "--session", sessionId], "session close", worktree);
  if (closed.worktree_removed !== true || fs.existsSync(worktree))
    throw new Error(`${uid} Nawabari close did not own worktree cleanup`);
  assertNoPrincipalRegistry(repository);
  return {
    uid,
    gid: uid,
    display: "same-display",
    repository: repositoryId,
    repository_root: repository,
    caller_identity: {
      uid: callerIdentity.response.uid,
      gid: callerIdentity.response.gid,
    },
    worktree,
    branch: "fixture/uid-handoff",
    session_id: sessionId,
    contract_id: SANDBOX_CONTRACT_ID,
    protected_route: "session run",
    protected_child: {
      namespace_uid: childEvidence.namespace_uid,
      cwd: childEvidence.cwd,
      session_id: childEvidence.session_id,
      marker: childEvidence.marker,
    },
    checkpoint: {
      in_claim: ["handoff-marker.txt"],
      out_of_claim: [],
    },
    commit_sha: committed.commit_sha,
    push_target: pushed.target,
    close: {
      worktree_removed: closed.worktree_removed,
      branch_removed: closed.branch_removed,
    },
    registry: ".git/nawabari/session-registry.json",
  };
}

function writeEvidence(outputPath, artifact, fixture, principals) {
  if (
    principals.length !== 2 ||
    principals[0].uid === principals[1].uid ||
    principals.some(
      (principal) =>
        principal.contract_id !== SANDBOX_CONTRACT_ID ||
        principal.caller_identity?.uid !== principal.uid ||
        principal.caller_identity?.gid !== principal.gid ||
        principal.protected_child?.namespace_uid === principal.caller_identity?.uid,
    )
  ) {
    throw new Error("handoff evidence requires two distinct principal records");
  }
  const evidence = {
    schema_version: 1,
    contract_id: UID_HANDOFF_CONTRACT_ID,
    artifact,
    mottainai_fixture: {
      role: "external execution fixture only",
      contract_id: "mottainai.execution-fixture.preselected-uid.v1",
      identity: fixture,
      task_semantics: false,
      policy_semantics: false,
      credential_semantics: false,
    },
    assertions: {
      distinct_preselected_unprivileged_uids: true,
      same_protected_session_contract: SANDBOX_CONTRACT_ID,
      nawabari_observes_caller_uid: true,
      caller_uid_is_distinct_from_namespace_uid: true,
      nawabari_principal_registry: false,
      principal_confusion: false,
      nawabari_authority: ["session", "worktree", "resource", "local-git"],
      evidence_bound: true,
    },
    principals,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o644 });
}

function packedArtifactIdentity(runnerPath) {
  return {
    ...fileIdentity(runnerPath),
    fixture_id: "mottainai-preselected-uid-fixture.v1",
    runner_contract: "uid + root + cwd + argv only",
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const fixtureRunner = path.resolve(options.fixtureRunner);
  if (!fs.existsSync(fixtureRunner)) throw new Error(`fixture runner not found: ${fixtureRunner}`);
  if ((fs.statSync(fixtureRunner).mode & 0o111) === 0)
    throw new Error(`fixture runner is not executable: ${fixtureRunner}`);
  const tarballPath = path.resolve(options.tarball);
  const artifactEvidencePath = path.resolve(options.artifactEvidence);
  let tempRoot;
  try {
    const artifact = assertPackedArtifact(tarballPath, artifactEvidencePath);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-mottainai-uid-handoff-"));
    fs.chmodSync(tempRoot, 0o777);
    fs.mkdirSync(path.join(tempRoot, "tmp"), { recursive: true, mode: 0o777 });
    const consumer = path.join(tempRoot, "consumer");
    fs.mkdirSync(consumer, { recursive: true, mode: 0o777 });
    const runtimeDependencyOverrides = seedOfflineRuntimeDependencyOverrides({
      packageRoot: repoRoot,
      seedDirectory: consumer,
    });
    fs.writeFileSync(
      path.join(consumer, "package.json"),
      JSON.stringify({ name: "mottainai-uid-fixture", private: true, overrides: runtimeDependencyOverrides }),
    );
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", tarballPath], {
      cwd: consumer,
      env: { ...process.env, HOME: tempRoot, npm_config_cache: path.join(tempRoot, "npm-cache") },
    });
    makeWorldReadable(consumer);
    const binary = path.join(consumer, "node_modules", ".bin", "nawabari");
    if (!fs.existsSync(binary)) throw new Error("packed Nawabari binary was not installed in the fixture consumer");

    const principals = [];
    for (const uid of options.uids) {
      const contextRoot = path.join(tempRoot, "principal-contexts", String(uid));
      const repository = path.join(contextRoot, "same-display-repository");
      const remote = path.join(contextRoot, "same-display-remote.git");
      const home = path.join(contextRoot, "home");
      const worktree = path.join(repository, "nawabari", "worktrees", "same-display");
      fs.mkdirSync(contextRoot, { recursive: true, mode: 0o777 });
      createRepository(repository, remote, home);
      fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o777 });
      makeWorldReadable(contextRoot);
      principals.push(
        invokePrincipal({
          runner: fixtureRunner,
          root: tempRoot,
          binary,
          uid,
          context: { repository, remote, home, worktree },
        }),
      );
    }
    const fixture = packedArtifactIdentity(fixtureRunner);
    writeEvidence(path.resolve(options.output), artifact, fixture, principals);
    console.log(`Mottainai packed UID handoff evidence recorded: ${path.resolve(options.output)}`);
  } finally {
    if (tempRoot !== undefined && !options.keepTemp) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
