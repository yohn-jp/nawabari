// Run with: node --import tsx/esm scripts/session-registry-worker.mjs <repository> <worktree> <branch>
import { SessionRegistry } from "../src/session-registry.ts";

const [repositoryPath, worktreePath, branchName] = process.argv.slice(2);
if (repositoryPath === undefined || worktreePath === undefined || branchName === undefined) {
  throw new Error("usage: session-registry-worker.mjs <repository> <worktree> <branch>");
}

const registry = new SessionRegistry({ cwd: repositoryPath });
const session = registry.create({ worktreePath, branchName });
process.stdout.write(session.sessionId);
