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
    if (capabilitiesResult.stderr.trim().length > 0) fail("capabilities --json wrote decorative output to stderr");

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
    const parseInstalledJson = (result, label) => {
      if (result.stdout.trim().length === 0) fail(`${label} emitted no JSON`);
      try {
        return JSON.parse(result.stdout);
      } catch {
        fail(`${label} emitted invalid JSON: ${result.stdout}`);
      }
    };

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
    const claims = parseInstalledJson(
      invokeInstalled(["session", "claims", "--session", created.session_id, "--json"], lifecycleWorktree),
      "resource claims",
    );
    if (claims.ok !== true || claims.claims?.length !== 1 || claims.claims[0]?.claim_id !== claim.claims[0].claim_id) {
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

    fs.writeFileSync(path.join(lifecycleWorktree, "recoverable.txt"), "keep until close is safe\n");
    const dirtyClose = invokeInstalled(
      ["session", "close", "--session", created.session_id, "--json"],
      lifecycleRepository,
    );
    const dirtyCloseJson = parseInstalledJson(dirtyClose, "dirty close");
    if (dirtyClose.status !== 3 || dirtyCloseJson.code !== "DIRTY_WORKTREE") {
      fail("dirty close did not fail closed");
    }
    fs.rmSync(path.join(lifecycleWorktree, "recoverable.txt"), { force: true });

    const closed = invokeInstalled(
      ["session", "close", "--session", created.session_id, "--json"],
      lifecycleRepository,
    );
    const closedJson = parseInstalledJson(closed, "safe close");
    if (closed.status !== 0 || closedJson.ok !== true || closedJson.session?.state !== "closed") {
      fail("safe close did not release the installed session");
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
