// Run with: node --import tsx/esm scripts/session-registry-worker.mjs <repository> <worktree> <branch> [lock-timeout-ms]
import { SessionRegistry } from "../src/session-registry.ts";

const [repositoryPath, worktreePath, branchName, lockTimeoutMs] = process.argv.slice(2);
if (repositoryPath === undefined || worktreePath === undefined || branchName === undefined) {
  throw new Error("usage: session-registry-worker.mjs <repository> <worktree> <branch> [lock-timeout-ms]");
}

const registry = new SessionRegistry({
  cwd: repositoryPath,
  ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs: Number(lockTimeoutMs) }),
});
const session = registry.create({ worktreePath, branchName });
process.stdout.write(session.sessionId);
