import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { defaultGit, resolveRepositoryContext, type RepositoryContext } from "../git.js";
import { isSessionRegistryError } from "../errors.js";
import { SessionRegistry } from "../session-registry.js";
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

function repositoryInfo(context: RepositoryContext): RepositoryInfo {
  return {
    top_level: context.worktreePath,
    common_dir: context.commonGitDirectory,
    registry_path: path.join(context.commonGitDirectory, "nawabari", "session-registry.json"),
  };
}

async function inspectRegistry(repository: RepositoryInfo, context: RepositoryContext): Promise<DoctorCheck> {
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
      const sessions = new SessionRegistry({ repository: context, git: defaultGit }).list();
      return check("registry", "ok", null, "The Nawabari registry is readable and valid.", {
        path: repository.registry_path,
        bytes: contents.length,
        sessions: sessions.length,
      });
    } catch (error: unknown) {
      const code = doctorErrorCode(error, "REGISTRY_UNREADABLE");
      return check("registry", "error", code, "The Nawabari registry failed authoritative validation.", {
        path: repository.registry_path,
        ...(isSessionRegistryError(error) ? { reason: error.code } : {}),
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

  try {
    const version = defaultGit.run(["--version"], cwd);
    checks.push(check("git", "ok", null, "Git is available.", { version }));
  } catch (error: unknown) {
    checks.push(
      check("git", "error", doctorErrorCode(error, "GIT_UNAVAILABLE"), "Git is not available to the local CLI.", {
        command: "git --version",
        ...(isSessionRegistryError(error) ? { reason: error.code } : {}),
      }),
    );
    checks.push(
      check("repository", "not_applicable", null, "Repository resolution was skipped because Git is unavailable."),
    );
    checks.push(
      check("registry", "not_applicable", null, "Registry inspection was skipped because Git is unavailable."),
    );
    return success({ ok: false, checks, repository: null });
  }

  let repository: RepositoryInfo | null = null;
  try {
    const context = resolveRepositoryContext({ cwd, git: defaultGit });
    repository = repositoryInfo(context);
    checks.push(
      check("repository", "ok", null, "Repository and common Git directory resolved.", {
        top_level: repository.top_level,
        common_dir: repository.common_dir,
      }),
    );
    checks.push(await inspectRegistry(repository, context));
  } catch (error: unknown) {
    checks.push(
      check(
        "repository",
        "error",
        doctorErrorCode(error, "NOT_GIT_REPOSITORY"),
        "The current directory is not a valid Git repository context.",
        {
          ...(isSessionRegistryError(error) ? { reason: error.code, ...error.details } : {}),
        },
      ),
    );
    checks.push(check("registry", "not_applicable", null, "Registry inspection was skipped outside a Git repository."));
  }

  const hasError = checks.some((item) => item.status === "error");
  return success({ ok: !hasError, checks, repository });
}

function doctorErrorCode(error: unknown, fallback: ErrorCode): ErrorCode {
  if (!isSessionRegistryError(error)) return fallback;
  const code = error.code;
  if (code === "GIT_SPAWN_FAILED") return "GIT_SPAWN_FAILED";
  if (code === "GIT_TIMEOUT") return "GIT_TIMEOUT";
  if (code === "GIT_OUTPUT_LIMIT") return "GIT_OUTPUT_LIMIT";
  if (code === "GIT_COMMAND_FAILED") return "GIT_COMMAND_FAILED";
  if (code === "NOT_A_GIT_REPOSITORY") return "NOT_GIT_REPOSITORY";
  if (code === "REPOSITORY_IDENTITY_AMBIGUOUS") return "GIT_STATE_AMBIGUOUS";
  if (code === "REGISTRY_CORRUPT" || code === "UNSUPPORTED_SCHEMA_VERSION") return "REGISTRY_CORRUPT";
  if (code === "REGISTRY_REPOSITORY_MISMATCH") return "INVALID_REGISTRY";
  if (code === "INVALID_BRANCH_ID") return "INVALID_BRANCH";
  if (code === "INVALID_WORKTREE_PATH") return "INVALID_WORKTREE";
  if (code === "WORKTREE_IDENTITY_AMBIGUOUS") return "GIT_STATE_AMBIGUOUS";
  return fallback;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
