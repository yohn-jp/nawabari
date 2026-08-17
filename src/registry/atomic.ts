import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { open, mkdir, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { RegistryError } from "./errors.js";

export interface AtomicWritePaths {
  temporaryPath: string;
  targetPath: string;
}

export interface AtomicWriteHooks {
  beforeRename?: (paths: AtomicWritePaths) => void | Promise<void>;
  afterRename?: (paths: AtomicWritePaths) => void | Promise<void>;
}

export interface AtomicWriteOptions {
  ensureParent?: boolean;
  hooks?: AtomicWriteHooks;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR";
}

/**
 * A failure observed after the target file was already renamed into place.
 * Callers must not read this as "the write succeeded" — durability past
 * that point is unproven — but they must also not treat it as an ordinary
 * pre-effect failure: the renamed document may already be the one readers
 * observe. `cause` always carries the original thrown value verbatim
 * (whatever it was — an Error, a frozen object, a primitive), since a
 * classification that depended on mutating or reading properties off the
 * original thrown value would silently fail for values that reject writes
 * (frozen/non-extensible objects) or carry no properties at all
 * (primitives). Wrapping in a fresh, always-extensible error is fail-safe
 * regardless of what the underlying I/O call happened to throw.
 */
export class AtomicWritePostRenameFailure extends RegistryError {
  public constructor(paths: AtomicWritePaths, cause: unknown) {
    super(
      "REGISTRY_DURABILITY_UNCERTAIN",
      `Rename to ${paths.targetPath} may have already committed, but durable persistence past that point could not be proven`,
      { ...paths },
      { cause },
    );
    this.name = "AtomicWritePostRenameFailure";
  }
}

function toPostRenameFailure(error: unknown, paths: AtomicWritePaths): AtomicWritePostRenameFailure {
  return new AtomicWritePostRenameFailure(paths, error);
}

/**
 * True when `writeJsonAtomically`/`writeJsonAtomicallySync` failed only
 * after the rename had already committed the new document. Recovery must
 * reconcile authoritative state instead of assuming the mutation never
 * happened.
 */
export function isPostRenameFailure(error: unknown): error is AtomicWritePostRenameFailure {
  return error instanceof AtomicWritePostRenameFailure;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
}

function syncDirectorySync(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

/**
 * Persist JSON by writing and syncing a same-directory temporary file, then
 * replacing the target with rename. Readers therefore observe either the
 * previous complete document or the next complete document.
 */
export async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(targetPath);
  if (options.ensureParent !== false) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  const temporaryPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new RegistryError("REGISTRY_IO_ERROR", "Cannot serialize registry state", {
      targetPath,
    });
  }

  let handle: FileHandle | undefined;
  let renamed = false;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${serialized}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const paths = { temporaryPath, targetPath };
    await options.hooks?.beforeRename?.(paths);
    await rename(temporaryPath, targetPath);
    renamed = true;
    await syncDirectory(directory);
    await options.hooks?.afterRename?.(paths);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close();
    }
    if (!renamed) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    throw toPostRenameFailure(error, { temporaryPath, targetPath });
  }
}

/** Synchronous counterpart used by the legacy synchronous registry boundary. */
export function writeJsonAtomicallySync(
  targetPath: string,
  value: unknown,
  options: Pick<AtomicWriteOptions, "ensureParent"> = {},
): void {
  const directory = dirname(targetPath);
  if (options.ensureParent !== false) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const temporaryPath = join(directory, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new RegistryError("REGISTRY_IO_ERROR", "Cannot serialize registry state", {
      targetPath,
    });
  }

  let descriptor: number | undefined;
  let renamed = false;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${serialized}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    fs.renameSync(temporaryPath, targetPath);
    renamed = true;
    syncDirectorySync(directory);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (!renamed) {
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
    throw toPostRenameFailure(error, { temporaryPath, targetPath });
  }
}
