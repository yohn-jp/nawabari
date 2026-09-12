import fs from "node:fs";

export type RuntimeFileIdentity = Readonly<{
  readonly dev: bigint;
  readonly ino: bigint;
}>;

export type RuntimeFileIdentityTestHooks = Readonly<{
  readonly beforeExclusiveCreate?: (path: string) => void;
  readonly beforeFinalIdentityCheck?: (path: string, identity: RuntimeFileIdentity) => void;
}>;

export type RuntimeFileInspection<T> = Readonly<{
  readonly source: string;
  readonly identity: RuntimeFileIdentity;
  readonly value: T;
}>;

let testHooks: RuntimeFileIdentityTestHooks | undefined;

function identityOf(stat: fs.BigIntStats): RuntimeFileIdentity {
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function sameIdentity(left: RuntimeFileIdentity, right: RuntimeFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyCanonicalIdentity(
  candidate: string,
  source: string,
  identity: RuntimeFileIdentity,
  requireCanonicalPath: boolean,
): void {
  if (requireCanonicalPath && source !== candidate) {
    throw new Error("the file resolves through a symlink");
  }
  testHooks?.beforeFinalIdentityCheck?.(source, identity);
  const pathStat = requireCanonicalPath
    ? fs.lstatSync(candidate, { bigint: true })
    : fs.statSync(source, { bigint: true });
  if (!pathStat.isFile() || !sameIdentity(identity, identityOf(pathStat))) {
    throw new Error("the file identity changed during materialization");
  }
}

/**
 * Open and inspect one regular file through one descriptor, then prove that
 * its canonical pathname still names the descriptor's Linux file identity.
 */
export function inspectRuntimeFile<T>(
  candidate: string,
  inspect: (descriptor: number, stat: fs.BigIntStats) => T,
  options: Readonly<{ readonly requireCanonicalPath?: boolean }> = {},
): RuntimeFileInspection<T> {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY);
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorStat.isFile()) throw new Error("the file is not regular");
    const source = fs.realpathSync.native(candidate);
    if (options.requireCanonicalPath === true && source !== candidate) {
      throw new Error("the file resolves through a symlink");
    }
    const value = inspect(descriptor, descriptorStat);
    verifyCanonicalIdentity(candidate, source, identityOf(descriptorStat), options.requireCanonicalPath === true);
    return Object.freeze({ source, identity: identityOf(descriptorStat), value });
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the inspection result or original failure.
      }
    }
  }
}

/** Read a bounded file through an already inspected descriptor. */
export function readRuntimeFile(descriptor: number, size: bigint, maximum: number): Buffer {
  const maximumSize = BigInt(maximum);
  if (size < 0n || size > maximumSize) throw new Error("the file exceeds the bounded inspection size");
  const length = Number(size);
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const bytes = fs.readSync(descriptor, buffer, offset, length - offset, null);
    if (bytes === 0) throw new Error("the file ended during descriptor inspection");
    offset += bytes;
  }
  return buffer;
}

/**
 * Exclusively create, write, chmod, and identity-check one file. On failure,
 * the invocation-owned partial artifact is left in place rather than removed
 * by pathname: a pathname-based unlink after the identity check would race
 * against a replacement at that path and could delete a competing file. The
 * next materialization attempt fails closed on the existing destination.
 */
export function createRuntimeFile<T>(destination: string, write: (descriptor: number, stat: fs.BigIntStats) => T): T {
  let descriptor: number | null = null;
  try {
    testHooks?.beforeExclusiveCreate?.(destination);
    descriptor = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o755);
    const descriptorStat = fs.fstatSync(descriptor, { bigint: true });
    if (!descriptorStat.isFile()) throw new Error("the created file is not regular");
    const createdIdentity = identityOf(descriptorStat);
    const value = write(descriptor, descriptorStat);
    const source = fs.realpathSync.native(destination);
    verifyCanonicalIdentity(destination, source, createdIdentity, true);
    return value;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original creation result.
      }
    }
  }
}

/**
 * Test-only seam for deterministic replacement and exclusive-create races.
 * It is intentionally private to the runtime/domain implementation and is
 * never re-exported by Nawabari's public API.
 */
export function withRuntimeFileIdentityTestHooks<T>(hooks: RuntimeFileIdentityTestHooks, action: () => T): T {
  const previous = testHooks;
  testHooks = hooks;
  try {
    return action();
  } finally {
    testHooks = previous;
  }
}
