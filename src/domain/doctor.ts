import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { SessionRegistry } from "../session-registry.js";
import { isSessionRegistryError } from "../errors.js";
import { success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";

export type DoctorCheckStatus = "ok" | "warning" | "error" | "not_configured" | "not_applicable";

export type DoctorCheck = {
  name: "git" | "repository" | "registry" | "runtime";
  status: DoctorCheckStatus;
  code: ErrorCode | null;
  message: string;
  details: JsonObject;
};

export type RepositoryInfo = {
  top_level: string;
  common_dir: string;
  registry_path: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  repository: RepositoryInfo | null;
};

type ProcessResult = {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

function runGit(args: string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ exit_code: null, stdout, stderr, error: "git command timed out" });
    }, 10_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exit_code: exitCode, stdout, stderr, error: null });
    });
  });
}

function supportsRuntime(version: string): boolean {
  const [majorText, minorText] = version.split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  return Number.isFinite(major) && Number.isFinite(minor) && (major > 22 || (major === 22 && minor >= 13));
}

function check(
  name: DoctorCheck["name"],
  status: DoctorCheckStatus,
  code: ErrorCode | null,
  message: string,
  details: JsonObject = {},
): DoctorCheck {
  return { name, status, code, message, details };
}

function parseRepository(stdout: string, cwd: string): RepositoryInfo | null {
  const lines = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.trim());
  if (lines.length < 2 || lines[0] === "" || lines[1] === "") return null;
  const topLevel = path.resolve(cwd, lines[0]);
  const commonDir = path.resolve(cwd, lines[1]);
  return {
    top_level: topLevel,
    common_dir: commonDir,
    registry_path: path.join(commonDir, "nawabari", "session-registry.json"),
  };
}

async function inspectRegistry(repository: RepositoryInfo): Promise<DoctorCheck> {
  try {
    const contents = await readFile(repository.registry_path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return check("registry", "error", "REGISTRY_CORRUPT", "The Nawabari registry is not valid JSON.", {
        path: repository.registry_path,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return check("registry", "error", "INVALID_REGISTRY", "The Nawabari registry must contain a JSON object.", {
        path: repository.registry_path,
      });
    }
    try {
      const registry = new SessionRegistry({ cwd: repository.top_level });
      const sessions = registry.list();
      return check("registry", "ok", null, "The Nawabari registry is readable and valid.", {
        path: repository.registry_path,
        bytes: contents.length,
        sessions: sessions.length,
      });
    } catch (error: unknown) {
      const code =
        isSessionRegistryError(error) && error.code === "UNSUPPORTED_SCHEMA_VERSION"
          ? "REGISTRY_CORRUPT"
          : isSessionRegistryError(error) && error.code === "REGISTRY_REPOSITORY_MISMATCH"
            ? "INVALID_REGISTRY"
            : "REGISTRY_UNREADABLE";
      return check("registry", "error", code, "The Nawabari registry failed authoritative validation.", {
        path: repository.registry_path,
      });
    }
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return check("registry", "not_configured", null, "The Nawabari session registry is not initialized.", {
        path: repository.registry_path,
      });
    }
    return check("registry", "error", "REGISTRY_UNREADABLE", "The Nawabari registry cannot be read.", {
      path: repository.registry_path,
    });
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function runDoctor(cwd = process.cwd()): Promise<DomainResult<DoctorReport>> {
  const checks: DoctorCheck[] = [];
  const runtimeOk = supportsRuntime(process.versions.node);
  checks.push(
    runtimeOk
      ? check("runtime", "ok", null, "The Nawabari runtime meets the supported Node.js version.", {
          node: process.versions.node,
        })
      : check("runtime", "error", "UNSUPPORTED_RUNTIME", "The Node.js runtime is below the supported version.", {
          node: process.versions.node,
        }),
  );

  const gitVersion = await runGit(["--version"], cwd);
  if (gitVersion.exit_code !== 0) {
    checks.push(
      check("git", "error", "GIT_UNAVAILABLE", "Git is not available to the local CLI.", {
        command: "git --version",
        reason: gitVersion.error ?? gitVersion.stderr.trim(),
      }),
    );
    checks.push(
      check("repository", "not_applicable", null, "Repository resolution was skipped because Git is unavailable."),
    );
    checks.push(
      check("registry", "not_applicable", null, "Registry inspection was skipped because Git is unavailable."),
    );
  } else {
    checks.push(check("git", "ok", null, "Git is available.", { version: gitVersion.stdout.trim() }));
    const repositoryResult = await runGit(["rev-parse", "--show-toplevel", "--git-common-dir"], cwd);
    const repository = repositoryResult.exit_code === 0 ? parseRepository(repositoryResult.stdout, cwd) : null;
    if (repository === null) {
      checks.push(
        check("repository", "error", "NOT_GIT_REPOSITORY", "The current directory is not a Git repository.", {
          command: "git rev-parse --show-toplevel --git-common-dir",
          reason: repositoryResult.stderr.trim(),
        }),
      );
      checks.push(
        check("registry", "not_applicable", null, "Registry inspection was skipped outside a Git repository."),
      );
    } else {
      checks.push(
        check("repository", "ok", null, "Repository and common Git directory resolved.", {
          top_level: repository.top_level,
          common_dir: repository.common_dir,
        }),
      );
      checks.push(await inspectRegistry(repository));
    }

    const hasError = checks.some((item) => item.status === "error");
    return success({ ok: !hasError, checks, repository });
  }

  const hasError = checks.some((item) => item.status === "error");
  return success({ ok: !hasError, checks, repository: null });
}
