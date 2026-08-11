import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistryError } from "./errors.js";
import { RegistryMutationBoundary, type RegistryMutationBoundaryOptions } from "./store.js";
import type { RegistryCodec } from "./types.js";

const childModuleUrl = new URL("./store.ts", import.meta.url).href;
const testRepositoryId = "repository-under-test";

interface TestSession {
  schemaVersion: 1;
  sessionId: string;
  repositoryId: string;
  worktreePath: string;
  branch: string;
  state: "active" | "closed";
  createdAt: string;
  updatedAt: string;
}

interface TestState {
  schemaVersion: 1;
  repositoryId: string;
  updatedAt: string;
  sessions: TestSession[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function fixtureError(
  message: string,
  code: "REGISTRY_CORRUPT" | "REGISTRY_UNSUPPORTED_SCHEMA" = "REGISTRY_CORRUPT",
): RegistryError {
  return new RegistryError(code, message);
}

function validateFixture(state: TestState): void {
  if (state.schemaVersion !== 1) {
    throw fixtureError("unsupported fixture schema", "REGISTRY_UNSUPPORTED_SCHEMA");
  }
  if (state.repositoryId !== testRepositoryId || !isString(state.updatedAt) || !Array.isArray(state.sessions)) {
    throw fixtureError("invalid fixture state");
  }
  const sessionIds = new Set<string>();
  const worktrees = new Map<string, string>();
  const branches = new Map<string, string>();
  for (const [index, session] of state.sessions.entries()) {
    if (
      !isRecord(session) ||
      session.schemaVersion !== 1 ||
      !isString(session.sessionId) ||
      session.repositoryId !== testRepositoryId ||
      !isString(session.worktreePath) ||
      !isString(session.branch) ||
      (session.state !== "active" && session.state !== "closed")
    ) {
      throw fixtureError(`invalid fixture session at ${index}`);
    }
    if (sessionIds.has(session.sessionId)) {
      throw new RegistryError("REGISTRY_DUPLICATE_SESSION", "duplicate fixture session");
    }
    sessionIds.add(session.sessionId);
    if (session.state === "closed") {
      continue;
    }
    if (worktrees.has(session.worktreePath)) {
      throw new RegistryError("REGISTRY_DUPLICATE_WORKTREE", "duplicate fixture worktree");
    }
    if (branches.has(session.branch)) {
      throw new RegistryError("REGISTRY_DUPLICATE_BRANCH", "duplicate fixture branch");
    }
    worktrees.set(session.worktreePath, session.sessionId);
    branches.set(session.branch, session.sessionId);
  }
}

function parseFixture(value: unknown): TestState {
  if (!isRecord(value)) {
    throw fixtureError("fixture root is not an object");
  }
  if (typeof value.schemaVersion === "number" && value.schemaVersion !== 1) {
    throw fixtureError("unsupported fixture schema", "REGISTRY_UNSUPPORTED_SCHEMA");
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.repositoryId !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.sessions)
  ) {
    throw fixtureError("invalid fixture root");
  }
  const state = value as unknown as TestState;
  validateFixture(state);
  return state;
}

const codec: RegistryCodec<TestState> = {
  empty: () => ({
    schemaVersion: 1,
    repositoryId: testRepositoryId,
    updatedAt: new Date().toISOString(),
    sessions: [],
  }),
  parse: parseFixture,
  validate: validateFixture,
  serialize: (state) => state,
};

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
import { RegistryError } from ${JSON.stringify(new URL("./errors.ts", import.meta.url).href)};
import { RegistryMutationBoundary } from ${JSON.stringify(childModuleUrl)};
const repositoryId = ${JSON.stringify(testRepositoryId)};
const validate = (state) => {
  if (state.schemaVersion !== 1 || state.repositoryId !== repositoryId || !Array.isArray(state.sessions)) throw new RegistryError("REGISTRY_CORRUPT", "invalid state");
  const branches = new Set(); const worktrees = new Set(); const sessions = new Set();
  for (const record of state.sessions) {
    if (sessions.has(record.sessionId)) throw new RegistryError("REGISTRY_DUPLICATE_SESSION", "duplicate session");
    sessions.add(record.sessionId);
    if (record.state === "closed") continue;
    if (branches.has(record.branch)) throw new RegistryError("REGISTRY_DUPLICATE_BRANCH", "duplicate branch");
    if (worktrees.has(record.worktreePath)) throw new RegistryError("REGISTRY_DUPLICATE_WORKTREE", "duplicate worktree");
    branches.add(record.branch); worktrees.add(record.worktreePath);
  }
};
const codec = { empty: () => ({ schemaVersion: 1, repositoryId, updatedAt: new Date().toISOString(), sessions: [] }), parse: (value) => value, validate, serialize: (value) => value };
const boundary = new RegistryMutationBoundary({
  commonGitDirectory: process.env.COMMON_GIT, codec,
  lock: { staleAfterMs: Number(process.env.STALE_AFTER_MS ?? "100"), acquireTimeoutMs: Number(process.env.ACQUIRE_TIMEOUT_MS ?? "10000"), retryDelayMs: 2 },
  atomicWriteHooks: process.env.CRASH_BEFORE_RENAME === "1" ? { beforeRename: () => process.kill(process.pid, "SIGKILL") } : undefined,
});
const operation = process.env.OPERATION; const sessionId = process.env.SESSION_ID; const now = new Date().toISOString();
const record = { schemaVersion: 1, sessionId, repositoryId, worktreePath: "/tmp/nawabari-test-worktrees/" + sessionId, branch: process.env.BRANCH ?? ("branch/" + sessionId), state: "active", createdAt: now, updatedAt: now };
try {
  if (Number(process.env.HOLD_MS ?? "0") > 0) await new Promise((resolve) => setTimeout(resolve, Number(process.env.HOLD_MS)));
  await boundary[operation]((draft) => { draft.sessions.push(record); draft.updatedAt = new Date().toISOString(); });
  console.log(JSON.stringify({ ok: true }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN", message: error instanceof Error ? error.message : String(error) }));
}
`;

async function runChild(commonGitDirectory: string, environment: Record<string, string>): Promise<ChildExit> {
  return await new Promise<ChildExit>((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, NODE_NO_WARNINGS: "1", COMMON_GIT: commonGitDirectory, ...environment },
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
      if (output === undefined || output.length === 0) {
        resolveChild({ ok: false, code: "NO_RESULT", exitCode, signal, stderr });
        return;
      }
      try {
        const parsed: unknown = JSON.parse(output);
        if (isRecord(parsed) && typeof parsed.ok === "boolean") {
          resolveChild({
            ok: parsed.ok,
            ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
            ...(typeof parsed.message === "string" ? { message: parsed.message } : {}),
            exitCode,
            signal,
            stderr,
          });
          return;
        }
      } catch {
        // The caller reports malformed child output as a failed race participant.
      }
      resolveChild({ ok: false, code: "INVALID_RESULT", message: output, exitCode, signal, stderr });
    });
  });
}

async function withCommonGitDirectory<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nawabari-registry-"));
  const directory = join(root, "common-git");
  await mkdir(directory, { recursive: true });
  try {
    return await callback(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRecord(sessionId: string, branch = `branch/${sessionId}`): TestSession {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    repositoryId: testRepositoryId,
    worktreePath: `/tmp/nawabari-test-worktrees/${sessionId}`,
    branch,
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
}

type BoundaryOptions = RegistryMutationBoundaryOptions<TestState>;
function createBoundary(
  commonGitDirectory: string,
  extra: Partial<BoundaryOptions> = {},
): RegistryMutationBoundary<TestState> {
  return new RegistryMutationBoundary<TestState>({
    commonGitDirectory,
    codec,
    lock: { staleAfterMs: 30, acquireTimeoutMs: 10_000, retryDelayMs: 2 },
    ...extra,
  });
}

test("persists a codec-owned document visible to another boundary instance", async () => {
  await withCommonGitDirectory(async (directory) => {
    const first = createBoundary(directory);
    await first.create((draft) => {
      draft.sessions.push(makeRecord("session-1"));
    });
    const second = createBoundary(directory);
    const state = await second.read();
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(
      state.sessions.map((s) => s.sessionId),
      ["session-1"],
    );
  });
});

test("supports the domain registry's explicit common-state paths", async () => {
  await withCommonGitDirectory(async (directory) => {
    const boundary = createBoundary(directory, {
      registryDirectoryName: "custom-registry-dir",
      registryFileName: "session-registry.json",
      lockFileName: "session-registry.lock",
    });
    assert.equal(boundary.registryPath, join(directory, "custom-registry-dir", "session-registry.json"));
    await boundary.create((draft) => {
      draft.sessions.push(makeRecord("explicit-path"));
    });
    assert.equal((await boundary.read()).sessions.length, 1);
  });
});

test("readers reject corrupt and unsupported authoritative state", async () => {
  await withCommonGitDirectory(async (directory) => {
    const boundary = createBoundary(directory);
    await mkdir(boundary.registryDirectory, { recursive: true });
    await writeFile(boundary.registryPath, '{"schemaVersion":1', "utf8");
    await assert.rejects(
      boundary.read(),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_CORRUPT",
    );
    await writeFile(
      boundary.registryPath,
      JSON.stringify({
        schemaVersion: 99,
        repositoryId: testRepositoryId,
        updatedAt: new Date().toISOString(),
        sessions: [],
      }),
      "utf8",
    );
    await assert.rejects(
      boundary.read(),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_UNSUPPORTED_SCHEMA",
    );
  });
});

test("duplicate active session, worktree, and branch ownership fails closed", async () => {
  await withCommonGitDirectory(async (directory) => {
    const boundary = createBoundary(directory);
    await boundary.create((draft) => {
      draft.sessions.push(makeRecord("session-1", "branch/shared"));
    });
    await assert.rejects(
      boundary.claim((draft) => {
        draft.sessions.push(makeRecord("session-1", "branch/other"));
      }),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_DUPLICATE_SESSION",
    );
    await assert.rejects(
      boundary.claim((draft) => {
        draft.sessions.push(makeRecord("session-2", "branch/shared"));
      }),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_DUPLICATE_BRANCH",
    );
    assert.equal((await boundary.read()).sessions.length, 1);
  });
});

test("a failed write leaves the previous complete document authoritative", async () => {
  await withCommonGitDirectory(async (directory) => {
    const boundary = createBoundary(directory);
    await boundary.create((draft) => {
      draft.sessions.push(makeRecord("base"));
    });
    const failing = createBoundary(directory, {
      atomicWriteHooks: {
        beforeRename: () => {
          throw new Error("simulated failure");
        },
      },
    });
    await assert.rejects(
      failing.create((draft) => {
        draft.sessions.push(makeRecord("not-committed"));
      }),
      (error: unknown) => error instanceof RegistryError && error.code === "REGISTRY_MUTATION_FAILED",
    );
    assert.deepEqual(
      (await boundary.read()).sessions.map((s) => s.sessionId),
      ["base"],
    );
  });
});

test("concurrent independent creates serialize across real processes", async () => {
  await withCommonGitDirectory(async (directory) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runChild(directory, { OPERATION: "create", SESSION_ID: `concurrent-${index}`, HOLD_MS: "5" }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 10, JSON.stringify(results));
    const state = await createBoundary(directory).read();
    assert.equal(state.sessions.length, 10);
  });
});

test("create, claim, close, release, and gc use one mutation boundary", async () => {
  await withCommonGitDirectory(async (directory) => {
    const operations = ["create", "claim", "close", "release", "gc"];
    const results = await Promise.all(
      operations.map((operation, index) =>
        runChild(directory, { OPERATION: operation, SESSION_ID: `operation-${index}` }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, operations.length, JSON.stringify(results));
    assert.equal((await createBoundary(directory).read()).sessions.length, operations.length);
  });
});

test("concurrent claims of one branch have exactly one valid winner", async () => {
  await withCommonGitDirectory(async (directory) => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runChild(directory, { OPERATION: "claim", SESSION_ID: `claim-${index}`, BRANCH: "branch/one-winner" }),
      ),
    );
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(
      results.filter((result) => result.code === "REGISTRY_DUPLICATE_BRANCH").length,
      9,
      JSON.stringify(results),
    );
    const state = await createBoundary(directory).read();
    assert.equal(state.sessions.length, 1);
  });
});

test("a killed writer leaves no accepted partial state and allows safe retry", async () => {
  await withCommonGitDirectory(async (directory) => {
    const boundary = createBoundary(directory);
    await boundary.create((draft) => {
      draft.sessions.push(makeRecord("base"));
    });
    const crashed = await runChild(directory, {
      OPERATION: "create",
      SESSION_ID: "killed-writer",
      CRASH_BEFORE_RENAME: "1",
      STALE_AFTER_MS: "20",
    });
    assert.equal(crashed.signal, "SIGKILL", JSON.stringify(crashed));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
    await createBoundary(directory).create((draft) => {
      draft.sessions.push(makeRecord("retry"));
    });
    const state = await boundary.read();
    assert.deepEqual(state.sessions.map((s) => s.sessionId).sort(), ["base", "retry"]);
    assert.ok((await readdir(boundary.registryDirectory)).some((file) => file.endsWith(".tmp")));
    assert.doesNotMatch(await readFile(boundary.registryPath, "utf8"), /killed-writer/);
  });
});

test("codec validation can preserve released history without reserving resources", () => {
  const state: TestState = {
    schemaVersion: 1,
    repositoryId: testRepositoryId,
    updatedAt: new Date().toISOString(),
    sessions: [makeRecord("active", "branch/shared"), { ...makeRecord("closed", "branch/shared"), state: "closed" }],
  };
  assert.doesNotThrow(() => validateFixture(state));
});
