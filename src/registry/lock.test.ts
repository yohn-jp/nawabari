import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistryLockError, RepositoryLock } from "./lock.js";

async function withLockPath<T>(callback: (lockPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "gitpaw-lock-"));
  try {
    return await callback(join(root, "registry.lock"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("contention times out with a typed busy outcome", async () => {
  await withLockPath(async (lockPath) => {
    const first = new RepositoryLock({
      lockPath,
      staleAfterMs: 10_000,
      acquireTimeoutMs: 100,
      retryDelayMs: 2,
    });
    const second = new RepositoryLock({
      lockPath,
      staleAfterMs: 10_000,
      acquireTimeoutMs: 20,
      retryDelayMs: 2,
    });
    const lease = await first.acquire();
    await assert.rejects(second.acquire(), (error: unknown) => {
      return error instanceof RegistryLockError && error.code === "LOCK_BUSY";
    });
    await lease.release();
  });
});

test("invalid lock metadata fails closed and is not removed", async () => {
  await withLockPath(async (lockPath) => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), "not-json", "utf8");
    const lock = new RepositoryLock({
      lockPath,
      staleAfterMs: 0,
      metadataGraceMs: 0,
      acquireTimeoutMs: 0,
    });
    await assert.rejects(lock.acquire(), (error: unknown) => {
      return error instanceof RegistryLockError && error.code === "LOCK_INVALID";
    });
    assert.equal(await readFile(join(lockPath, "owner.json"), "utf8"), "not-json");
  });
});

test("an old remote-owner lock is reported stale without unsafe stealing", async () => {
  await withLockPath(async (lockPath) => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        token: "remote-owner",
        pid: 1,
        hostname: `${hostname()}-unverifiable-host`,
        processStartTime: "unknown",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      }),
      "utf8",
    );
    const lock = new RepositoryLock({
      lockPath,
      staleAfterMs: 1,
      metadataGraceMs: 0,
      acquireTimeoutMs: 0,
      hostname: hostname(),
    });
    await assert.rejects(lock.acquire(), (error: unknown) => {
      return error instanceof RegistryLockError && error.code === "LOCK_STALE";
    });
    assert.equal(
      await readFile(join(lockPath, "owner.json"), "utf8").then((raw) => raw.includes("remote-owner")),
      true,
    );
  });
});
