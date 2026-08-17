// Test-only fault-injection helpers shared across suites that exercise the
// registry's atomic-write durability paths. Excluded from the published
// build (see tsconfig.build.json) since it patches Node's `fs` module and
// has no place in a shipped package.
import fs from "node:fs";

/**
 * Fails only the directory fsync targeting `directory` (never a temporary
 * file fsync, and never a directory fsync for an unrelated directory such
 * as the repository lock's own owner.json write), so the fault
 * deterministically lands on the atomic-write post-rename directory sync
 * under test regardless of how many other fsync calls happen around it.
 */
export function withDirectoryFsyncFailure<T>(directory: string, code: string, run: () => T): T {
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const directoryDescriptors = new Set<number>();
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpenSync(...args);
    if (args[0] === directory) {
      directoryDescriptors.add(fd);
    }
    return fd;
  }) as typeof fs.openSync;
  fs.fsyncSync = ((fd: number) => {
    if (directoryDescriptors.has(fd)) {
      throw errnoError(code);
    }
    return originalFsyncSync(fd);
  }) as typeof fs.fsyncSync;
  try {
    return run();
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
  }
}

export function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(`Simulated ${code}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
