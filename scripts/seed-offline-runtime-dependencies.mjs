import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_OUTPUT_BYTES = 64 * 1024;

function bounded(value, limit = 2_000) {
  return String(value ?? "").slice(0, limit);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${bounded(result.stderr)}`);
  }
  return result;
}

function packageMetadata(stdout, dependencyName) {
  let metadata;
  try {
    metadata = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `local ${dependencyName} packaging did not emit valid package metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const info = Array.isArray(metadata) ? metadata[0] : metadata[dependencyName];
  if (info?.name !== dependencyName || typeof info.filename !== "string") {
    throw new Error(`local ${dependencyName} packaging emitted unexpected package metadata`);
  }
  return info;
}

/**
 * Seed npm overrides for every declared runtime dependency from the checked
 * out package manager installation. The consumer can then remain fully
 * offline while still installing the packed artifact through npm.
 */
export function seedOfflineRuntimeDependencyOverrides({ packageRoot, seedDirectory }) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  const overrides = {};

  for (const dependencyName of dependencies) {
    const dependencyDirectory = path.join(packageRoot, "node_modules", dependencyName);
    if (!fs.existsSync(dependencyDirectory)) {
      throw new Error(`local runtime dependency is not installed: ${dependencyName}`);
    }
    const result = run(
      "npm",
      ["pack", "--json", dependencyDirectory, "--pack-destination", seedDirectory],
      packageRoot,
    );
    const info = packageMetadata(result.stdout, dependencyName);
    overrides[dependencyName] = path.join(seedDirectory, info.filename);
  }

  return overrides;
}
