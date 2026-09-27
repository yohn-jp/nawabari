import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseRepositoryRuntimeObservations } from "../repository-runtime-observations.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import { SessionRegistry, type RepositoryRegistryView, type SessionRecord } from "../session-registry.js";
import { compileEffectiveFilesystemPolicy } from "./filesystem-policy.js";
import {
  collectRepositoryRuntimeFilesystemObservation,
  type RepositoryRuntimeEffectiveFilesystemPolicySource,
  type RepositoryRuntimeFilesystemPolicyReadContext,
} from "./repository-runtime-filesystem-collector.js";

const CAPTURED_AT = new Date("2026-09-27T04:05:06.000Z");

type RepositoryFixture = Readonly<{
  readonly root: string;
  readonly registry: SessionRegistry;
  readonly session: SessionRecord;
  cleanup(): void;
}>;

function createRepository(): RepositoryFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-filesystem-collector-"));
  runGit(["init", "--quiet", "--initial-branch=main"], root);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], root);
  runGit(["config", "user.name", "Nawabari Tests"], root);
  runGit(["config", "commit.gpgsign", "false"], root);
  runGit(["config", "core.hooksPath", "/dev/null"], root);
  fs.writeFileSync(path.join(root, "README.md"), "initial content\n");
  runGit(["add", "README.md"], root);
  runGit(["commit", "--quiet", "-m", "initial"], root);

  const registry = new SessionRegistry({ cwd: root });
  const session = registry.create();
  return {
    root,
    registry,
    session,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}

function policySource(
  context: RepositoryRuntimeFilesystemPolicyReadContext,
  createScope: readonly string[] = [],
): RepositoryRuntimeEffectiveFilesystemPolicySource {
  const { registry, session, evidence } = context;
  const claimsOn = session.claimEnforcement === true;
  const generation = registry.claimSetGeneration === 0 ? null : registry.claimSetGeneration;
  const compiled = compileEffectiveFilesystemPolicy({
    repository: { repositoryHost: "local", repositoryId: registry.repositoryId },
    worktree_path: session.worktreePath,
    profile: {
      status: "applied",
      digest: "a".repeat(64),
      scope: { create: createScope },
    },
    ...(claimsOn
      ? {
          claims: {
            status: "applied",
            claims: registry.claims.filter((claim) => claim.sessionId === session.sessionId),
            generation,
          },
          claim_set_generation: generation,
        }
      : {}),
    runtime_epoch: registry.runtimeEpoch === 0 ? null : registry.runtimeEpoch,
  });
  if (!compiled.ok) throw compiled.error;
  return {
    repository_id: registry.repositoryId,
    session_id: session.sessionId,
    worktree_id: session.worktreeId,
    worktree_path: session.worktreePath,
    branch_id: evidence.branchId,
    branch_name: evidence.branchName,
    head_id: evidence.headId,
    policy: compiled.value,
  };
}

function collectParsed(
  registry: SessionRegistry,
  readPolicy: (
    context: RepositoryRuntimeFilesystemPolicyReadContext,
  ) => RepositoryRuntimeEffectiveFilesystemPolicySource,
) {
  const observation = collectRepositoryRuntimeFilesystemObservation(registry, {
    now: () => new Date(CAPTURED_AT),
    readEffectiveFilesystemPolicy: readPolicy,
  });
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    registry: registry.readRepositoryView(),
    captured_at: CAPTURED_AT.toISOString(),
    filesystem: observation,
  });
  if (!snapshot.ok) throw snapshot.error;
  const parsed = parseRepositoryRuntimeObservations(snapshot.value);
  if (!parsed.ok) throw parsed.error;
  return { observation, filesystem: parsed.value.filesystem };
}

function captureRepositoryState(root: string, registry: SessionRegistry, worktreePaths: readonly string[] = [root]) {
  return {
    registry: fs.readFileSync(registry.paths.registry, "utf8"),
    view: registry.readRepositoryView(),
    sessionWorktrees: worktreePaths.map((worktreePath) => ({
      path: worktreePath,
      head: runGit(["rev-parse", "HEAD"], worktreePath),
      branch: runGit(["branch", "--show-current"], worktreePath),
      status: runGit(["status", "--porcelain=v1", "--untracked-files=all"], worktreePath),
    })),
    worktrees: runGit(["worktree", "list", "--porcelain"], root),
  };
}

test("a live worktree change updates the parser-accepted policy observation without registry mutation", () => {
  const fixture = createRepository();
  let worktreePath: string | null = null;
  try {
    const targetSession = fixture.registry.provisionSession();
    worktreePath = targetSession.worktreePath;
    const initialRevision = fixture.registry.readRepositoryView().registryRevision;
    const trackedWorktrees = [fixture.root, targetSession.worktreePath];
    const beforeCleanCollection = captureRepositoryState(fixture.root, fixture.registry, trackedWorktrees);
    const clean = collectParsed(fixture.registry, (context) => policySource(context, ["inside.txt"]));
    assert.equal(clean.observation.status, "available");
    if (clean.observation.status !== "available") return;
    assert.equal(clean.observation.observed_at, CAPTURED_AT.toISOString());
    assert.equal(clean.filesystem.get(targetSession.sessionId)?.policy_status, "unknown");
    assert.equal(clean.filesystem.get(targetSession.sessionId)?.runtime_status, "unknown");
    assert.equal(clean.filesystem.get(targetSession.sessionId)?.owner, "unknown");
    assert.deepEqual(captureRepositoryState(fixture.root, fixture.registry, trackedWorktrees), beforeCleanCollection);

    fs.writeFileSync(path.join(targetSession.worktreePath, "outside.txt"), "new file\n");
    const beforeChangedCollection = captureRepositoryState(fixture.root, fixture.registry, trackedWorktrees);
    const changed = collectParsed(fixture.registry, (context) => policySource(context, ["inside.txt"]));
    assert.equal(changed.observation.status, "available");
    assert.equal(changed.filesystem.get(targetSession.sessionId)?.policy_status, "violation");
    assert.equal(changed.filesystem.get(targetSession.sessionId)?.runtime_status, "unknown");
    assert.equal(changed.filesystem.get(targetSession.sessionId)?.owner, "unknown");
    assert.match(changed.filesystem.get(targetSession.sessionId)?.reason ?? "", /stat detail is incomplete/u);
    assert.notDeepEqual(changed.observation.value, clean.observation.value);
    assert.notDeepEqual(changed.filesystem.get(targetSession.sessionId), clean.filesystem.get(targetSession.sessionId));
    assert.deepEqual(captureRepositoryState(fixture.root, fixture.registry, trackedWorktrees), beforeChangedCollection);
    assert.equal(fixture.registry.readRepositoryView().registryRevision, initialRevision);
  } finally {
    if (worktreePath !== null) {
      try {
        runGit(["worktree", "remove", "--force", worktreePath], fixture.root);
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }
    fixture.cleanup();
  }
});

test("absent or mismatched policy and incomplete Git identity stay unknown", () => {
  const fixture = createRepository();
  try {
    const noPolicy = collectRepositoryRuntimeFilesystemObservation(fixture.registry, {
      now: () => new Date(CAPTURED_AT),
    });
    assert.equal(noPolicy.status, "available");
    if (noPolicy.status !== "available") return;
    const noPolicySessions = (noPolicy.value as unknown as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(noPolicySessions[0]?.policy_status, "unknown", JSON.stringify(noPolicy.value));
    assert.equal(noPolicySessions[0]?.owner, "unknown");

    const mismatched = collectParsed(fixture.registry, (context) => ({
      ...policySource(context),
      head_id: "f".repeat(40),
    }));
    assert.equal(mismatched.observation.status, "unknown");
    assert.equal(mismatched.filesystem.size, 0);
  } finally {
    fixture.cleanup();
  }
});

test("a policy source change during sampling invalidates the whole filesystem section", () => {
  const fixture = createRepository();
  try {
    let reads = 0;
    const observation = collectRepositoryRuntimeFilesystemObservation(fixture.registry, {
      now: () => new Date(CAPTURED_AT),
      readEffectiveFilesystemPolicy(context) {
        reads += 1;
        return policySource(context, reads === 1 ? ["inside.txt"] : ["different.txt"]);
      },
    });
    assert.equal(reads, 2);
    assert.equal(observation.status, "unknown");
    if (observation.status === "unknown") assert.match(observation.reason, /sources changed/u);
  } finally {
    fixture.cleanup();
  }
});

test("tracked changes remain unknown when Git does not identify the mutation operation", () => {
  const fixture = createRepository();
  try {
    fs.writeFileSync(path.join(fixture.root, "README.md"), "changed content\n");
    const result = collectParsed(fixture.registry, (context) => policySource(context, ["README.md"]));
    assert.equal(result.filesystem.get(fixture.session.sessionId)?.policy_status, "unknown");
    assert.match(result.filesystem.get(fixture.session.sessionId)?.reason ?? "", /exact tracked-path mutation/u);
  } finally {
    fixture.cleanup();
  }
});

test("Git worktrees without a registry session stay visible as unmanaged", () => {
  const fixture = createRepository();
  const extraWorktree = `${fixture.root}-unmanaged`;
  try {
    runGit(["worktree", "add", "--quiet", "--detach", extraWorktree, "HEAD"], fixture.root);
    const { observation } = collectParsed(fixture.registry, (context) => policySource(context));
    assert.equal(observation.status, "available");
    if (observation.status !== "available") return;
    const unmanaged = (observation.value as unknown as { unmanaged_worktrees: Array<{ worktree_path: string }> })
      .unmanaged_worktrees;
    assert.deepEqual(
      unmanaged.map((entry) => entry.worktree_path),
      [extraWorktree],
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", extraWorktree], fixture.root);
    } catch {
      fs.rmSync(extraWorktree, { recursive: true, force: true });
    }
    fixture.cleanup();
  }
});

test("claims-off omits claim generation while claims-on binds the current claim set", () => {
  const fixture = createRepository();
  let provisionedWorktree: string | null = null;
  try {
    fixture.registry.claim(fixture.session.sessionId, [{ resource: "existing.md", mode: "read" }]);
    const claimsOff = collectParsed(fixture.registry, (context) => policySource(context));
    assert.equal(claimsOff.filesystem.get(fixture.session.sessionId)?.policy_status, "unknown");
    assert.doesNotMatch(claimsOff.filesystem.get(fixture.session.sessionId)?.reason ?? "", /policy is invalid/u);

    const claimsOnSession = fixture.registry.provisionSession({
      claimEnforcement: true,
      initialClaims: [{ resource: "README.md", mode: "exclusive-write" }],
    });
    provisionedWorktree = claimsOnSession.worktreePath;
    const claimsOn = collectParsed(fixture.registry, (context) => policySource(context));
    assert.equal(claimsOn.filesystem.get(claimsOnSession.sessionId)?.policy_status, "unknown");
    assert.doesNotMatch(claimsOn.filesystem.get(claimsOnSession.sessionId)?.reason ?? "", /policy is invalid/u);
  } finally {
    if (provisionedWorktree !== null) {
      try {
        runGit(["worktree", "remove", "--force", provisionedWorktree], fixture.root);
      } catch {
        fs.rmSync(provisionedWorktree, { recursive: true, force: true });
      }
    }
    fixture.cleanup();
  }
});
