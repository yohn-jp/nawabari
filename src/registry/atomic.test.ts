import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RegistryError } from "./errors.js";
import {
  AtomicWritePostRenameFailure,
  isPostRenameFailure,
  writeJsonAtomically,
  writeJsonAtomicallySync,
} from "./atomic.js";

async function withRegistryDirectory<T>(callback: (directory: string) => Promise<T> | T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "nawabari-atomic-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`Simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** Fails only the Nth `fs.fsyncSync` call observed while `run` executes. */
async function withFsyncFailureOnCall<T>(failOnCall: number, code: string, run: () => Promise<T> | T): Promise<T> {
  const original = fs.fsyncSync;
  let calls = 0;
  fs.fsyncSync = ((descriptor: number) => {
    calls += 1;
    if (calls === failOnCall) {
      throw errnoError(code);
    }
    return original(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    return await run();
  } finally {
    fs.fsyncSync = original;
  }
}

function tempSiblingsOf(registryPath: string): string[] {
  const directory = join(registryPath, "..");
  return fs.readdirSync(directory).filter((name) => name !== "registry.json");
}

test("successful directory fsync commits the document once", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    writeJsonAtomicallySync(registryPath, { hello: "world" });
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { hello: "world" });
    assert.deepEqual(tempSiblingsOf(registryPath), []);
  });
});

test("a known unsupported directory-fsync error is tolerated as success", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    // Call 1 = temp file fsync (must succeed); call 2 = directory fsync (simulated unsupported).
    await withFsyncFailureOnCall(2, "EINVAL", () => {
      writeJsonAtomicallySync(registryPath, { hello: "world" });
    });
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { hello: "world" });
    assert.deepEqual(tempSiblingsOf(registryPath), []);
  });
});

test("an unexpected pre-rename fsync failure never produces a successful mutation", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    await assert.rejects(
      withFsyncFailureOnCall(1, "EIO", () => {
        writeJsonAtomicallySync(registryPath, { hello: "world" });
      }),
      (error: unknown) => {
        const errnoCause = (error as NodeJS.ErrnoException).code;
        assert.equal(errnoCause, "EIO");
        assert.equal(isPostRenameFailure(error), false);
        return true;
      },
    );
    assert.equal(fs.existsSync(registryPath), false);
    assert.deepEqual(tempSiblingsOf(registryPath), []);
  });
});

test("an unexpected post-rename directory-sync failure is durability-uncertain, not a proven pre-effect failure", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    await assert.rejects(
      withFsyncFailureOnCall(2, "EIO", () => {
        writeJsonAtomicallySync(registryPath, { hello: "world" });
      }),
      (error: unknown) => {
        assert.ok(error instanceof RegistryError);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        assert.equal(isPostRenameFailure(error), true);
        // The original EIO failure is preserved verbatim as the cause chain.
        assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, "EIO");
        return true;
      },
    );
    // The rename already committed: the renamed document is what readers observe,
    // even though directory durability could not be proven.
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { hello: "world" });
    assert.deepEqual(tempSiblingsOf(registryPath), []);
  });
});

test("a frozen, non-extensible object thrown after rename is still classified durability-uncertain", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    const frozenFailure = Object.freeze({ marker: "frozen-post-rename-failure" });
    await assert.rejects(
      writeJsonAtomically(
        registryPath,
        { hello: "world" },
        {
          hooks: {
            afterRename: () => {
              throw frozenFailure;
            },
          },
        },
      ),
      (error: unknown) => {
        // Classification never depends on writing a property onto the
        // thrown value: it would silently no-op on a frozen object.
        assert.ok(isPostRenameFailure(error));
        assert.ok(error instanceof AtomicWritePostRenameFailure);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        assert.equal(error.cause, frozenFailure);
        assert.ok(Object.isFrozen(frozenFailure));
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { hello: "world" });
  });
});

test("a primitive value thrown after rename is still classified durability-uncertain", async () => {
  await withRegistryDirectory(async (directory) => {
    const registryPath = join(directory, "registry.json");
    await assert.rejects(
      writeJsonAtomically(
        registryPath,
        { hello: "world" },
        {
          hooks: {
            afterRename: () => {
              throw "a bare string failure";
            },
          },
        },
      ),
      (error: unknown) => {
        // A primitive has no properties to mark at all: classification
        // must not depend on reading anything off the thrown value itself.
        assert.ok(isPostRenameFailure(error));
        assert.ok(error instanceof AtomicWritePostRenameFailure);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        assert.equal(error.cause, "a bare string failure");
        return true;
      },
    );
    assert.deepEqual(JSON.parse(await readFile(registryPath, "utf8")), { hello: "world" });
  });
});

test("isPostRenameFailure is false for unrelated errors", () => {
  assert.equal(isPostRenameFailure(new Error("unrelated")), false);
  assert.equal(isPostRenameFailure(new RegistryError("REGISTRY_IO_ERROR", "unrelated")), false);
  assert.equal(isPostRenameFailure(new RegistryError("REGISTRY_DURABILITY_UNCERTAIN", "unrelated")), false);
  assert.equal(isPostRenameFailure(undefined), false);
  assert.equal(isPostRenameFailure("not-an-object"), false);
  assert.equal(isPostRenameFailure(Object.freeze({ code: "REGISTRY_DURABILITY_UNCERTAIN" })), false);
});
