import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistryError } from "./errors.js";
import { RepositoryRegistry, createEmptyRegistry, parseRegistryDocument, validateRegistryDocument } from "./store.js";
import type { RegistryDocument, SessionRecord } from "./types.js";

const childModuleUrl = new URL("./store.ts", import.meta.url).href;
const testRepositoryId = "repository-under-test";

interface ChildResult {
  ok: boolean;
  code?: string;
  message?: string;
}

interface ChildExit extends ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

const childScript = `
import { RepositoryRegistry } from ${JSON.stringify(childModuleUrl)};

const operation = process.env.OPERATION;
const sessionId = process.env.SESSION_ID;
const commonGitDirectory = process.env.COMMON_GIT;
const holdMs = Number(process.env.HOLD_MS ?? "0");
const crashBeforeRename = process.env.CRASH_BEFORE_RENAME === "1";
const registry = new RepositoryRegistry({
  commonGitDirectory,
  repositoryId: ${JSON.stringify(testRepositoryId)},
  lock: {
    staleAfterMs: Number(process.env.STALE_AFTER_MS ?? "100"),
    acquireTimeoutMs: Number(process.env.ACQUIRE_TIMEOUT_MS ?? "10000"),
    retryDelayMs: 2,
  },
  atomicWriteHooks: crashBeforeRename
    ? { beforeRename: () => process.kill(process.pid, "SIGKILL") }
    : undefined,
});

const now = new Date().toISOString();
const record = {
  schemaVersion: 1,
  sessionId,
  repositoryId: ${JSON.stringify(testRepositoryId)},
  worktreePath: "/tmp/gitpaw-test-worktrees/" + sessionId,
  branch: process.env.BRANCH ?? ("branch/" + sessionId),
  state: "active",
  createdAt: now,
  updatedAt: now,
};

try {
  if (holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
  await registry[operation]((draft) => {
    draft.sessions.push(record);
    return { sessionId };
  });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    code: error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  }));
}
`;

async function runChild(commonGitDirectory: string, environment: Record<string, string>): Promise<ChildExit> {
  return await new Promise<ChildExit>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        COMMON_GIT: commonGitDirectory,
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectChild);
    child.on("close", (exitCode, signal) => {
      const output = stdout.trim().split("\n").at(-1);
      let result: ChildResult = { ok: false, code: "NO_RESULT", message: stdout };
      if (output !== undefined && output.length > 0) {
        try {
          const parsed: unknown = JSON.parse(output);
          if (typeof parsed === "object" && parsed !== null && "ok" in parsed && typeof parsed.ok === "boolean") {
            const parsedRecord = parsed as Record<string, unknown>;
            result = {
              ok: parsed.ok,
              ...(typeof parsedRecord.code === "string" ? { code: parsedRecord.code } : {}),
              ...(typeof parsedRecord.message === "string" ? { message: parsedRecord.message } : {}),
            };
          }
        } catch {
          result = { ok: false, code: "INVALID_RESULT", message: output };
        }
      }
      resolveChild({ ...result, exitCode, signal, stderr });
    });
  });
}

async function withCommonGitDirectory<T>(callback: (commonGitDirectory: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gitpaw-registry-"));
  const commonGitDirectory = join(root, "common-git");
  await mkdir(commonGitDirectory, { recursive: true });
  try {
    return await callback(commonGitDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRecord(sessionId: string, branch = `branch/${sessionId}`): SessionRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    repositoryId: testRepositoryId,
    worktreePath: `/tmp/gitpaw-test-worktrees/${sessionId}`,
    branch,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function createRegistry(
  commonGitDirectory: string,
  extra: Partial<ConstructorParameters<typeof RepositoryRegistry>[0]> = {},
) {
  return new RepositoryRegistry({
    commonGitDirectory,
    repositoryId: testRepositoryId,
    lock: {
      staleAfterMs: 30,
      acquireTimeoutMs: 10_000,
      retryDelayMs: 2,
    },
    ...extra,
  });
}

test("persists a versioned document visible to another registry instance", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const first = createRegistry(commonGitDirectory);
    await first.create((draft) => {
      draft.sessions.push(makeRecord("session-1"));
    });

    const second = createRegistry(commonGitDirectory);
    const document = await second.read();
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.repositoryId, testRepositoryId);
    assert.deepEqual(
      document.sessions.map((session) => session.sessionId),
      ["session-1"],
    );
  });
});

test("readers reject corrupt and unsupported authoritative state", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const registry = createRegistry(commonGitDirectory);
    await mkdir(registry.registryDirectory, { recursive: true });
    await writeFile(registry.registryPath, '{"schemaVersion":1', "utf8");
    await assert.rejects(registry.read(), (error: unknown) => {
      return error instanceof RegistryError && error.code === "REGISTRY_CORRUPT";
    });

    await writeFile(
      registry.registryPath,
      JSON.stringify({ ...createEmptyRegistry(testRepositoryId), schemaVersion: 99 }),
      "utf8",
    );
    await assert.rejects(registry.read(), (error: unknown) => {
      return error instanceof RegistryError && error.code === "REGISTRY_UNSUPPORTED_SCHEMA";
    });
  });
});

test("duplicate active session, worktree, and branch ownership fails closed", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const registry = createRegistry(commonGitDirectory);
    await registry.create((draft) => {
      draft.sessions.push(makeRecord("session-1", "branch/shared"));
    });

    await assert.rejects(
      registry.claim((draft) => {
        draft.sessions.push(makeRecord("session-1", "branch/other"));
      }),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_DUPLICATE_SESSION",
    );
    await assert.rejects(
      registry.claim((draft) => {
        draft.sessions.push(makeRecord("session-2", "branch/shared"));
      }),
      (error: unknown) =>
        (error instanceof RegistryError && error.code === "REGISTRY_DUPLICATE_WORKTREE") ||
        (error instanceof RegistryError && error.code === "REGISTRY_DUPLICATE_BRANCH"),
    );

    const document = await registry.read();
    assert.equal(document.sessions.length, 1);
  });
});

test("a failed write leaves the previous complete document authoritative", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const registry = createRegistry(commonGitDirectory);
    await registry.create((draft) => {
      draft.sessions.push(makeRecord("base"));
    });

    const failingRegistry = createRegistry(commonGitDirectory, {
      atomicWriteHooks: {
        beforeRename: () => {
          throw new Error("simulated process failure before rename");
        },
      },
    });
    await assert.rejects(
      failingRegistry.create((draft) => {
        draft.sessions.push(makeRecord("not-committed"));
      }),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_MUTATION_FAILED",
    );

    const document = await registry.read();
    assert.deepEqual(
      document.sessions.map((session) => session.sessionId),
      ["base"],
    );
  });
});

test("concurrent independent creates serialize across real processes", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runChild(commonGitDirectory, {
          OPERATION: "create",
          SESSION_ID: `concurrent-${index}`,
          HOLD_MS: "5",
        }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 10, JSON.stringify(results));

    const registry = createRegistry(commonGitDirectory);
    const document = await registry.read();
    assert.equal(document.sessions.length, 10);
    assert.equal(new Set(document.sessions.map((session) => session.sessionId)).size, 10);
  });
});

test("create, claim, close, release, and gc use one mutation boundary", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const operations = ["create", "claim", "close", "release", "gc"];
    const results = await Promise.all(
      operations.map((operation, index) =>
        runChild(commonGitDirectory, {
          OPERATION: operation,
          SESSION_ID: `operation-${index}`,
        }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, operations.length, JSON.stringify(results));

    const document = await createRegistry(commonGitDirectory).read();
    assert.equal(document.sessions.length, operations.length);
  });
});

test("concurrent claims of one branch have exactly one valid winner", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runChild(commonGitDirectory, {
          OPERATION: "claim",
          SESSION_ID: `claim-${index}`,
          BRANCH: "branch/one-winner",
        }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(
      results.filter((result) => result.code === "REGISTRY_DUPLICATE_BRANCH").length,
      9,
      JSON.stringify(results),
    );

    const registry = createRegistry(commonGitDirectory);
    const document = await registry.read();
    assert.equal(document.sessions.length, 1);
    assert.equal(document.sessions[0]?.branch, "branch/one-winner");
  });
});

test("a killed writer leaves no accepted partial state and allows safe retry", async () => {
  await withCommonGitDirectory(async (commonGitDirectory) => {
    const registry = createRegistry(commonGitDirectory);
    await registry.create((draft) => {
      draft.sessions.push(makeRecord("base"));
    });

    const crashed = await runChild(commonGitDirectory, {
      OPERATION: "create",
      SESSION_ID: "killed-writer",
      CRASH_BEFORE_RENAME: "1",
      STALE_AFTER_MS: "20",
    });
    assert.equal(crashed.signal, "SIGKILL", JSON.stringify(crashed));

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    const retry = createRegistry(commonGitDirectory);
    await retry.create((draft) => {
      draft.sessions.push(makeRecord("retry"));
    });

    const document = await retry.read();
    assert.deepEqual(document.sessions.map((session) => session.sessionId).sort(), ["base", "retry"]);
    const files = await readdir(registry.registryDirectory);
    assert.ok(
      files.some((file) => file.endsWith(".tmp")),
      "the killed writer should leave an ignored temp file",
    );
    const authoritative = await readFile(registry.registryPath, "utf8");
    assert.doesNotMatch(authoritative, /killed-writer/);
  });
});

test("document validation rejects duplicate active resources but permits released history", () => {
  const first = makeRecord("first", "branch/shared");
  const second = { ...makeRecord("second", "branch/shared"), state: "closed" as const };
  const document: RegistryDocument = {
    schemaVersion: 1,
    repositoryId: testRepositoryId,
    updatedAt: new Date().toISOString(),
    sessions: [first, second],
  };
  assert.doesNotThrow(() => validateRegistryDocument(document, testRepositoryId));
  assert.deepEqual(parseRegistryDocument(document, testRepositoryId).sessions.length, 2);
});
