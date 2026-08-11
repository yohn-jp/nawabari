// Run with: node --import tsx/esm scripts/resource-claim-worker.mjs <repository> <session> <resource> <mode>
import { SessionRegistry } from "../src/session-registry.ts";

const [repositoryPath, sessionId, resource, mode] = process.argv.slice(2);
if (repositoryPath === undefined || sessionId === undefined || resource === undefined || mode === undefined) {
  throw new Error("usage: resource-claim-worker.mjs <repository> <session> <resource> <mode>");
}

const registry = new SessionRegistry({ cwd: repositoryPath });
try {
  const result = registry.claimResources({ sessionId, claims: [{ resource, mode }] });
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      code: error?.code ?? "UNKNOWN",
      details: error?.details ?? {},
    }),
  );
  process.exitCode = 3;
}
