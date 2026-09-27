import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.js";
import {
  CGROUPS_V2_CONTRACT_ID,
  cleanupCgroupScope,
  deriveCgroupScopeName,
  terminateCgroupScope,
  type CgroupScope,
} from "./domain/cgroups-v2.js";
import { LocalSessionBackend, inspectLocalManagedExecutionReadiness } from "./domain/session-backend.js";
import { observeOwnedExecution } from "./domain/session-process-observation.js";
import type { PersistedSessionExecutionRecord } from "./domain/session-execution-record.js";
import { resolveBuiltinWorktreeProfile } from "./domain/worktree-profile-builtins.js";
import { ownedExecutionObservationRecord, readCurrentKernelBootId, SessionRegistry } from "./session-registry.js";

const DESCENDANT_MARKER = "nwb-park-child";
const LINUX_SYSTEM_TEST_TITLE =
  "the public park action adopts its intent only after a real owned cgroup descendant exits";

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function delay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

async function waitFor<T>(description: string, observe: () => T | undefined, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = observe();
    if (value !== undefined) return value;
    await delay();
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function readProcess(
  pid: number,
): Readonly<{ parentPid: number; processName: string; commandLine: string }> | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u);
    const parentPid = Number(fields[1]);
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) return undefined;
    return {
      parentPid,
      processName: fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
      commandLine: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
    };
  } catch {
    return undefined;
  }
}

function ownedScope(record: PersistedSessionExecutionRecord): CgroupScope | undefined {
  const root = record.cgroup_root;
  if (root === null || root === undefined) return undefined;
  const name = deriveCgroupScopeName(record.cgroup_identity);
  const parent = path.join(root, "nawabari");
  return {
    contract_id: CGROUPS_V2_CONTRACT_ID,
    root,
    parent,
    path: path.join(parent, name),
    name,
    boot_id: record.boot_id,
    identity: record.cgroup_identity,
    limits: {},
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // Temporary fixture cleanup also handles a worktree that was not created.
  }
}

async function actionSnapshot(backend: LocalSessionBackend, cwd: string, sessionId: string) {
  const context = { cwd };
  const session = await backend.getSession(context, sessionId);
  if (!session.ok) throw session.error;
  const identity = {
    session_id: session.value.session_id,
    repository: session.value.repository,
    worktree: session.value.worktree,
  };
  const snapshot = await backend.sessionActions(context).readSessionActionSnapshot(identity);
  if (!snapshot.ok) throw snapshot.error;
  return snapshot.value;
}

async function dispatchPark(
  backend: LocalSessionBackend,
  cwd: string,
  sessionId: string,
  operationId: string,
  token: unknown,
): Promise<Readonly<{ exitCode: number; stdout: string[]; stderr: string[]; body: Record<string, unknown> }>> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    [
      "--json",
      "session",
      "action",
      "--session",
      sessionId,
      "--action",
      "park-session",
      "--token",
      JSON.stringify(token),
      "--confirm",
      "--operation-id",
      operationId,
    ],
    {
      cwd,
      backend,
      io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    },
  );
  const output = stdout[0];
  assert.notEqual(output, undefined, stderr.join("\n"));
  return { exitCode, stdout, stderr, body: JSON.parse(output!) as Record<string, unknown> };
}

function runPublicCli(
  args: readonly string[],
  options: Readonly<{ cwd: string; stdout: string[]; stderr: string[] }>,
): Promise<number> {
  const cliEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/index.js");
  const child = spawn(process.execPath, [cliEntry, ...args], {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string | Buffer) => options.stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: string | Buffer) => options.stderr.push(String(chunk)));
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function latestExecution(registry: SessionRegistry, sessionId: string): PersistedSessionExecutionRecord | undefined {
  return registry.listSessionExecutions(sessionId).at(-1);
}

test(LINUX_SYSTEM_TEST_TITLE, async (t) => {
  if (process.env.NAWABARI_TEST_LANE !== "linux-system") {
    t.skip("run via pnpm run test:linux:system");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("the owned cgroup descendant proof requires supported Linux");
    return;
  }
  if (!inspectLocalManagedExecutionReadiness().ready) {
    t.skip("supported local protected execution and delegated cgroup readiness is unavailable");
    return;
  }

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-park-linux-")));
  const repositoryPath = path.join(root, "repository");
  const targetWorktreePath = path.join(root, "target");
  fs.mkdirSync(repositoryPath, { mode: 0o700 });
  const backend = new LocalSessionBackend();
  let sessionIdForCleanup: string | undefined;
  let registryForCleanup: SessionRegistry | undefined;
  let runPromise: Promise<number> | undefined;
  let runCompletion:
    | Readonly<{ exitCode: number; rejected: false }>
    | Readonly<{ exitCode: null; rejected: true; reason: string }>
    | undefined;
  let lastExecutionObservation = "no owned execution record observed";
  const runStdout: string[] = [];
  const runStderr: string[] = [];
  t.after(async () => {
    try {
      if (registryForCleanup !== undefined && sessionIdForCleanup !== undefined) {
        const record = latestExecution(registryForCleanup, sessionIdForCleanup);
        const scope = record === undefined ? undefined : ownedScope(record);
        if (scope !== undefined && fs.existsSync(scope.path)) {
          await waitFor(
            "the test-owned cgroup to drain during cleanup",
            () => {
              const terminated = terminateCgroupScope(scope);
              return terminated.ok && terminated.value.after_population.state === "empty" ? true : undefined;
            },
            15_000,
          );
          if (runPromise !== undefined) {
            const settled = await Promise.race([
              runPromise.then(() => true),
              new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
            ]);
            assert.equal(settled, true, "the protected CLI execution must settle after its owned cgroup drains");
          }
          await waitFor(
            "the test-owned cgroup to be removed during cleanup",
            () => {
              if (!fs.existsSync(scope.path)) return true;
              const cleaned = cleanupCgroupScope(scope);
              return cleaned.ok && cleaned.value.removed ? true : undefined;
            },
            15_000,
          );
        }
      }
    } finally {
      removeWorktree(repositoryPath, targetWorktreePath);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  runGit(["init", "--quiet", "-b", "main"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "user.email", "tests@example.invalid"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "real park drain fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "--quiet", "-m", "initial"], repositoryPath);

  const context = { cwd: repositoryPath };
  const created = await backend.createSession(context, {
    branch: "feature/linux-park-drain",
    worktree: targetWorktreePath,
    label: "linux park drain proof",
    claims: [{ resource: "README.md", mode: "read" }],
    claim_enforcement: true,
    profile: { selection: { profile: "minimal" } },
  });
  if (!created.ok) throw created.error;
  const sessionId = created.value.session_id;
  sessionIdForCleanup = sessionId;
  const registry = new SessionRegistry({ cwd: repositoryPath });
  registryForCleanup = registry;
  const initialClaims = registry.listClaims(sessionId);
  assert.equal(initialClaims.length, 1);
  assert.equal(registry.get(sessionId)?.state, "active");

  const payload = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(`process.title = ${JSON.stringify(DESCENDANT_MARKER)}; setInterval(() => {}, 1000);`)}], { stdio: 'ignore' });`,
    "child.once('error', () => process.exit(2));",
    "child.once('exit', () => process.exit(0));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  runPromise = runPublicCli(["--json", "session", "run", "--session", sessionId, "--", "node", "-e", payload], {
    cwd: targetWorktreePath,
    stdout: runStdout,
    stderr: runStderr,
  }).then(
    (exitCode) => {
      runCompletion = { exitCode, rejected: false };
      return exitCode;
    },
    (error: unknown) => {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      runCompletion = { exitCode: null, rejected: true, reason };
      return 1;
    },
  );

  const running = await waitFor("a real owned descendant in the protected execution cgroup", () => {
    if (runCompletion !== undefined) {
      throw new Error(
        `The protected CLI run completed before its owned descendant was observed: ${JSON.stringify({
          completion: runCompletion,
          stdout: runStdout,
          stderr: runStderr,
          lastExecutionObservation,
        })}`,
      );
    }
    const record = latestExecution(registry, sessionId);
    if (record === undefined) return undefined;
    const observed = observeOwnedExecution(ownedExecutionObservationRecord(record), {
      current_boot_id: readCurrentKernelBootId(),
    });
    lastExecutionObservation = JSON.stringify({
      execution_id: record.execution_id,
      record_state: record.state,
      cgroup_root: record.cgroup_root ?? null,
      observation: observed.ok
        ? {
            state: observed.value.state,
            population: observed.value.cgroups?.population.state ?? null,
            processes: observed.value.cgroups?.population.processes ?? null,
          }
        : { error: observed.error.message },
    });
    if (record.state !== "attached" && record.state !== "running") return undefined;
    if (
      !observed.ok ||
      observed.value.state !== "active" ||
      observed.value.cgroups?.population.state !== "populated" ||
      observed.value.cgroups.population.processes === null
    ) {
      return undefined;
    }
    const pids = observed.value.cgroups.population.processes;
    const processSummaries: {
      pid: number;
      parentPid: number | null;
      processName: string;
      commandLine: string;
    }[] = [];
    for (const pid of pids) {
      const info = readProcess(pid);
      processSummaries.push({
        pid,
        parentPid: info?.parentPid ?? null,
        processName: info?.processName ?? "unavailable",
        commandLine: info?.commandLine.slice(0, 160) ?? "unavailable",
      });
      if (info?.processName === DESCENDANT_MARKER && pids.includes(info.parentPid)) {
        return { record, scope: ownedScope(record), descendantPid: pid, parentPid: info.parentPid };
      }
    }
    lastExecutionObservation = JSON.stringify({
      execution_id: record.execution_id,
      record_state: record.state,
      cgroup_root: record.cgroup_root ?? null,
      population: observed.value.cgroups.population.state,
      processes: processSummaries,
    });
    return undefined;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nLast protected execution evidence: ${lastExecutionObservation}`);
  });
  assert.ok(running.scope, "the execution record must carry its owned cgroup lease");
  assert.notEqual(running.descendantPid, running.parentPid);

  const parkOperationId = "linux-park-drain-retry";
  const firstSnapshot = await actionSnapshot(backend, repositoryPath, sessionId);
  assert.ok(
    firstSnapshot.diagnostic.park_resume_actions?.some((action) => action.actionId === "park-session"),
    JSON.stringify(firstSnapshot.diagnostic),
  );
  const firstAttempt = await dispatchPark(backend, repositoryPath, sessionId, parkOperationId, firstSnapshot.token);
  assert.equal(firstAttempt.exitCode, 3, firstAttempt.stdout.join("\n"));
  assert.equal(firstAttempt.body.ok, false);
  assert.equal(firstAttempt.body.code, "OPERATION_REJECTED");
  assert.equal((firstAttempt.body.details as Record<string, unknown> | undefined)?.retention_code, "DRAIN_INCOMPLETE");

  const fencedView = registry.readRepositoryView();
  const durableIntent = fencedView.runtimeRecords.records.park_intents?.find(
    (intent) => intent.sessionId === sessionId,
  );
  assert.equal(durableIntent?.operationId, parkOperationId);
  assert.equal(registry.get(sessionId)?.state, "active");
  assert.equal(registry.listClaims(sessionId).length, initialClaims.length);
  assert.equal(fencedView.runtimeRecords.records.retentions?.length ?? 0, 0);
  const admission = fencedView.runtimeRecords.records.runtime_sessions?.find(
    (record) => record.session_id === sessionId,
  );
  assert.equal(admission?.admission, "closed");

  const differentOperationSnapshot = await actionSnapshot(backend, repositoryPath, sessionId);
  const differentOperation = await dispatchPark(
    backend,
    repositoryPath,
    sessionId,
    "linux-park-different-operation",
    differentOperationSnapshot.token,
  );
  assert.equal(differentOperation.exitCode, 3, differentOperation.stdout.join("\n"));
  assert.equal(differentOperation.body.code, "OPERATION_REJECTED");
  assert.equal(
    (differentOperation.body.details as Record<string, unknown> | undefined)?.retention_code,
    "FENCE_REJECTED",
  );
  assert.equal(
    registry.readRepositoryView().runtimeRecords.records.park_intents?.find((intent) => intent.sessionId === sessionId)
      ?.operationId,
    parkOperationId,
  );
  assert.equal(registry.listClaims(sessionId).length, initialClaims.length);

  // The backend creates a fresh SessionRegistry for each call, so this public retry must adopt persisted intent.
  process.kill(running.descendantPid, "SIGTERM");
  const runExitCode = await runPromise;
  const runResult = JSON.parse(runStdout.join("").trim()) as {
    readonly ok?: unknown;
    readonly command?: unknown;
    readonly exit_code?: unknown;
    readonly signal?: unknown;
    readonly execution?: { readonly state?: unknown };
  };
  assert.equal(runResult.ok, true, JSON.stringify({ runExitCode, runResult, runStderr }));
  assert.equal(runResult.command, "session run");
  assert.equal(runResult.execution?.state, "exited");
  assert.ok(
    (runExitCode === 0 && runResult.exit_code === 0 && runResult.signal === null) ||
      (runExitCode === 3 && runResult.exit_code === null && runResult.signal === "SIGTERM"),
    JSON.stringify({ runExitCode, runResult, runStderr }),
  );
  const exited = latestExecution(registry, sessionId);
  assert.equal(exited?.state, "exited");
  assert.ok(exited);
  const drained = observeOwnedExecution(ownedExecutionObservationRecord(exited), {
    current_boot_id: readCurrentKernelBootId(),
  });
  assert.equal(drained.ok, true, drained.ok ? "" : drained.error.message);
  assert.equal(drained.value.state, "empty");
  assert.equal(drained.value.cgroups?.population.state, "empty");

  const beforeCommit = registry.readRepositoryView();
  const retrySnapshot = await actionSnapshot(backend, repositoryPath, sessionId);
  assert.ok(
    retrySnapshot.diagnostic.park_resume_actions?.some((action) => action.actionId === "park-session"),
    JSON.stringify(retrySnapshot.diagnostic),
  );
  const retry = await dispatchPark(backend, repositoryPath, sessionId, parkOperationId, retrySnapshot.token);
  assert.equal(retry.exitCode, 0, retry.stdout.join("\n"));
  assert.equal(retry.body.ok, true);
  assert.equal((retry.body.result as Record<string, unknown> | undefined)?.status, "parked");
  assert.equal((retry.body.result as Record<string, unknown> | undefined)?.operationId, parkOperationId);

  const finalView = registry.readRepositoryView();
  assert.equal(finalView.registryRevision, beforeCommit.registryRevision + 1);
  assert.equal(registry.get(sessionId)?.state, "parked");
  assert.equal(registry.listClaims(sessionId).length, 0);
  assert.equal(
    finalView.runtimeRecords.records.park_intents?.some((intent) => intent.sessionId === sessionId),
    false,
  );
  const retentions = finalView.runtimeRecords.records.retentions ?? [];
  assert.equal(retentions.length, 1);
  assert.equal(retentions[0]?.operationId, parkOperationId);
  assert.equal(retentions[0]?.sessionId, sessionId);
  assert.equal(
    finalView.runtimeRecords.records.runtime_sessions?.find((record) => record.session_id === sessionId)?.admission,
    "closed",
  );
});
