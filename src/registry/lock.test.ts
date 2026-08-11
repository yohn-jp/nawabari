import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistryLockError, RepositoryLock } from "./lock.js";

async function withLockPath<T>(callback: (lockPath: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "nawabari-lock-"));
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

test("a parallel reclaimer cannot remove a lock acquired after the final token check", async () => {
  await withLockPath(async (lockPath) => {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        // The maximum portable PID is not a live process on supported CI hosts.
        pid: 2_147_483_647,
        hostname: hostname(),
        processStartTime: "0",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      }),
      "utf8",
    );

    let resolveContenderMarkerObserved: (() => void) | undefined;
    const contenderMarkerObserved = new Promise<void>((resolve) => {
      resolveContenderMarkerObserved = resolve;
    });
    const contender = new RepositoryLock({
      lockPath,
      staleAfterMs: 0,
      metadataGraceMs: 100,
      acquireTimeoutMs: 2_000,
      retryDelayMs: 1,
      onReclaimMarkerObserved: () => resolveContenderMarkerObserved?.(),
    });
    let contenderPromise: Promise<import("./lock.js").LockLease> | undefined;
    let contenderSurvived = false;
    const reclaimer = new RepositoryLock({
      lockPath,
      staleAfterMs: 0,
      metadataGraceMs: 100,
      acquireTimeoutMs: 2_000,
      retryDelayMs: 50,
      beforeReclaimRemove: async () => {
        // Model the stale owner releasing concurrently after the reclaimer's
        // final token check. A correct contender must honor the reclaim marker.
        await rm(lockPath, { recursive: true, force: true });
        contenderPromise = contender.acquire().then(async (lease) => {
          try {
            contenderSurvived = (await readFile(join(lockPath, "owner.json"), "utf8")).includes(lease.token);
          } catch {
            contenderSurvived = false;
          }
          await lease.release();
          return lease;
        });
        await contenderMarkerObserved;
      },
    });

    const reclaimerLease = await reclaimer.acquire();
    if (contenderPromise === undefined) {
      throw new Error("contender was not started during reclaim");
    }
    await reclaimerLease.release();
    await contenderPromise;
    assert.equal(contenderSurvived, true);
  });
});
