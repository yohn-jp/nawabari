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
      if (versionResult.stdout.trim().length === 0) fail(`launcher "${name}" --version printed nothing`);
    }

    const gitEnvironment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    const installedBinary = path.join(binDirectory, "git-paw");
    // Git reserves `git <external-command> --help` for man-page lookup, so
    // version is the portable discovery probe that does not require a manpage.
    const gitPawResult = spawnSync("git", ["paw", "--version"], {
      cwd: installDirectory,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (gitPawResult.error) fail(`git paw failed to start: ${gitPawResult.error.message}`);
    if (gitPawResult.status !== 0) fail(`git paw --version exited ${gitPawResult.status}, expected 0`);
    if (gitPawResult.stdout.trim() !== String(packageJson.version)) {
      fail("git paw --version did not match the installed package metadata");
    }

    const jsonResult = spawnSync(path.join(binDirectory, "git-paw"), ["session", "id", "--json"], {
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
    run("git", ["config", "user.email", "git-paw-smoke@example.invalid"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    run("git", ["config", "user.name", "GitPaw Smoke"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["config", "commit.gpgsign", "false"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["config", "core.hooksPath", "/dev/null"], { cwd: lifecycleRepository, env: gitEnvironment });
    fs.writeFileSync(path.join(lifecycleRepository, "README.md"), "smoke fixture\n");
    run("git", ["add", "README.md"], { cwd: lifecycleRepository, env: gitEnvironment });
    run("git", ["commit", "-m", "initial"], { cwd: lifecycleRepository, env: gitEnvironment });

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
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
      });
    const parseInstalledJson = (result, label) => {
      if (result.stdout.trim().length === 0) fail(`${label} emitted no JSON`);
      try {
        return JSON.parse(result.stdout);
      } catch {
        fail(`${label} emitted invalid JSON: ${result.stdout}`);
      }
    };

    console.log("running the installed GitPaw session lifecycle...");
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

    const detachedWorktree = path.join(installDirectory, "detached-worktree");
    run("git", ["worktree", "add", "--detach", detachedWorktree, "HEAD"], {
      cwd: lifecycleRepository,
      env: gitEnvironment,
    });
    const detachedGuard = invokeInstalled(["guard", "--json"], detachedWorktree);
    const detachedGuardJson = parseInstalledJson(detachedGuard, "detached guard");
    if (detachedGuard.status !== 3 || detachedGuardJson.code !== "INVALID_WORKTREE") {
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

    const registryPath = path.join(lifecycleRepository, ".git", "git-paw", "session-registry.json");
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
