import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultControlRepositoryCatalogPath,
  listControlRepositories,
  openRepositoryLocator,
  readRepositoryLocators,
  registerRepositoryLocator,
  repositoryKey,
} from "./control-repositories.js";
import { REGISTRY_DIRECTORY_NAME, REGISTRY_FILE_NAME } from "./session-registry.js";

function temporaryRoot(t: test.TestContext): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-control-repositories-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repository(root: string, name: string, managed: boolean): string {
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  execFileSync("git", ["init", "--quiet", "-b", "main", directory]);
  if (managed) {
    const registry = path.join(directory, ".git", REGISTRY_DIRECTORY_NAME);
    fs.mkdirSync(registry);
    fs.writeFileSync(path.join(registry, REGISTRY_FILE_NAME), "{}\n");
  }
  return directory;
}

type RegistrationChildMessage = Readonly<{
  readonly type: "started" | "publication" | "result";
  readonly ok?: boolean;
  readonly repository_id?: string;
  readonly code?: string;
}>;

function startRegistrationChild(
  catalog: string,
  cwd: string,
  stallPublication = false,
): {
  readonly child: ChildProcess;
  readonly messages: RegistrationChildMessage[];
  readonly stderr: () => string;
  readonly waitFor: (type: RegistrationChildMessage["type"], timeoutMs?: number) => Promise<RegistrationChildMessage>;
  readonly waitForExit: () => Promise<number>;
} {
  const importUrl = new URL("./control-repositories.ts", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    import { registerRepositoryLocator } from ${JSON.stringify(importUrl)};

    const catalog = ${JSON.stringify(catalog)};
    const cwd = ${JSON.stringify(cwd)};
    if (${JSON.stringify(stallPublication)}) {
      const rename = fs.renameSync;
      fs.renameSync = ((source, destination) => {
        if (path.resolve(String(destination)) === path.resolve(catalog)) {
          process.send?.({ type: "publication" });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_200);
        }
        return rename.call(fs, source, destination);
      });
    }

    process.send?.({ type: "started" });
    const result = registerRepositoryLocator(catalog, cwd);
    process.send?.({
      type: "result",
      ok: result.ok,
      repository_id: result.ok ? result.value?.repository_id : undefined,
      code: result.ok ? undefined : result.error.code,
    });
    process.disconnect?.();
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: RegistrationChildMessage[] = [];
  const waiters: {
    readonly type: RegistrationChildMessage["type"];
    readonly resolve: (message: RegistrationChildMessage) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }[] = [];
  let childStderr = "";
  let exitCode: number | null = null;
  let resolveExit: ((code: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    childStderr += chunk;
  });
  child.on("message", (value: unknown) => {
    if (typeof value !== "object" || value === null || !("type" in value)) return;
    const message = value as RegistrationChildMessage;
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      if (waiter !== undefined) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.on("exit", (code) => {
    exitCode = code ?? -1;
    resolveExit?.(exitCode);
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`registration child exited before ${waiter.type}; stderr: ${childStderr}`));
    }
  });

  return {
    child,
    messages,
    stderr: () => childStderr,
    waitFor: (type, timeoutMs = 5_000) => {
      const existing = messages.find((message) => message.type === type);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          type,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            reject(new Error(`registration child did not send ${type}; stderr: ${childStderr}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    waitForExit: async () => (exitCode === null ? exited : exitCode),
  };
}

test("default catalog path is machine-local XDG state and ignores relative overrides", () => {
  assert.equal(
    defaultControlRepositoryCatalogPath({ XDG_STATE_HOME: "/state" }),
    "/state/nawabari/control-repositories.json",
  );
  assert.equal(
    defaultControlRepositoryCatalogPath({ XDG_STATE_HOME: "relative" }),
    path.join(os.homedir(), ".local", "state", "nawabari", "control-repositories.json"),
  );
});

test("catalog records only identity/path locators for Nawabari-managed repositories", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "state", "control-repositories.json");
  const unmanaged = repository(root, "plain", false);
  const managed = repository(root, "managed", true);
  fs.mkdirSync(path.join(managed, "nested"));

  assert.deepEqual(registerRepositoryLocator(catalog, unmanaged), { ok: true, value: null });
  assert.equal(fs.existsSync(catalog), false);
  assert.deepEqual(registerRepositoryLocator(catalog, path.join(root, "missing")), { ok: true, value: null });

  const registered = registerRepositoryLocator(catalog, path.join(managed, "nested"));
  assert.deepEqual(registered, {
    ok: true,
    value: { repository_id: path.join(managed, ".git"), worktree_path: managed },
  });
  assert.deepEqual(registerRepositoryLocator(catalog, managed), registered);

  const document = JSON.parse(fs.readFileSync(catalog, "utf8")) as { repositories: Record<string, unknown>[] };
  assert.equal(document.repositories.length, 1);
  assert.deepEqual(Object.keys(document.repositories[0] ?? {}).sort(), ["repository_id", "worktree_path"]);
  assert.equal(fs.statSync(catalog).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${catalog}.lock`), false);
});

test("concurrent processes serialize catalog registration without losing either locator", async (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "state", "control-repositories.json");
  const first = repository(root, "first", true);
  const second = repository(root, "second", true);
  const firstWriter = startRegistrationChild(catalog, first, true);
  t.after(() => {
    if (firstWriter.child.exitCode === null) firstWriter.child.kill("SIGKILL");
  });

  await firstWriter.waitFor("publication");
  assert.equal(fs.existsSync(`${catalog}.lock/owner.json`), true);

  const secondWriter = startRegistrationChild(catalog, second);
  t.after(() => {
    if (secondWriter.child.exitCode === null) secondWriter.child.kill("SIGKILL");
  });
  await secondWriter.waitFor("started");
  const resultBeforeFirstPublishes = await secondWriter.waitFor("result", 200).then(
    () => true,
    () => false,
  );
  assert.equal(resultBeforeFirstPublishes, false, "the second process waits for the catalog writer lease");

  const [firstResult, secondResult] = await Promise.all([
    firstWriter.waitFor("result"),
    secondWriter.waitFor("result"),
  ]);
  assert.equal(firstResult.ok, true, firstWriter.stderr());
  assert.equal(secondResult.ok, true, secondWriter.stderr());
  assert.equal(firstResult.repository_id, path.join(first, ".git"));
  assert.equal(secondResult.repository_id, path.join(second, ".git"));
  const exitCodes = await Promise.all([firstWriter.waitForExit(), secondWriter.waitForExit()]);
  assert.deepEqual(exitCodes, [0, 0], `${firstWriter.stderr()}${secondWriter.stderr()}`);

  const listed = readRepositoryLocators(catalog);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(
    listed.value.map((entry) => entry.repository_id).sort(),
    [path.join(first, ".git"), path.join(second, ".git")].sort(),
  );
  assert.equal(fs.existsSync(`${catalog}.lock`), false);
});

test("listing re-resolves every locator and reports drift as unavailable", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "control-repositories.json");
  const first = repository(root, "first", true);
  const second = repository(root, "second", true);
  assert.equal(registerRepositoryLocator(catalog, first).ok, true);
  assert.equal(registerRepositoryLocator(catalog, second).ok, true);

  const listed = listControlRepositories(catalog);
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(
    listed.value.map((entry) => [entry.repository_key, entry.available]),
    [
      [repositoryKey(path.join(first, ".git")), true],
      [repositoryKey(path.join(second, ".git")), true],
    ],
  );

  fs.rmSync(path.join(second, ".git", REGISTRY_DIRECTORY_NAME), { recursive: true });
  const after = listControlRepositories(catalog);
  assert.equal(after.ok && after.value[1]?.available, false);
  const reopened = openRepositoryLocator({ repository_id: path.join(second, ".git"), worktree_path: second });
  assert.equal(reopened.ok, false);
  const forged = openRepositoryLocator({ repository_id: path.join(second, ".git"), worktree_path: first });
  assert.equal(forged.ok, false, "a locator whose path resolves to another repository is not reopened");
});

test("malformed or oversized catalog content fails closed", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "control-repositories.json");
  assert.deepEqual(readRepositoryLocators(catalog), { ok: true, value: [] });
  for (const content of [
    "not json",
    JSON.stringify({ schema_version: 2, repositories: [] }),
    JSON.stringify({ schema_version: 1, repositories: [{ repository_id: "relative", worktree_path: "/x" }] }),
    JSON.stringify({
      schema_version: 1,
      repositories: [{ repository_id: "/x/.git", worktree_path: "/x", sessions: [] }],
    }),
    "x".repeat(300 * 1024),
  ]) {
    fs.writeFileSync(catalog, content);
    const result = readRepositoryLocators(catalog);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_REGISTRY");
  }
});

test("failed catalog publication leaves the previous catalog intact and releases the lock", (t) => {
  const root = temporaryRoot(t);
  const catalog = path.join(root, "state", "control-repositories.json");
  const first = repository(root, "first", true);
  const second = repository(root, "second", true);
  assert.equal(registerRepositoryLocator(catalog, first).ok, true);
  const before = fs.readFileSync(catalog, "utf8");

  const rename = fs.renameSync;
  fs.renameSync = ((source, destination) => {
    if (path.resolve(String(destination)) === path.resolve(catalog)) {
      throw new Error("injected catalog publication failure");
    }
    return rename.call(fs, source, destination);
  }) as typeof fs.renameSync;
  const result = (() => {
    try {
      return registerRepositoryLocator(catalog, second);
    } finally {
      fs.renameSync = rename;
    }
  })();

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_REGISTRY");
    assert.equal(result.error.details?.reason, "unwritable");
  }
  assert.equal(fs.readFileSync(catalog, "utf8"), before);
  assert.equal(fs.existsSync(`${catalog}.lock`), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(catalog)).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});
