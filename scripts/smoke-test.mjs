#!/usr/bin/env node
// Installs the packed tarball into an isolated directory and runs the
// installed bin through its real npm-generated launcher. `npm pack --dry-run`
// only lists file contents — it never proves install or execution actually
// work, which is the failure mode this guards against.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const packageName = packageJson.name;
const expectedVersion = packageJson.version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (status ${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function fail(message) {
  console.error(`smoke test failed: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function packageBinTargets(packageDirectory) {
  const installedPackageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
  const bin = installedPackageJson.bin;
  if (typeof bin !== "object" || bin === null) fail("installed package.json has no bin map");
  return Object.entries(bin).map(([name, relativeTarget]) => ({
    name,
    target: path.join(packageDirectory, relativeTarget),
  }));
}

function parseArgs(argv) {
  const index = argv.indexOf("--tarball");
  return { tarball: index === -1 ? undefined : argv[index + 1] };
}

function addClosedHistory(registryPath, count, installDirectory) {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const now = "2026-08-10T00:00:00.000Z";
  const generated = Array.from({ length: count }, (_, index) => {
    const sessionId = `0190f1e0-0000-7000-8000-${(0xabc000000000 + index).toString(16).padStart(12, "0")}`;
    const branchName = `history/packed-${index}`;
    const worktreePath = path.join(installDirectory, `closed-history-${index}-${"x".repeat(40)}`);
    return {
      schema_version: 1,
      session_id: sessionId,
      repository_id: registry.repository_id,
      worktree_id: worktreePath,
      worktree_path: worktreePath,
      branch_id: `refs/heads/${branchName}`,
      branch_name: branchName,
      state: "closed",
      created_at: now,
      updated_at: now,
      label: `closed-history-${"x".repeat(160)}`,
    };
  });
  registry.sessions.push(...generated);
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function parseInstalledJson(result, label) {
  if (result.stdout.trim().length === 0) fail(`${label} emitted no JSON`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`${label} emitted invalid JSON: ${result.stdout}`);
  }
}

async function main() {
  const { tarball } = parseArgs(process.argv.slice(2));
  let tarballPath;
  let ownsTarball;
  if (tarball !== undefined) {
    tarballPath = path.resolve(tarball);
    ownsTarball = false;
    if (!fs.existsSync(tarballPath)) fail(`tarball not found: ${tarballPath}`);
  } else {
    console.log("packing tarball...");
    // Verifies the dist produced by the build step, not a re-built one:
    // prepack's implicit rebuild is intentionally not relied on here.
    const packResult = run("npm", ["pack", "--json", "--ignore-scripts"], { cwd: repoRoot });
    const [packInfo] = JSON.parse(packResult.stdout);
    tarballPath = path.join(repoRoot, packInfo.filename);
    ownsTarball = true;
  }

  const installDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-"));
  try {
    fs.writeFileSync(
      path.join(installDirectory, "package.json"),
      JSON.stringify({ name: "smoke-consumer", private: true, version: "0.0.0" }, null, 2),
    );

    console.log("installing packed tarball into isolated directory...");
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", tarballPath], {
      cwd: installDirectory,
    });

    const scope = packageName.startsWith("@") ? packageName.split("/")[0] : undefined;
    const installedPackageDirectory = scope
      ? path.join(installDirectory, "node_modules", scope, packageName.split("/")[1])
      : path.join(installDirectory, "node_modules", packageName);
    if (!fs.existsSync(installedPackageDirectory)) fail(`${packageName} was not installed under node_modules`);

    const binTargets = packageBinTargets(installedPackageDirectory);
    if (binTargets.length === 0) fail("package.json defines no bin entries to smoke test");
    if (packageName !== "nawabari" || packageJson.version !== expectedVersion) {
      fail(`package metadata must be nawabari@${expectedVersion}`);
    }
    const binNames = new Set(binTargets.map(({ name }) => name));
    for (const requiredBin of ["nawabari", "git-nawabari"]) {
      if (!binNames.has(requiredBin)) fail(`package is missing required bin "${requiredBin}"`);
    }

    for (const { name, target } of binTargets) {
      if (!fs.existsSync(target)) fail(`bin target for "${name}" does not exist at ${target}`);
    }

    // Goes through node_modules/.bin so a broken npm-generated launcher is
    // caught too — checking bin target existence alone would miss that.
    const binDirectory = path.join(installDirectory, "node_modules", ".bin");
    for (const { name } of binTargets) {
      const launcher = path.join(binDirectory, name);
      if (!fs.existsSync(launcher)) fail(`npm did not generate a launcher for "${name}" at ${launcher}`);

      console.log(`running ${name} --help through its installed launcher...`);
      const helpResult = spawnSync(launcher, ["--help"], { cwd: installDirectory, encoding: "utf8", timeout: 10_000 });
      if (helpResult.error) fail(`launcher "${name}" failed to start: ${helpResult.error.message}`);
      if (helpResult.status !== 0) fail(`launcher "${name}" --help exited ${helpResult.status}, expected 0`);

      console.log(`running ${name} --version through its installed launcher...`);
      const versionResult = spawnSync(launcher, ["--version"], {
        cwd: installDirectory,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (versionResult.error) fail(`launcher "${name}" failed to start: ${versionResult.error.message}`);
      if (versionResult.status !== 0) fail(`launcher "${name}" --version exited ${versionResult.status}, expected 0`);
      if (versionResult.stdout.trim() !== expectedVersion) {
        fail(`launcher "${name}" --version did not report ${expectedVersion}`);
      }
    }

    const gitEnvironment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const installedBinary = path.join(binDirectory, "nawabari");
    // Git reserves `git <external-command> --help` for man-page lookup, so
    // version is the portable discovery probe that does not require a manpage.
    const gitNawabariResult = spawnSync("git", ["nawabari", "--version"], {
      cwd: installDirectory,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (gitNawabariResult.error) fail(`git nawabari failed to start: ${gitNawabariResult.error.message}`);
    if (gitNawabariResult.status !== 0) fail(`git nawabari --version exited ${gitNawabariResult.status}, expected 0`);
    if (gitNawabariResult.stdout.trim() !== expectedVersion) {
      fail("git nawabari --version did not match the installed package metadata");
    }

    const capabilitiesResult = spawnSync(installedBinary, ["capabilities", "--json"], {
      cwd: installDirectory,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (capabilitiesResult.status !== 0) fail(`capabilities --json exited ${capabilitiesResult.status}`);
    let capabilities;
    try {
      capabilities = JSON.parse(capabilitiesResult.stdout);
    } catch {
      fail("capabilities --json did not emit one valid JSON document");
    }
    if (capabilities.ok !== true || capabilities.contract_id !== "nawabari.standalone-execution.v1") {
      fail("installed capabilities did not expose the standalone contract identifier");
    }
    if (
      capabilities.dependencies?.mottainai !== false ||
      capabilities.dependencies?.github !== false ||
      capabilities.dependencies?.gh !== false ||
      capabilities.dependencies?.network !== false
    ) {
      fail("installed capabilities exposed an unexpected external runtime dependency");
    }
    if (
      !capabilities.capabilities?.some((capability) => capability.commands?.includes("commit")) ||
      !capabilities.capabilities?.some((capability) => capability.commands?.includes("doctor"))
    ) {
      fail("installed capabilities did not enumerate the governed lifecycle");
    }
    if (!Array.isArray(capabilities.capabilities) || capabilities.capabilities.length === 0) {
      fail("installed capabilities did not expose a capability inventory");
    }
    for (const capability of capabilities.capabilities) {
      if (typeof capability.id !== "string") fail("installed capability has no stable id");
      if (capability.no_failure_codes === true) {
        if (capability.failure_codes !== undefined) {
          fail(`installed capability ${capability.id} declares both failures and no-failure status`);
        }
        continue;
      }
      if (!Array.isArray(capability.failure_codes) || capability.failure_codes.length === 0) {
        fail(`installed capability ${capability.id} has no advertised failure vocabulary`);
      }
      if (new Set(capability.failure_codes).size !== capability.failure_codes.length) {
        fail(`installed capability ${capability.id} has duplicate advertised failure codes`);
      }
      if (
        typeof capability.failure_code_policy?.source !== "string" ||
        capability.failure_code_policy?.missing_or_extra !== "deterministic conformance failure" ||
        !Array.isArray(capability.failure_code_policy?.internal_exceptions)
      ) {
        fail(`installed capability ${capability.id} has no documented failure-code policy`);
      }
    }
    const protectedExecution = capabilities.capabilities?.find((capability) => capability.id === "protected-execution");
    if (
      protectedExecution?.contract_id !== "nawabari.sandbox-execution.v1" ||
      protectedExecution?.schema_version !== 1 ||
      protectedExecution?.network_mode !== "inherited" ||
      protectedExecution?.fail_closed !== true ||
      protectedExecution?.ambient_fallback !== false ||
      protectedExecution?.commands?.join(",") !== "session run,session exec" ||
      protectedExecution?.command_aliases?.[0]?.alias !== "session exec"
    ) {
      fail("installed capabilities did not expose the protected-execution contract");
    }

    // Result-schema parity is part of the packed caller contract. Every
    // advertised schema is versioned and mapped to the public commands that
    // can reach it; this check intentionally consumes only discovery output.
    for (const capability of capabilities.capabilities ?? []) {
      if (!Number.isSafeInteger(capability.result_schema_version) || capability.result_schema_version < 1) {
        fail(`capability ${capability.id} did not expose an explicit result-schema version`);
      }
      if (!Array.isArray(capability.commands) || !Array.isArray(capability.result_schemas)) {
        fail(`capability ${capability.id} did not expose result-schema command mappings`);
      }
      const advertised = String(capability.result_schema)
        .split("/")
        .map((schema) => schema.trim())
        .filter(Boolean);
      const mappedSchemas = new Set();
      const mappedCommands = new Set();
      for (const mapping of capability.result_schemas) {
        if (
          typeof mapping?.schema !== "string" ||
          !/^(?:[a-z0-9-]+\.)+v[0-9]+$/.test(mapping.schema) ||
          !Number.isSafeInteger(mapping.version) ||
          mapping.version < 1 ||
          !Array.isArray(mapping.commands) ||
          mapping.commands.length === 0
        ) {
          fail(`capability ${capability.id} has an invalid result-schema mapping`);
        }
        if (mappedSchemas.has(mapping.schema)) fail(`capability ${capability.id} maps a schema more than once`);
        mappedSchemas.add(mapping.schema);
        for (const command of mapping.commands) {
          if (!capability.commands.includes(command)) {
            fail(`capability ${capability.id} maps ${mapping.schema} to a non-public command`);
          }
          if (mappedCommands.has(command)) fail(`capability ${capability.id} maps ${command} more than once`);
          mappedCommands.add(command);
        }
      }
      const unmappedEnvelopeSchemas = advertised.filter((schema) => !mappedSchemas.has(schema));
      if (unmappedEnvelopeSchemas.length > 0 && capability.id !== "resource-claims") {
        fail(`capability ${capability.id} has an advertised schema without an owner mapping`);
      }
      if (mappedCommands.size !== capability.commands.length) {
        fail(`capability ${capability.id} does not map every public command to a result schema`);
      }
    }
    if (capabilitiesResult.stderr.trim().length > 0) fail("capabilities --json wrote decorative output to stderr");
    // The v2 resource-claim capability publishes lifecycle result mappings,
    // transition/recovery identities, and operation-mode rationale in one
    // bounded document. Keep enough room for the complete failure-code and
    // result-schema vocabularies advertised by the public contract.
    if (capabilitiesResult.stdout.length > 24_000) fail("capabilities --json exceeded its fixed discovery budget");

    const helpJsonResult = spawnSync(installedBinary, ["--help", "--json"], {
      cwd: installDirectory,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (helpJsonResult.status !== 0) fail(`--help --json exited ${helpJsonResult.status}, expected 0`);
    const helpJson = parseInstalledJson(helpJsonResult, "JSON help");
    if (helpJson.ok !== true || helpJson.command !== "help") fail("--help --json returned an invalid help document");
    if (helpJsonResult.stdout.length > 12_000) fail("--help --json exceeded its fixed discovery budget");
    if (helpJsonResult.stderr.trim().length > 0) fail("--help --json wrote decorative output to stderr");

    const versionJsonResult = spawnSync(installedBinary, ["--version", "--json"], {
      cwd: installDirectory,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (versionJsonResult.status !== 0) fail(`--version --json exited ${versionJsonResult.status}, expected 0`);
    let versionJson;
    try {
      versionJson = JSON.parse(versionJsonResult.stdout);
    } catch {
      fail("--version --json did not emit one valid JSON document");
    }
    if (
      versionJson.ok !== true ||
      versionJson.contract_id !== "nawabari.standalone-execution.v1" ||
      versionJson.contract_schema_version !== 1
    ) {
      fail("--version --json did not expose the standalone contract identifier and schema version");
    }
    if (versionJsonResult.stderr.trim().length > 0) fail("--version --json wrote decorative output to stderr");

    const jsonResult = spawnSync(path.join(binDirectory, "nawabari"), ["session", "id", "--json"], {
      cwd: installDirectory,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (jsonResult.status !== 3) fail(`session id outside a Git repository exited ${jsonResult.status}, expected 3`);
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonResult.stdout);
    } catch {
      fail("session id --json did not emit one valid JSON document");
    }
    if (parsedJson.ok !== false || parsedJson.code !== "NOT_GIT_REPOSITORY") {
      fail("session id --json did not expose the stable local-repository error contract");
    }
    if (jsonResult.stderr.trim().length > 0) fail("session id --json wrote decorative output to stderr");

    const lifecycleRepository = path.join(installDirectory, "lifecycle-repository");
    const lifecycleWorktree = path.join(installDirectory, "lifecycle-worktree");
    const secondWorktree = path.join(installDirectory, "lifecycle-second-worktree");
    run("git", ["init", "-b", "main", lifecycleRepository], { env: gitEnvironment });
    run("git", ["config", "user.email", "nawabari-smoke@example.invalid"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    run("git", ["config", "user.name", "Nawabari Smoke"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["config", "commit.gpgsign", "false"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["config", "core.hooksPath", "/dev/null"], { cwd: lifecycleRepository, env: gitEnvironment });
    fs.writeFileSync(path.join(lifecycleRepository, "README.md"), "smoke fixture\n");
    run("git", ["add", "README.md"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["commit", "-m", "initial"], { cwd: lifecycleRepository, env: gitEnvironment });
    const remoteRepository = path.join(installDirectory, "lifecycle-remote.git");
    run("git", ["init", "--bare", remoteRepository], { env: gitEnvironment });
    run("git", ["remote", "add", "origin", remoteRepository], { cwd: lifecycleRepository, env: gitEnvironment });

    const invokeInstalled = (args, cwd) => {
      const result = spawnSync(installedBinary, args, {
        cwd,
        env: gitEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) fail(`${args.join(" ")} failed to start: ${result.error.message}`);
      return result;
    };
    const invokeInstalledAsync = (args, cwd) =>
      new Promise((resolve, reject) => {
        const child = spawn(installedBinary, args, {
          cwd,
          env: gitEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeout = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill();
            reject(new Error(`${args.join(" ")} timed out after 10000ms`));
          }
        }, 10_000);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            reject(error);
          }
        });
        child.once("close", (status, signal) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve({ status, signal, stdout, stderr });
          }
        });
      });

    const doctorResult = invokeInstalled(["doctor", "--json"], lifecycleRepository);
    if (doctorResult.status !== 0) fail(`doctor --json exited ${doctorResult.status}, expected 0`);
    const protectedExecutionDoctor = parseInstalledJson(doctorResult, "protected-execution readiness");
    if (
      protectedExecutionDoctor.ok !== true ||
      protectedExecutionDoctor.sandbox?.contract_id !== "nawabari.sandbox-execution.v1" ||
      protectedExecutionDoctor.sandbox?.schema_version !== 1 ||
      typeof protectedExecutionDoctor.sandbox?.platform_supported !== "boolean" ||
      typeof protectedExecutionDoctor.sandbox?.ready !== "boolean" ||
      !Array.isArray(protectedExecutionDoctor.sandbox?.missing_required) ||
      !Array.isArray(protectedExecutionDoctor.sandbox?.capabilities) ||
      protectedExecutionDoctor.sandbox?.network_mode !== "inherited"
    ) {
      fail("installed doctor did not expose protected-execution readiness");
    }
    if (doctorResult.stderr.trim().length > 0) fail("doctor --json wrote decorative output to stderr");

    console.log("running the installed Nawabari session lifecycle...");
    const protectedGuardResult = invokeInstalled(["guard", "--json"], lifecycleRepository);
    const protectedGuard = parseInstalledJson(protectedGuardResult, "protected worktree guard");
    if (protectedGuardResult.status !== 3 || protectedGuard.allowed !== false) {
      fail("guard did not reject the integration worktree");
    }

    const protectedAttemptResult = invokeInstalled(
      [
        "session",
        "create",
        "--branch",
        "main",
        "--worktree",
        path.join(installDirectory, "protected-worktree"),
        "--json",
      ],
      lifecycleRepository,
    );
    const protectedAttempt = parseInstalledJson(protectedAttemptResult, "protected branch create");
    if (protectedAttemptResult.status !== 3 || protectedAttempt.code !== "PROTECTED_BRANCH") {
      fail("session create did not reject the protected integration branch");
    }

    const existingWorktree = path.join(installDirectory, "existing-worktree");
    fs.mkdirSync(existingWorktree);
    const existingAttemptResult = invokeInstalled(
      ["session", "create", "--branch", "feature/existing-path", "--worktree", existingWorktree, "--json"],
      lifecycleRepository,
    );
    const existingAttempt = parseInstalledJson(existingAttemptResult, "existing worktree create");
    if (existingAttemptResult.status !== 3 || existingAttempt.code !== "WORKTREE_ALREADY_EXISTS") {
      fail("session create did not reject an existing worktree path");
    }
    fs.rmSync(existingWorktree, { recursive: true, force: true });

    const created = parseInstalledJson(
      invokeInstalled(
        ["session", "create", "--branch", "feature/installed-smoke", "--worktree", lifecycleWorktree, "--json"],
        lifecycleRepository,
      ),
      "session create",
    );
    if (created.ok !== true || typeof created.session_id !== "string")
      fail("session create did not return a session ID");
    if (created.state !== "active" || created.branch !== "feature/installed-smoke") {
      fail("session create returned incomplete ownership metadata");
    }

    const resolvedId = parseInstalledJson(
      invokeInstalled(["session", "id", "--json"], lifecycleWorktree),
      "session id",
    );
    if (resolvedId.ok !== true || resolvedId.session_id !== created.session_id) {
      fail("session id did not resolve the installed owned worktree");
    }

    const status = parseInstalledJson(invokeInstalled(["status", "--json"], lifecycleWorktree), "status");
    if (status.ok !== true || status.current_session?.session_id !== created.session_id) {
      fail("status did not report the current installed session");
    }
    if (typeof status.managed_worktree_root !== "string") {
      fail("status did not expose the resolved managed worktree root");
    }

    if (protectedExecutionDoctor.sandbox?.ready !== true) {
      fail("installed Linux package is not ready for the required protected-execution smoke");
    }
    const protectedArgument = "literal;$(touch packed-ambient-marker)";
    const protectedRun = invokeInstalled(
      [
        "session",
        "run",
        "--session",
        created.session_id,
        "--json",
        "--",
        "node",
        "-e",
        "process.stdout.write(JSON.stringify({cwd: process.cwd(), session_id: process.env.NAWABARI_SESSION_ID, argv: process.argv.slice(1)}))",
        protectedArgument,
      ],
      lifecycleWorktree,
    );
    const protectedRunJson = parseInstalledJson(protectedRun, "packed protected session run");
    if (
      protectedRun.status !== 0 ||
      protectedRunJson.ok !== true ||
      protectedRunJson.exit_code !== 0 ||
      protectedRunJson.signal !== null ||
      protectedRunJson.stderr !== ""
    ) {
      fail("packed protected session run did not return a successful bounded result");
    }
    let protectedEvidence;
    try {
      protectedEvidence = JSON.parse(protectedRunJson.stdout);
    } catch {
      fail("packed protected session run did not return JSON execution evidence");
    }
    if (
      protectedEvidence.cwd !== fs.realpathSync.native(lifecycleWorktree) ||
      protectedEvidence.session_id !== created.session_id ||
      protectedEvidence.argv?.length !== 1 ||
      protectedEvidence.argv[0] !== protectedArgument
    ) {
      fail("packed protected session run did not preserve authoritative cwd, session identity, and argv");
    }
    if (fs.existsSync(path.join(lifecycleWorktree, "packed-ambient-marker"))) {
      fail("packed protected session run interpolated command argv through a shell");
    }

    const initialEvidence = parseInstalledJson(
      invokeInstalled(["evidence", "snapshot", "--session", created.session_id, "--json"], lifecycleRepository),
      "repository evidence snapshot",
    );
    if (
      initialEvidence.ok !== true ||
      initialEvidence.session_id !== created.session_id ||
      initialEvidence.base_revision_proven !== true ||
      typeof initialEvidence.base_revision !== "string" ||
      typeof initialEvidence.evidence_hash !== "string"
    ) {
      fail("installed repository evidence did not expose the owned generation identity");
    }

    const initialList = parseInstalledJson(
      invokeInstalled(["session", "list", "--json"], lifecycleRepository),
      "default session list",
    );
    if (
      initialList.ok !== true ||
      !initialList.sessions?.some((session) => session.session_id === created.session_id) ||
      initialList.truncated !== false ||
      initialList.history_included !== false
    ) {
      fail("default session list did not expose bounded active-session metadata");
    }

    const createHelp = parseInstalledJson(
      invokeInstalled(["session", "create", "--help", "--json"], lifecycleRepository),
      "session create help",
    );
    if (
      createHelp.ok !== true ||
      createHelp.help_for !== "session create" ||
      createHelp.required_options?.length !== 0 ||
      createHelp.optional_options?.join(",") !== "--branch,--worktree,--worktree-root,--base,--label" ||
      createHelp.defaults?.["--base"] !== "HEAD"
    ) {
      fail("installed session create help did not expose the optional/defaulted contract");
    }

    console.log("verifying default-root, caller-selected --worktree-root, exact --worktree placement...");

    const statusBeforeRootChecks = parseInstalledJson(
      invokeInstalled(["status", "--json"], lifecycleRepository),
      "status before worktree-root checks",
    );
    const managedRoot = statusBeforeRootChecks.managed_worktree_root;
    if (typeof managedRoot !== "string" || managedRoot.length === 0) {
      fail("status did not expose managed_worktree_root before worktree-root checks");
    }

    const defaultRootCreated = parseInstalledJson(
      invokeInstalled(["session", "create", "--branch", "feature/default-root-smoke", "--json"], lifecycleRepository),
      "default-root session create",
    );
    if (
      defaultRootCreated.ok !== true ||
      defaultRootCreated.worktree_root !== managedRoot ||
      path.dirname(defaultRootCreated.worktree) !== managedRoot
    ) {
      fail("session create with no override did not place the worktree under managed_worktree_root");
    }
    const defaultRootClose = invokeInstalled(
      ["session", "close", "--session", defaultRootCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const defaultRootCloseJson = parseInstalledJson(defaultRootClose, "default-root session close");
    if (
      defaultRootClose.status !== 0 ||
      defaultRootCloseJson.ok !== true ||
      defaultRootCloseJson.worktree_removed !== true ||
      fs.existsSync(defaultRootCreated.worktree)
    ) {
      fail("default-root session close did not remove its worktree");
    }

    const customWorktreeRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(installDirectory, "custom-root-")));
    const customRootCreated = parseInstalledJson(
      invokeInstalled(
        ["session", "create", "--branch", "feature/custom-root-smoke", "--worktree-root", customWorktreeRoot, "--json"],
        lifecycleRepository,
      ),
      "custom-root session create",
    );
    if (
      customRootCreated.ok !== true ||
      customRootCreated.worktree_root !== customWorktreeRoot ||
      path.dirname(customRootCreated.worktree) !== customWorktreeRoot ||
      customRootCreated.worktree === customWorktreeRoot ||
      !fs.existsSync(customRootCreated.worktree)
    ) {
      fail("session create --worktree-root did not place a Nawabari-derived worktree beneath the caller-selected root");
    }

    const exactWorktreeOverride = path.join(installDirectory, "exact-worktree-smoke");
    const exactCreated = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "create",
          "--branch",
          "feature/exact-worktree-smoke",
          "--worktree",
          exactWorktreeOverride,
          "--json",
        ],
        lifecycleRepository,
      ),
      "exact --worktree session create",
    );
    if (exactCreated.ok !== true || exactCreated.worktree !== fs.realpathSync.native(exactWorktreeOverride)) {
      fail("session create --worktree did not honor the exact-path override");
    }

    const conflictWorktree = path.join(installDirectory, "conflict-worktree");
    const conflictAttemptResult = invokeInstalled(
      [
        "session",
        "create",
        "--branch",
        "feature/conflict-smoke",
        "--worktree",
        conflictWorktree,
        "--worktree-root",
        customWorktreeRoot,
        "--json",
      ],
      lifecycleRepository,
    );
    const conflictAttempt = parseInstalledJson(conflictAttemptResult, "--worktree/--worktree-root conflict");
    if (
      conflictAttemptResult.status !== 2 ||
      conflictAttempt.ok !== false ||
      conflictAttempt.code !== "INVALID_ARGUMENT"
    ) {
      fail("session create did not reject --worktree combined with --worktree-root before mutation");
    }
    if (fs.existsSync(conflictWorktree)) {
      fail("--worktree/--worktree-root conflict mutated the filesystem before being rejected");
    }

    const customRootClose = invokeInstalled(
      ["session", "close", "--session", customRootCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const customRootCloseJson = parseInstalledJson(customRootClose, "custom-root session close");
    if (
      customRootClose.status !== 0 ||
      customRootCloseJson.ok !== true ||
      customRootCloseJson.worktree_removed !== true ||
      fs.existsSync(customRootCreated.worktree)
    ) {
      fail("custom-root session close did not remove the worktree beneath the caller-selected root");
    }

    const exactClose = invokeInstalled(
      ["session", "close", "--session", exactCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const exactCloseJson = parseInstalledJson(exactClose, "exact --worktree session close");
    if (exactClose.status !== 0 || exactCloseJson.ok !== true || exactCloseJson.worktree_removed !== true) {
      fail("exact --worktree session close did not remove its worktree");
    }

    const invalidBase = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "create",
          "--branch",
          "feature/invalid-base",
          "--worktree",
          path.join(installDirectory, "invalid-base-worktree"),
          "--base",
          "missing-base-ref",
          "--json",
        ],
        lifecycleRepository,
      ),
      "invalid base ref",
    );
    if (
      invalidBase.code !== "INVALID_BASE_REF" ||
      invalidBase.details?.baseRef !== "missing-base-ref" ||
      invalidBase.details?.defaultBaseRef !== "HEAD" ||
      !Array.isArray(invalidBase.details?.recoveryHints)
    ) {
      fail("invalid base ref did not expose bounded recovery metadata");
    }

    const invalidSession = parseInstalledJson(
      invokeInstalled(["session", "show", "--session", "not-a-session-id", "--json"], lifecycleRepository),
      "invalid session id",
    );
    if (invalidSession.code !== "INVALID_SESSION_ID") {
      fail("session lifecycle did not expose INVALID_SESSION_ID");
    }

    const allowedGuard = parseInstalledJson(invokeInstalled(["guard", "--json"], lifecycleWorktree), "guard");
    if (allowedGuard.ok !== true || allowedGuard.allowed !== true || allowedGuard.code !== "ALLOWED") {
      fail("guard did not allow the owning installed worktree");
    }

    const governedResource = "contract-lifecycle.txt";
    const claim = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "claim",
          "--session",
          created.session_id,
          "--resource",
          governedResource,
          "--mode",
          "exclusive-write",
          "--json",
        ],
        lifecycleWorktree,
      ),
      "resource claim",
    );
    if (claim.ok !== true || claim.claims?.[0]?.mode !== "exclusive-write") {
      fail("installed session claim did not return the canonical exclusive claim");
    }
    const weakResource = "weak-claim.txt";
    const weakClaim = parseInstalledJson(
      invokeInstalled(
        ["session", "claim", "--session", created.session_id, "--resource", weakResource, "--mode", "write", "--json"],
        lifecycleWorktree,
      ),
      "weak resource claim",
    );
    if (weakClaim.ok !== true) fail("installed weak resource claim could not be created");
    const insufficient = parseInstalledJson(
      invokeInstalled(
        ["authorize", "--session", created.session_id, "--operation", "commit", "--resource", weakResource, "--json"],
        lifecycleWorktree,
      ),
      "insufficient claim mode",
    );
    if (
      insufficient.code !== "INSUFFICIENT_CLAIM_MODE" ||
      insufficient.details?.resource !== weakResource ||
      insufficient.details?.required_access !== "exclusive-write" ||
      JSON.stringify(insufficient.details?.granted_modes) !== JSON.stringify(["write"])
    ) {
      fail("installed authorization did not distinguish insufficient claim mode");
    }

    // #174: prove that the exact typed recovery action emitted by an
    // additive contradiction is executable through the installed package.
    // The action's observed generation is passed back verbatim as its CAS;
    // no registry file or complete claim-set reconstruction is involved.
    const recoveryResource = "recovery-transition.txt";
    const recoveryUnrelatedResource = "recovery-unrelated.txt";
    const recoveryWrite = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "claim",
          "--session",
          created.session_id,
          "--resource",
          recoveryResource,
          "--mode",
          "write",
          "--json",
        ],
        lifecycleWorktree,
      ),
      "recovery source claim",
    );
    const recoveryUnrelated = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "claim",
          "--session",
          created.session_id,
          "--resource",
          recoveryUnrelatedResource,
          "--mode",
          "read",
          "--json",
        ],
        lifecycleWorktree,
      ),
      "recovery unrelated claim",
    );
    if (
      recoveryWrite.ok !== true ||
      recoveryUnrelated.ok !== true ||
      typeof recoveryUnrelated.claim_set_generation !== "number"
    ) {
      fail("installed recovery fixture claims could not be created");
    }
    const recoveryRejectedResult = invokeInstalled(
      [
        "session",
        "claim",
        "--session",
        created.session_id,
        "--resource",
        recoveryResource,
        "--mode",
        "exclusive-write",
        "--json",
      ],
      lifecycleWorktree,
    );
    const recoveryRejected = parseInstalledJson(recoveryRejectedResult, "recovery contradiction");
    const recoveryAction = recoveryRejected.details?.recoveryAction;
    if (
      recoveryRejectedResult.status !== 3 ||
      recoveryRejected.code !== "CONTRADICTORY_CLAIM" ||
      recoveryAction?.actionId !== "transition-exact-resource" ||
      recoveryAction?.resource !== recoveryResource ||
      recoveryAction?.mode !== "exclusive-write" ||
      recoveryAction?.claimSetGeneration !== recoveryUnrelated.claim_set_generation ||
      typeof recoveryAction?.command !== "string"
    ) {
      fail("installed contradictory claim did not expose the typed exact-transition recovery action");
    }
    if (!recoveryAction.command.includes("--if-generation")) {
      fail("installed recovery action did not include its observed generation CAS");
    }
    const rejectedClaims = parseInstalledJson(
      invokeInstalled(["session", "claims", "--session", created.session_id, "--json"], lifecycleWorktree),
      "claims after rejected recovery",
    );
    if (
      rejectedClaims.ok !== true ||
      rejectedClaims.claim_set_generation !== recoveryAction.claimSetGeneration ||
      !rejectedClaims.claims?.some(
        (listedClaim) => listedClaim.resource === recoveryResource && listedClaim.mode === "write",
      ) ||
      !rejectedClaims.claims?.some(
        (listedClaim) => listedClaim.resource === recoveryUnrelatedResource && listedClaim.mode === "read",
      )
    ) {
      fail("rejected installed recovery claim mutated the claim set");
    }
    const recoveryTransitionResult = invokeInstalled(
      [
        "--json",
        "session",
        "transition",
        "--session",
        created.session_id,
        "--resource",
        recoveryAction.resource,
        "--mode",
        recoveryAction.mode,
        "--if-generation",
        String(recoveryAction.claimSetGeneration),
      ],
      lifecycleWorktree,
    );
    const recovered = parseInstalledJson(recoveryTransitionResult, "installed recovery transition");
    if (
      recoveryTransitionResult.status !== 0 ||
      recovered.ok !== true ||
      recovered.changed?.[0]?.resource !== recoveryResource ||
      recovered.changed?.[0]?.after?.mode !== "exclusive-write" ||
      !recovered.claims?.some(
        (listedClaim) => listedClaim.resource === recoveryUnrelatedResource && listedClaim.mode === "read",
      )
    ) {
      fail("installed recovery action did not execute the requested transition while preserving unrelated claims");
    }

    const claims = parseInstalledJson(
      invokeInstalled(["session", "claims", "--session", created.session_id, "--json"], lifecycleWorktree),
      "resource claims",
    );
    if (
      claims.ok !== true ||
      !claims.claims?.some((listedClaim) => listedClaim.claim_id === claim.claims?.[0]?.claim_id)
    ) {
      fail("installed claims listing did not preserve the claim identity");
    }
    const authorized = parseInstalledJson(
      invokeInstalled(
        [
          "authorize",
          "--session",
          created.session_id,
          "--operation",
          "source-write",
          "--resource",
          governedResource,
          "--json",
        ],
        lifecycleWorktree,
      ),
      "source-write authorization",
    );
    if (authorized.ok !== true || authorized.allowed !== true || authorized.resources?.[0]?.claim_ids?.length !== 1) {
      fail("installed authorization did not return the claim-backed allow decision");
    }
    fs.writeFileSync(path.join(lifecycleWorktree, governedResource), "packed lifecycle\n");
    run("git", ["add", "--", governedResource], { cwd: lifecycleWorktree, env: gitEnvironment });
    const changedEvidence = parseInstalledJson(
      invokeInstalled(["evidence", "snapshot", "--session", created.session_id, "--json"], lifecycleWorktree),
      "changed repository evidence snapshot",
    );
    if (
      changedEvidence.ok !== true ||
      changedEvidence.clean !== false ||
      !changedEvidence.paths?.changed?.includes(governedResource) ||
      changedEvidence.paths?.stats?.[0]?.available !== true
    ) {
      fail("installed repository evidence did not expose exact changed-path/stat state");
    }
    const selectedDiff = parseInstalledJson(
      invokeInstalled(
        [
          "diff",
          "--session",
          created.session_id,
          "--path",
          governedResource,
          "--patch",
          "--max-bytes",
          "4096",
          "--max-hunks",
          "4",
          "--json",
        ],
        lifecycleWorktree,
      ),
      "bounded selected diff",
    );
    if (
      selectedDiff.ok !== true ||
      selectedDiff.paths?.length !== 1 ||
      selectedDiff.paths[0] !== governedResource ||
      typeof selectedDiff.patch !== "string" ||
      !selectedDiff.patch.includes("packed lifecycle") ||
      typeof selectedDiff.evidence_hash !== "string"
    ) {
      fail("installed bounded diff did not expose the explicit selected path");
    }
    const checkpoint = parseInstalledJson(
      invokeInstalled(["checkpoint", "--session", created.session_id, "--json"], lifecycleWorktree),
      "checkpoint evidence",
    );
    if (
      checkpoint.ok !== true ||
      !checkpoint.paths?.changed?.includes(governedResource) ||
      !checkpoint.in_claim?.includes(governedResource) ||
      checkpoint.out_of_claim?.length !== 0
    ) {
      fail("installed checkpoint did not classify the changed path against its claim");
    }
    const committed = parseInstalledJson(
      invokeInstalled(
        [
          "commit",
          "--session",
          created.session_id,
          "--message",
          "exercise packed lifecycle",
          "--resource",
          governedResource,
          "--json",
        ],
        lifecycleWorktree,
      ),
      "governed commit",
    );
    if (committed.ok !== true || !/^[0-9a-f]{40}$/.test(committed.commit_sha)) {
      fail("installed governed commit did not return a commit SHA");
    }
    const pushed = parseInstalledJson(
      invokeInstalled(
        [
          "push",
          "--session",
          created.session_id,
          "--remote",
          "origin",
          "--branch",
          "feature/installed-smoke",
          "--resource",
          governedResource,
          "--create-upstream",
          "--json",
        ],
        lifecycleWorktree,
      ),
      "governed push",
    );
    if (
      pushed.ok !== true ||
      pushed.target !== "origin/feature/installed-smoke" ||
      pushed.relation !== "no-upstream" ||
      pushed.upstream_created !== true
    ) {
      fail("installed governed push did not return the explicit target contract");
    }
    run("git", ["merge", "--ff-only", "feature/installed-smoke"], { cwd: lifecycleRepository, env: gitEnvironment });

    const secondCreated = parseInstalledJson(
      invokeInstalled(
        ["session", "create", "--branch", "feature/installed-second", "--worktree", secondWorktree, "--json"],
        lifecycleRepository,
      ),
      "second session create",
    );
    const deniedGuard = invokeInstalled(["guard", "--session", secondCreated.session_id, "--json"], lifecycleWorktree);
    const deniedGuardJson = parseInstalledJson(deniedGuard, "cross-session guard");
    if (deniedGuard.status !== 3 || deniedGuardJson.allowed !== false) {
      fail("guard did not reject a cross-session mutation");
    }

    const concurrentSpecs = Array.from({ length: 4 }, (_, index) => ({
      branch: `feature/installed-concurrent-${index}`,
      worktree: path.join(installDirectory, `installed-concurrent-worktree-${index}`),
    }));
    const concurrentResults = await Promise.all(
      concurrentSpecs.map(({ branch, worktree }) =>
        invokeInstalledAsync(
          ["session", "create", "--branch", branch, "--worktree", worktree, "--json"],
          lifecycleRepository,
        ),
      ),
    );
    const concurrentCreated = concurrentResults.map((result, index) => {
      if (result.status !== 0) fail(`concurrent session ${index} exited ${result.status}: ${result.stderr}`);
      return parseInstalledJson(result, `concurrent session ${index}`);
    });
    if (new Set(concurrentCreated.map((session) => session.session_id)).size !== concurrentCreated.length) {
      fail("concurrent installed sessions did not receive unique identities");
    }

    const conflictingResource = "shared-concurrent-resource.txt";
    const claimRaceSpecs = [
      { session: secondCreated, worktree: secondWorktree },
      { session: concurrentCreated[0], worktree: concurrentSpecs[0].worktree },
    ];
    const claimRaceResults = await Promise.all(
      claimRaceSpecs.map(({ session, worktree }) =>
        invokeInstalledAsync(
          [
            "session",
            "claim",
            "--session",
            session.session_id,
            "--resource",
            conflictingResource,
            "--mode",
            "exclusive-write",
            "--json",
          ],
          worktree,
        ),
      ),
    );
    const claimRaceJson = claimRaceResults.map((result, index) => {
      if (result.status !== 0 && result.status !== 3) {
        fail(`concurrent claim ${index} exited ${result.status}: ${result.stderr}`);
      }
      return parseInstalledJson(result, `concurrent claim ${index}`);
    });
    if (claimRaceJson.filter((result) => result.ok === true).length !== 1) {
      fail("concurrent installed claims did not produce exactly one winner");
    }
    const deniedClaim = claimRaceJson.find((result) => result.ok === false);
    if (deniedClaim?.code !== "RESOURCE_CLAIM_CONFLICT") {
      fail("concurrent installed claims did not expose RESOURCE_CLAIM_CONFLICT");
    }
    const winnerIndex = claimRaceJson.findIndex((result) => result.ok === true);
    const retryClaim = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "claim",
          "--session",
          claimRaceSpecs[winnerIndex].session.session_id,
          "--resource",
          conflictingResource,
          "--mode",
          "exclusive-write",
          "--json",
        ],
        claimRaceSpecs[winnerIndex].worktree,
      ),
      "idempotent claim retry",
    );
    if (retryClaim.ok !== true || retryClaim.idempotent !== true) {
      fail("installed equivalent claim retry was not idempotent");
    }

    const hazardWorktree = path.join(installDirectory, "recoverable-commit-worktree");
    const hazardCreated = parseInstalledJson(
      invokeInstalled(
        ["session", "create", "--branch", "feature/installed-recoverable", "--worktree", hazardWorktree, "--json"],
        lifecycleRepository,
      ),
      "recoverable commit session create",
    );
    fs.writeFileSync(path.join(hazardWorktree, "recoverable-commit.txt"), "retain this commit\n");
    run("git", ["add", "recoverable-commit.txt"], { cwd: hazardWorktree, env: gitEnvironment });
    run("git", ["commit", "-m", "recoverable smoke commit"], { cwd: hazardWorktree, env: gitEnvironment });
    const blockedCommitClose = invokeInstalled(
      ["session", "close", "--session", hazardCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const blockedCommitCloseJson = parseInstalledJson(blockedCommitClose, "recoverable commit close");
    if (blockedCommitClose.status !== 3 || blockedCommitCloseJson.code !== "RECOVERABLE_COMMITS") {
      fail("close did not block a clean worktree with an unreachable commit");
    }
    run("git", ["merge", "--ff-only", "feature/installed-recoverable"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    const hazardClosed = invokeInstalled(
      ["session", "close", "--session", hazardCreated.session_id, "--json"],
      lifecycleRepository,
    );
    if (hazardClosed.status !== 0) fail("close did not retry after the recoverable commit became retained");

    // Packed dogfood regression: an obsolete intermediate execution has a
    // clean but unintegrated commit while the eventual integration branch has
    // moved to a different final head. Ordinary close remains protected;
    // explicit discard releases only this session's physical resources and
    // claims.
    const obsoleteWorktree = path.join(installDirectory, "packed-obsolete-intermediate-worktree");
    const obsoleteCreated = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "create",
          "--branch",
          "feature/packed-obsolete-intermediate",
          "--worktree",
          obsoleteWorktree,
          "--json",
        ],
        lifecycleRepository,
      ),
      "packed obsolete session create",
    );
    fs.writeFileSync(path.join(obsoleteWorktree, "obsolete-intermediate.txt"), "superseded execution\n");
    run("git", ["add", "obsolete-intermediate.txt"], { cwd: obsoleteWorktree, env: gitEnvironment });
    run("git", ["commit", "-m", "obsolete intermediate execution"], {
      cwd: obsoleteWorktree,
      env: gitEnvironment,
    });
    const obsoleteHead = run("git", ["rev-parse", "HEAD"], {
      cwd: obsoleteWorktree,
      env: gitEnvironment,
    }).stdout.trim();
    const obsoleteClaim = invokeInstalled(
      [
        "session",
        "claim",
        "--session",
        obsoleteCreated.session_id,
        "--resource",
        "obsolete-intermediate.txt",
        "--mode",
        "exclusive-write",
        "--json",
      ],
      obsoleteWorktree,
    );
    if (obsoleteClaim.status !== 0) fail("packed obsolete session claim setup failed");
    fs.writeFileSync(path.join(lifecycleRepository, "eventual-final-pr-head.txt"), "final integration head\n");
    run("git", ["add", "eventual-final-pr-head.txt"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["commit", "-m", "eventual final integration head"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    const obsoleteClose = invokeInstalled(
      ["session", "close", obsoleteCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const obsoleteCloseJson = parseInstalledJson(obsoleteClose, "packed obsolete close");
    if (obsoleteClose.status !== 3 || obsoleteCloseJson.code !== "RECOVERABLE_COMMITS") {
      fail("ordinary close did not reject the obsolete intermediate session");
    }
    if (obsoleteCloseJson.details?.currentSessionHead !== obsoleteHead) {
      fail("obsolete close did not expose the bounded current session HEAD evidence");
    }
    const obsoleteDiscard = invokeInstalled(
      ["session", "discard", "--session", obsoleteCreated.session_id, "--json"],
      lifecycleRepository,
    );
    const obsoleteDiscardJson = parseInstalledJson(obsoleteDiscard, "packed obsolete discard");
    if (
      obsoleteDiscard.status !== 0 ||
      obsoleteDiscardJson.operation !== "discard" ||
      obsoleteDiscardJson.previous_head !== obsoleteHead ||
      obsoleteDiscardJson.worktree_removed !== true ||
      obsoleteDiscardJson.branch_removed !== true ||
      obsoleteDiscardJson.released_claim_count !== 1 ||
      obsoleteDiscardJson.final_state !== "closed" ||
      obsoleteDiscardJson.session?.terminal_operation !== "discard"
    ) {
      fail("explicit packed discard did not return complete typed lifecycle evidence");
    }
    const obsoleteShown = parseInstalledJson(
      invokeInstalled(["session", "show", obsoleteCreated.session_id, "--json"], lifecycleRepository),
      "packed discarded session show",
    );
    if (obsoleteShown.terminal_operation !== "discard") {
      fail("positional session target did not expose the discarded terminal record");
    }

    const selfReferenceWorktree = path.join(installDirectory, "packed-self-reference-worktree");
    const selfReferenceCreated = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "create",
          "--branch",
          "feature/packed-self-reference",
          "--worktree",
          selfReferenceWorktree,
          "--json",
        ],
        lifecycleRepository,
      ),
      "packed self-reference session create",
    );
    fs.writeFileSync(path.join(selfReferenceWorktree, "packed-self-reference.txt"), "must remain recoverable\n");
    run("git", ["add", "packed-self-reference.txt"], { cwd: selfReferenceWorktree, env: gitEnvironment });
    run("git", ["commit", "-m", "packed self-reference candidate"], {
      cwd: selfReferenceWorktree,
      env: gitEnvironment,
    });
    const selfReferenceInspect = invokeInstalled(
      [
        "session",
        "inspect",
        "--session",
        selfReferenceCreated.session_id,
        "--integrated-revision",
        "feature/packed-self-reference",
        "--json",
      ],
      lifecycleRepository,
    );
    const selfReferenceInspectJson = parseInstalledJson(selfReferenceInspect, "packed self-reference inspect");
    if (
      selfReferenceInspect.status !== 0 ||
      selfReferenceInspectJson.close_readiness !== "blocked" ||
      selfReferenceInspectJson.blockers?.[0]?.code !== "RECOVERABLE_COMMITS" ||
      selfReferenceInspectJson.blockers?.[0]?.details?.proofFailure !== "integration-revision-not-authoritative"
    ) {
      fail("packed session inspect accepted self-referential integration evidence");
    }
    const selfReferenceClose = invokeInstalled(
      [
        "session",
        "close",
        "--session",
        selfReferenceCreated.session_id,
        "--integrated-revision",
        "feature/packed-self-reference",
        "--json",
      ],
      lifecycleRepository,
    );
    const selfReferenceCloseJson = parseInstalledJson(selfReferenceClose, "packed self-reference close");
    if (
      selfReferenceClose.status !== 3 ||
      selfReferenceCloseJson.code !== "RECOVERABLE_COMMITS" ||
      selfReferenceCloseJson.details?.proofFailure !== "integration-revision-not-authoritative"
    ) {
      fail("packed session close accepted self-referential integration evidence");
    }
    run("git", ["merge", "--ff-only", "feature/packed-self-reference"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    const selfReferenceClosed = invokeInstalled(
      ["session", "close", "--session", selfReferenceCreated.session_id, "--json"],
      lifecycleRepository,
    );
    if (selfReferenceClosed.status !== 0)
      fail("packed self-reference session did not close after ordinary integration");

    fs.writeFileSync(path.join(lifecycleWorktree, "recoverable.txt"), "keep until close is safe\n");
    for (let index = 0; index < 64; index += 1) {
      fs.writeFileSync(path.join(lifecycleWorktree, `dirty-${index}.txt`), "preserve\n");
    }
    const dirtyClose = invokeInstalled(
      ["session", "close", "--session", created.session_id, "--json"],
      lifecycleRepository,
    );
    const dirtyCloseJson = parseInstalledJson(dirtyClose, "dirty close");
    if (dirtyClose.status !== 3 || dirtyCloseJson.code !== "DIRTY_WORKTREE") {
      fail("dirty close did not fail closed");
    }
    if (
      dirtyCloseJson.details?.paths?.length !== 32 ||
      dirtyCloseJson.details?.paths_truncated !== true ||
      dirtyCloseJson.details?.paths_total < 65 ||
      dirtyCloseJson.details?.paths_next_offset !== 32
    ) {
      fail("dirty close did not expose explicit bounded path metadata");
    }
    fs.rmSync(path.join(lifecycleWorktree, "recoverable.txt"), { force: true });
    for (let index = 0; index < 64; index += 1) {
      fs.rmSync(path.join(lifecycleWorktree, `dirty-${index}.txt`), { force: true });
    }

    const closed = invokeInstalled(
      ["session", "close", "--session", created.session_id, "--json"],
      lifecycleRepository,
    );
    const closedJson = parseInstalledJson(closed, "safe close");
    if (closed.status !== 0 || closedJson.ok !== true || closedJson.session?.state !== "closed") {
      fail("safe close did not release the installed session");
    }

    const defaultList = parseInstalledJson(
      invokeInstalled(["session", "list", "--json"], lifecycleRepository),
      "bounded session list",
    );
    if (defaultList.ok !== true || defaultList.sessions?.some((session) => session.session_id === created.session_id)) {
      fail("default session list did not exclude closed history");
    }
    const historyList = parseInstalledJson(
      invokeInstalled(["session", "list", "--all", "--json"], lifecycleRepository),
      "session history list",
    );
    if (
      historyList.ok !== true ||
      !historyList.sessions?.some((session) => session.session_id === created.session_id && session.state === "closed")
    ) {
      fail("explicit session history list did not expose closed records");
    }

    const preSeedRelease = invokeInstalled(
      ["session", "release", "--session", secondCreated.session_id, "--all", "--force", "--json"],
      secondWorktree,
    );
    if (preSeedRelease.status !== 0) {
      fail("installed session release did not clear residual claims before the deterministic multi-claim setup");
    }

    // #175: exercise the advertised resource-claim machine contract through
    // the packed dispatcher only.  The sequence deliberately carries the
    // authoritative generation from one public result into the next; no
    // registry file or source-level algorithm is used by this fixture.
    const contractAcquireResource = "contract-acquire.txt";
    const contractUnrelatedResource = "contract-unrelated.txt";
    const contractDeltaResource = "contract-delta.txt";
    const contractReplacementResource = "contract-replacement.txt";
    const contractRecoveryResource = "contract-recovery.txt";
    const contractClaim = (resource, mode, label) =>
      parseInstalledJson(
        invokeInstalled(
          ["session", "claim", "--session", secondCreated.session_id, "--resource", resource, "--mode", mode, "--json"],
          secondWorktree,
        ),
        label,
      );
    const contractAcquire = contractClaim(contractAcquireResource, "read", "contract acquire");
    if (contractAcquire.ok !== true || typeof contractAcquire.claim_set_generation !== "number") {
      fail("packed contract acquire did not expose claim-set generation");
    }
    const contractUnrelated = contractClaim(contractUnrelatedResource, "read", "contract unrelated acquire");
    if (contractUnrelated.ok !== true || typeof contractUnrelated.claim_set_generation !== "number") {
      fail("packed contract unrelated claim did not expose claim-set generation");
    }
    const staleContractTransition = invokeInstalled(
      [
        "session",
        "transition",
        "--session",
        secondCreated.session_id,
        "--resource",
        contractAcquireResource,
        "--mode",
        "exclusive-write",
        "--if-generation",
        String(contractUnrelated.claim_set_generation - 1),
        "--json",
      ],
      secondWorktree,
    );
    const staleContractJson = parseInstalledJson(staleContractTransition, "contract stale transition");
    const staleContractClaims = parseInstalledJson(
      invokeInstalled(["session", "claims", "--session", secondCreated.session_id, "--json"], secondWorktree),
      "claims after contract stale transition",
    );
    if (
      staleContractTransition.status !== 3 ||
      staleContractJson.code !== "STALE_CLAIM_SET" ||
      staleContractClaims.claim_set_generation !== contractUnrelated.claim_set_generation ||
      staleContractClaims.claims?.length !== 2 ||
      !staleContractClaims.claims?.some(
        (entry) => entry.resource === contractAcquireResource && entry.mode === "read",
      ) ||
      !staleContractClaims.claims?.some(
        (entry) => entry.resource === contractUnrelatedResource && entry.mode === "read",
      )
    ) {
      fail("packed contract stale CAS was not rejected without mutating claims");
    }
    const contractTransition = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "transition",
          "--session",
          secondCreated.session_id,
          "--resource",
          contractAcquireResource,
          "--mode",
          "write",
          "--if-generation",
          String(contractUnrelated.claim_set_generation),
          "--json",
        ],
        secondWorktree,
      ),
      "contract transition",
    );
    if (
      contractTransition.ok !== true ||
      typeof contractTransition.claim_set_generation !== "number" ||
      !contractTransition.changed?.some(
        (entry) => entry.resource === contractAcquireResource && entry.after?.mode === "write",
      ) ||
      !contractTransition.claims?.some((entry) => entry.resource === contractUnrelatedResource)
    ) {
      fail("packed contract transition did not preserve the unrelated claim");
    }
    const contractDelta = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "mutate",
          "--session",
          secondCreated.session_id,
          "--upsert-resource",
          contractDeltaResource,
          "--mode",
          "exclusive-write",
          "--release-resource",
          contractAcquireResource,
          "--if-generation",
          String(contractTransition.claim_set_generation),
          "--json",
        ],
        secondWorktree,
      ),
      "contract atomic delta",
    );
    if (
      contractDelta.ok !== true ||
      typeof contractDelta.claim_set_generation !== "number" ||
      !contractDelta.added?.some((entry) => entry.resource === contractDeltaResource) ||
      !contractDelta.released?.some((entry) => entry.resource === contractAcquireResource) ||
      !contractDelta.claims?.some((entry) => entry.resource === contractUnrelatedResource)
    ) {
      fail("packed contract atomic delta did not preserve unrelated claims");
    }
    const contractSelectedRelease = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "release",
          "--session",
          secondCreated.session_id,
          "--resource",
          contractDeltaResource,
          "--if-generation",
          String(contractDelta.claim_set_generation),
          "--json",
        ],
        secondWorktree,
      ),
      "contract selected release",
    );
    if (
      contractSelectedRelease.ok !== true ||
      typeof contractSelectedRelease.claim_set_generation !== "number" ||
      !contractSelectedRelease.released?.some((entry) => entry.resource === contractDeltaResource) ||
      !contractSelectedRelease.remaining?.some((entry) => entry.resource === contractUnrelatedResource)
    ) {
      fail("packed contract selected release did not preserve unrelated claims");
    }
    const contractReplacement = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "update",
          "--session",
          secondCreated.session_id,
          "--resource",
          contractUnrelatedResource,
          "--mode",
          "read",
          "--resource",
          contractReplacementResource,
          "--mode",
          "read",
          "--force",
          "--json",
        ],
        secondWorktree,
      ),
      "contract complete replacement",
    );
    if (
      contractReplacement.ok !== true ||
      typeof contractReplacement.claim_set_generation !== "number" ||
      contractReplacement.claims?.length !== 2 ||
      !contractReplacement.claims?.some((entry) => entry.resource === contractReplacementResource)
    ) {
      fail("packed contract complete replacement did not expose the requested complete set");
    }
    const contractRecoveryClaim = contractClaim(contractRecoveryResource, "write", "contract recovery source claim");
    if (contractRecoveryClaim.ok !== true || typeof contractRecoveryClaim.claim_set_generation !== "number") {
      fail("packed contract recovery source claim did not expose generation");
    }
    const contractRecoveryRejectedResult = invokeInstalled(
      [
        "session",
        "claim",
        "--session",
        secondCreated.session_id,
        "--resource",
        contractRecoveryResource,
        "--mode",
        "exclusive-write",
        "--json",
      ],
      secondWorktree,
    );
    const contractRecoveryRejected = parseInstalledJson(contractRecoveryRejectedResult, "contract recovery rejection");
    const contractRecoveryAction = contractRecoveryRejected.details?.recoveryAction;
    if (
      contractRecoveryRejectedResult.status !== 3 ||
      contractRecoveryRejected.code !== "CONTRADICTORY_CLAIM" ||
      contractRecoveryAction?.actionId !== "transition-exact-resource" ||
      contractRecoveryAction?.resource !== contractRecoveryResource ||
      contractRecoveryAction?.mode !== "exclusive-write" ||
      contractRecoveryAction?.claimSetGeneration !== contractRecoveryClaim.claim_set_generation
    ) {
      fail("packed contract recovery did not expose a deterministic CAS transition action");
    }
    const contractRecovered = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "transition",
          "--session",
          secondCreated.session_id,
          "--resource",
          contractRecoveryAction.resource,
          "--mode",
          contractRecoveryAction.mode,
          "--if-generation",
          String(contractRecoveryAction.claimSetGeneration),
          "--json",
        ],
        secondWorktree,
      ),
      "contract safe recovery",
    );
    if (
      contractRecovered.ok !== true ||
      !contractRecovered.claims?.some(
        (entry) => entry.resource === contractUnrelatedResource && entry.mode === "read",
      ) ||
      !contractRecovered.claims?.some(
        (entry) => entry.resource === contractReplacementResource && entry.mode === "read",
      ) ||
      !contractRecovered.claims?.some(
        (entry) => entry.resource === contractRecoveryResource && entry.mode === "exclusive-write",
      )
    ) {
      fail("packed contract safe recovery did not preserve the complete replacement claims");
    }
    const contractReset = invokeInstalled(
      ["session", "release", "--session", secondCreated.session_id, "--all", "--force", "--json"],
      secondWorktree,
    );
    if (contractReset.status !== 0) fail("packed contract fixture could not reset claims before update coverage");

    const seedResource = "multi-claim-seed.txt";
    const seedClaim = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "claim",
          "--session",
          secondCreated.session_id,
          "--resource",
          seedResource,
          "--mode",
          "read",
          "--json",
        ],
        secondWorktree,
      ),
      "deterministic prior claim before multi-claim update",
    );
    if (seedClaim.ok !== true || seedClaim.claims?.length !== 1) {
      fail("installed session claim did not establish the deterministic prior claim set");
    }

    const multiUpdate = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "update",
          "--session",
          secondCreated.session_id,
          "--resource",
          "multi-claim-a.txt",
          "--mode",
          "exclusive-write",
          "--resource",
          "multi-claim-b.txt",
          "--mode",
          "exclusive-write",
          "--force",
          "--json",
        ],
        secondWorktree,
      ),
      "atomic multi-claim update",
    );
    if (
      multiUpdate.ok !== true ||
      multiUpdate.claims?.length !== 2 ||
      !multiUpdate.claims?.some(
        (entry) => entry.resource === "multi-claim-a.txt" && entry.mode === "exclusive-write",
      ) ||
      !multiUpdate.claims?.some((entry) => entry.resource === "multi-claim-b.txt" && entry.mode === "exclusive-write")
    ) {
      fail("installed session update did not atomically replace the claim set with both requested claims");
    }
    if (
      multiUpdate.added?.length !== 2 ||
      !multiUpdate.added?.some((entry) => entry.resource === "multi-claim-a.txt") ||
      !multiUpdate.added?.some((entry) => entry.resource === "multi-claim-b.txt") ||
      multiUpdate.released?.length !== 1 ||
      multiUpdate.released?.[0]?.claim_id !== seedClaim.claims?.[0]?.claim_id
    ) {
      fail("installed session update did not report the exact added/released claim evidence for the replacement");
    }

    const interleavedUpdate = invokeInstalled(
      [
        "session",
        "update",
        "--session",
        secondCreated.session_id,
        "--resource",
        "multi-claim-interleaved.txt",
        "--session",
        secondCreated.session_id,
        "--mode",
        "exclusive-write",
        "--json",
      ],
      secondWorktree,
    );
    const interleavedUpdateJson = parseInstalledJson(interleavedUpdate, "interleaved-option multi-claim update");
    if (interleavedUpdate.status !== 2 || interleavedUpdateJson.code !== "INVALID_ARGUMENT") {
      fail("installed session update accepted --session interleaved between --resource and its --mode");
    }

    const doublePairClaim = invokeInstalled(
      [
        "session",
        "claim",
        "--session",
        secondCreated.session_id,
        "--resource",
        "multi-claim-d.txt",
        "--mode",
        "read",
        "--resource",
        "multi-claim-e.txt",
        "--mode",
        "write",
        "--json",
      ],
      secondWorktree,
    );
    const doublePairClaimJson = parseInstalledJson(doublePairClaim, "double-pair claim rejection");
    if (doublePairClaim.status !== 2 || doublePairClaimJson.code !== "INVALID_ARGUMENT") {
      fail("installed session claim silently accepted more than one --resource/--mode pair");
    }

    const conflictingUpdate = invokeInstalled(
      [
        "session",
        "update",
        "--session",
        secondCreated.session_id,
        "--resource",
        "multi-claim-conflict.txt",
        "--mode",
        "write",
        "--resource",
        "multi-claim-conflict.txt",
        "--mode",
        "exclusive-write",
        "--force",
        "--json",
      ],
      secondWorktree,
    );
    const conflictingUpdateJson = parseInstalledJson(conflictingUpdate, "conflicting multi-claim update");
    if (conflictingUpdate.status !== 3 || conflictingUpdateJson.code !== "CONTRADICTORY_CLAIM") {
      fail("installed session update did not reject an internally conflicting desired claim set");
    }
    const claimsAfterConflict = parseInstalledJson(
      invokeInstalled(["session", "claims", "--session", secondCreated.session_id, "--json"], secondWorktree),
      "claims after rejected update",
    );
    if (
      claimsAfterConflict.ok !== true ||
      claimsAfterConflict.claims?.length !== 2 ||
      !claimsAfterConflict.claims?.some((entry) => entry.resource === "multi-claim-a.txt") ||
      !claimsAfterConflict.claims?.some((entry) => entry.resource === "multi-claim-b.txt")
    ) {
      fail("a rejected multi-claim update mutated the persisted pre-update claim set");
    }

    const repeatedUpdate = parseInstalledJson(
      invokeInstalled(
        [
          "session",
          "update",
          "--session",
          secondCreated.session_id,
          "--resource",
          "multi-claim-a.txt",
          "--mode",
          "exclusive-write",
          "--resource",
          "multi-claim-b.txt",
          "--mode",
          "exclusive-write",
          "--force",
          "--json",
        ],
        secondWorktree,
      ),
      "idempotent multi-claim update repeat",
    );
    if (
      repeatedUpdate.ok !== true ||
      repeatedUpdate.idempotent !== true ||
      repeatedUpdate.added?.length !== 0 ||
      repeatedUpdate.released?.length !== 0
    ) {
      fail("repeating the same desired multi-claim set was not idempotent with empty added/released evidence");
    }

    const secondClosed = invokeInstalled(
      ["session", "close", "--session", secondCreated.session_id, "--json"],
      lifecycleRepository,
    );
    if (secondClosed.status !== 0) fail("second installed session did not close safely");
    for (const session of concurrentCreated) {
      const closedConcurrent = invokeInstalled(
        ["session", "close", "--session", session.session_id, "--json"],
        lifecycleRepository,
      );
      if (closedConcurrent.status !== 0) fail(`concurrent session ${session.session_id} did not close safely`);
    }

    const prunableWorktree = path.join(installDirectory, "prunable-worktree");
    const prunableSession = parseInstalledJson(
      invokeInstalled(
        ["session", "create", "--branch", "feature/installed-prunable", "--worktree", prunableWorktree, "--json"],
        lifecycleRepository,
      ),
      "prunable session create",
    );
    fs.rmSync(prunableWorktree, { recursive: true, force: true });
    const prunableDryRun = parseInstalledJson(
      invokeInstalled(["gc", "--dry-run", "--json"], lifecycleRepository),
      "prunable gc dry run",
    );
    if (
      prunableDryRun.ok !== true ||
      !prunableDryRun.candidates?.some((candidate) => candidate.session_id === prunableSession.session_id) ||
      prunableDryRun.cleaned?.length !== 0
    ) {
      fail("gc dry-run did not expose the prunable session without mutation");
    }
    const prunableApplied = parseInstalledJson(
      invokeInstalled(["gc", "--apply", "--json"], lifecycleRepository),
      "prunable gc apply",
    );
    if (
      prunableApplied.ok !== true ||
      !prunableApplied.cleaned?.some((session) => session.session_id === prunableSession.session_id) ||
      prunableApplied.blocked?.length !== 0
    ) {
      fail("gc apply did not safely clean the prunable session");
    }

    const detachedWorktree = path.join(installDirectory, "detached-worktree");
    run("git", ["worktree", "add", "--detach", detachedWorktree, "HEAD"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    const detachedGuard = invokeInstalled(["guard", "--json"], detachedWorktree);
    const detachedGuardJson = parseInstalledJson(detachedGuard, "detached guard");
    if (detachedGuard.status !== 3 || detachedGuardJson.code !== "DETACHED_HEAD") {
      fail("guard did not fail closed for a detached worktree");
    }
    run("git", ["worktree", "remove", "--force", detachedWorktree], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });

    const gc = parseInstalledJson(invokeInstalled(["gc", "--dry-run", "--json"], lifecycleRepository), "gc");
    if (gc.ok !== true || gc.candidates.length !== 0 || gc.cleaned.length !== 0) {
      fail("gc did not report a clean installed repository after close");
    }

    const doctor = parseInstalledJson(invokeInstalled(["doctor", "--json"], lifecycleRepository), "doctor");
    const reconciliation = doctor.checks?.find((check) => check.name === "reconciliation");
    if (
      doctor.ok !== true ||
      reconciliation?.status !== "ok" ||
      reconciliation.details?.clean !== true ||
      reconciliation.details?.issues?.length !== 0
    ) {
      fail("doctor did not report a clean packed registry/Git reconciliation");
    }

    const registryPath = path.join(lifecycleRepository, ".git", "nawabari", "session-registry.json");
    addClosedHistory(registryPath, 512, installDirectory);
    const boundedStatus = invokeInstalled(["status", "--json"], lifecycleRepository);
    const boundedStatusJson = parseInstalledJson(boundedStatus, "bounded status");
    const boundedList = invokeInstalled(["session", "list", "--json"], lifecycleRepository);
    const boundedListJson = parseInstalledJson(boundedList, "bounded session list");
    if (
      boundedStatus.status !== 0 ||
      boundedList.status !== 0 ||
      boundedStatusJson.sessions?.length !== 0 ||
      boundedListJson.sessions?.length !== 0 ||
      boundedStatusJson.closed_count !== 512 + 13 ||
      boundedListJson.closed_count !== 512 + 13 ||
      boundedStatusJson.history_available !== true ||
      boundedListJson.history_available !== true ||
      boundedStatus.stdout.length > 4_000 ||
      boundedList.stdout.length > 4_000
    ) {
      fail("default installed status/session list scaled with closed history");
    }
    const historyPage = parseInstalledJson(
      invokeInstalled(
        ["session", "list", "--history", "--limit", "8", "--offset", "16", "--json"],
        lifecycleRepository,
      ),
      "installed session history page",
    );
    if (
      historyPage.ok !== true ||
      historyPage.sessions?.length !== 8 ||
      historyPage.limit !== 8 ||
      historyPage.offset !== 16 ||
      historyPage.truncated !== true ||
      historyPage.next_offset !== 24
    ) {
      fail("installed session history did not expose deterministic continuation metadata");
    }
    fs.writeFileSync(registryPath, "{not-json\n");
    const corruptStatus = invokeInstalled(["status", "--json"], lifecycleRepository);
    const corruptStatusJson = parseInstalledJson(corruptStatus, "corrupt registry status");
    if (corruptStatus.status !== 3 || corruptStatusJson.code !== "REGISTRY_CORRUPT") {
      fail("status did not fail closed for a corrupt installed registry");
    }

    console.log("smoke test passed.");
  } finally {
    fs.rmSync(installDirectory, { recursive: true, force: true });
    if (ownsTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main().catch((error) => {
  if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
});
