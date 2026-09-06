#!/usr/bin/env node
// Build/package validation deliberately passes one concrete tarball through
// content checks and the isolated consumer smoke test. A second pnpm pack is
// never allowed to hide a stale dist or packaging mismatch.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function parseArgs(argv) {
  const evidenceOutputIndex = argv.indexOf("--evidence-output");
  const evidenceOutput = evidenceOutputIndex === -1 ? undefined : argv[evidenceOutputIndex + 1];
  if (evidenceOutputIndex !== -1 && evidenceOutput === undefined) {
    throw new Error("--evidence-output requires a path");
  }
  return {
    keepTarball: argv.includes("--keep-tarball"),
    evidenceOutput,
    requireProtectedExecution: argv.includes("--require-protected-execution"),
  };
}

function assertPackContents(packInfo) {
  if (!Array.isArray(packInfo.files)) throw new Error("pnpm pack did not report package contents");
  const packedFiles = packInfo.files.map((entry) => entry.path);
  const allowed = new Set(["package.json", "README.md", "LICENSE"]);
  for (const file of packedFiles) {
    const runtimeArtifact =
      file.startsWith("dist/") && [".js", ".js.map", ".d.ts", ".d.ts.map"].some((suffix) => file.endsWith(suffix));
    const sourceOrTestPath = /(?:^|\/)(?:src|scripts?|test|tests)(?:\/|$)|\.(?:test|spec)\.[^/]+$/u.test(file);
    if (sourceOrTestPath || (!allowed.has(file) && !runtimeArtifact)) {
      throw new Error(`unexpected file in package tarball: ${file}`);
    }
  }

  for (const binPath of Object.values(packageJson.bin ?? {})) {
    if (!packedFiles.includes(binPath)) {
      throw new Error(`bin entry "${binPath}" is not included in the packed tarball`);
    }
    const stat = fs.statSync(path.join(repoRoot, binPath));
    if ((stat.mode & 0o100) === 0) {
      throw new Error(`bin entry "${binPath}" is not executable`);
    }
  }
}

function parsePackInfo(output) {
  // pnpm runs the package's prepack lifecycle before emitting --json. The
  // lifecycle's stdout is not package metadata, so parse the JSON object from
  // the first line that starts the pack report rather than weakening the
  // exact-artifact check or invoking a second pack command.
  const match = output.match(/^\{\s*"name"\s*:/mu);
  if (match?.index === undefined) throw new Error("pnpm pack --json did not emit a pack report");
  try {
    return JSON.parse(output.slice(match.index));
  } catch (error) {
    throw new Error(
      `pnpm pack --json emitted invalid metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sourceRevision() {
  return run("git", ["rev-parse", "HEAD"]).stdout.trim();
}

function writeEvidence(outputPath, artifact) {
  const evidence = {
    schema_version: 1,
    contract_id: "nawabari.packed-standalone-protected-execution.v1",
    source_revision: sourceRevision(),
    artifact,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      kernel: os.release(),
      node: process.version,
      pnpm: run("pnpm", ["--version"]).stdout.trim(),
      npm: run("npm", ["--version"]).stdout.trim(),
      git: run("git", ["--version"]).stdout.trim(),
      bubblewrap: run("bwrap", ["--version"]).stdout.trim(),
    },
    installation: {
      mode: "fresh temporary consumer",
      command: "npm install --offline --ignore-scripts --no-audit --no-fund --no-save <artifact>",
      source_tree_runtime_dependency: false,
      source_or_test_module_dependency: false,
      external_runtime_dependencies: {
        mottainai: false,
        github: false,
        gh: false,
        llm: false,
        network: false,
      },
    },
    public_surface: {
      installed_bin: "nawabari",
      protected_route: "session run",
      lifecycle: ["session create", "session id", "session claim", "checkpoint", "commit", "push", "session close"],
      discovery: ["capabilities --json", "doctor --json"],
    },
    protected_execution: {
      required: true,
      enforce: true,
      fail_closed: true,
      ambient_fallback: false,
      network_mode: "inherited",
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

function main() {
  const { keepTarball, evidenceOutput, requireProtectedExecution } = parseArgs(process.argv.slice(2));
  const tarballName = `${packageJson.name}-${packageJson.version}.tgz`;
  const tarballPath = path.join(repoRoot, tarballName);
  fs.rmSync(tarballPath, { force: true });

  try {
    const packResult = run("pnpm", ["pack", "--json", "--pack-destination", repoRoot]);
    const packInfo = parsePackInfo(packResult.stdout);
    if (path.basename(packInfo.filename) !== tarballName) {
      throw new Error(`pnpm produced ${packInfo.filename}; expected ${tarballName}`);
    }
    assertPackContents(packInfo);

    run(process.execPath, ["scripts/validate-release-tarball.mjs", tarballPath]);
    const artifact = {
      pack_command: "pnpm pack",
      package: packInfo.name,
      version: packInfo.version,
      filename: tarballName,
      bytes: fs.statSync(tarballPath).size,
      sha256: sha256(tarballPath),
      files: packInfo.files.map((entry) => entry.path),
    };
    console.log(`packed artifact identity: ${JSON.stringify(artifact)}`);
    console.log(`package contents verified in exact tarball: ${tarballName}`);
    const smokeArgs = ["scripts/smoke-test.mjs", "--tarball", tarballPath];
    if (requireProtectedExecution) {
      // Protected evidence is intentionally strict. An unavailable
      // capability is a failed product gate, never a skip or an ambient
      // fallback.
      smokeArgs.push("--require-protected-execution");
    }
    run(process.execPath, smokeArgs, { stdio: "inherit" });
    if (requireProtectedExecution) {
      const reportPath = path.resolve(
        evidenceOutput ?? path.join(repoRoot, "test-artifacts", "packed-standalone-protected-execution.json"),
      );
      writeEvidence(reportPath, artifact);
      console.log(`packed standalone protected-execution evidence recorded: ${reportPath}`);
    }
  } finally {
    if (!keepTarball) fs.rmSync(tarballPath, { force: true });
  }
}

main();
