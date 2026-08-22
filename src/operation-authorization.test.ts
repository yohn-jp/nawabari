import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runCli } from "./cli.js";
import { SessionRegistryError } from "./errors.js";
import { defaultGit, type GitCommandRunner } from "./git.js";
import {
  CHECKPOINT_MAX_PATHS,
  claimModeGrantsAccess,
  OPERATION_AUTHORIZATION_POLICY,
  OPERATION_REQUIRED_ACCESS,
  OPERATION_VOCABULARY,
  requiredAccessForOperation,
} from "./operation-authorization.js";
import {
  SessionRegistry,
  toPersistedSessionRecord,
  REGISTRY_SCHEMA_VERSION,
  RESOURCE_CLAIM_SCHEMA_VERSION,
} from "./session-registry.js";

test("the operation policy is the complete, keyed authority for vocabulary and access", () => {
  assert.deepEqual(OPERATION_VOCABULARY, ["source-write", "stage", "commit", "branch-mutation", "push", "cleanup"]);
  const policyKeys = Object.keys(OPERATION_AUTHORIZATION_POLICY).sort();
  const vocabularyKeys = [...OPERATION_VOCABULARY].sort();
  const accessKeys = Object.keys(OPERATION_REQUIRED_ACCESS).sort();
  assert.deepEqual(policyKeys, vocabularyKeys);
  assert.deepEqual(accessKeys, vocabularyKeys);

  for (const operation of OPERATION_VOCABULARY) {
    const policy = OPERATION_AUTHORIZATION_POLICY[operation];
    assert.equal(requiredAccessForOperation(operation), policy.requiredAccess);
    assert.equal(OPERATION_REQUIRED_ACCESS[operation], policy.requiredAccess);
    assert.match(policy.isolationRationale, /\S/u);
    assert.match(policy.authorityRationale, /\S/u);
  }
});

test("the policy records current public enforcement separately from vocabulary-only operations", () => {
  const publicExecution = OPERATION_VOCABULARY.filter(
    (operation) => OPERATION_AUTHORIZATION_POLICY[operation].enforcement === "public-execution",
  );
  const vocabularyOnly = OPERATION_VOCABULARY.filter(
    (operation) => OPERATION_AUTHORIZATION_POLICY[operation].enforcement === "authorization-vocabulary",
  );

  // The only public mutating entry points that currently call the shared
  // operation authorization are SessionRegistry.commit and .push.
  assert.deepEqual(publicExecution, ["commit", "push"]);
  assert.deepEqual(vocabularyOnly, ["source-write", "stage", "branch-mutation", "cleanup"]);
});

test("one registry authority authorizes every operation class against concrete claims", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-authorized`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/authorized" });
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [
        { resource: "write.txt", mode: "write" },
        { resource: "exclusive.txt", mode: "exclusive-write" },
      ],
    });

    for (const operation of OPERATION_VOCABULARY) {
      const resource = requiredAccessForOperation(operation) === "write" ? "write.txt" : "exclusive.txt";
      const decision = new SessionRegistry({ cwd: worktreePath }).authorizeOperation({
        operation,
        resources: [resource],
        sessionId: session.sessionId,
      });
      assert.equal(decision.allowed, true, `${operation}: ${JSON.stringify(decision)}`);
      assert.equal(decision.code, "ALLOWED");
      assert.equal(decision.requiredAccess, requiredAccessForOperation(operation));
      assert.deepEqual(
        decision.resources.map((entry) => entry.resource),
        [resource],
      );
    }

    const exclusiveWriteOperation = OPERATION_VOCABULARY.find(
      (op) => requiredAccessForOperation(op) === "exclusive-write",
    );
    assert.ok(exclusiveWriteOperation !== undefined, "expected at least one exclusive-write operation");
    const deniedDecision = new SessionRegistry({ cwd: worktreePath }).authorizeOperation({
      operation: exclusiveWriteOperation,
      resources: ["write.txt"],
      sessionId: session.sessionId,
    });
    assert.equal(deniedDecision.allowed, false);
    assert.equal(deniedDecision.code, "INSUFFICIENT_CLAIM_MODE");
    assert.deepEqual(deniedDecision.details, {
      resource: "write.txt",
      requiredAccess: "exclusive-write",
      grantedModes: ["write"],
      sessionId: session.sessionId,
    });
    assert.ok(claimModeGrantsAccess("write", "write"));
    assert.ok(!claimModeGrantsAccess("write", "exclusive-write"));
    assert.ok(claimModeGrantsAccess("exclusive-write", "write"));
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("authorization fails closed for missing/stale sessions, context mismatch, and invalid resources", () => {
  const repositoryPath = createRepository();
  const firstWorktree = `${repositoryPath}-first`;
  const secondWorktree = `${repositoryPath}-second`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const first = registry.provision({ worktreePath: firstWorktree, branchName: "feature/first" });
    const second = registry.provision({ worktreePath: secondWorktree, branchName: "feature/second" });
    const current = new SessionRegistry({ cwd: firstWorktree });

    assert.equal(
      current.authorizeOperation({ operation: "source-write", resources: ["missing.txt"], sessionId: first.sessionId })
        .code,
      "MISSING_RESOURCE_CLAIM",
    );
    assert.equal(
      current.authorizeOperation({ operation: "source-write", resources: ["../escape"], sessionId: first.sessionId })
        .code,
      "INVALID_RESOURCE",
    );
    assert.equal(
      current.authorizeOperation({ operation: "source-write", resources: ["src/*.ts"], sessionId: first.sessionId })
        .code,
      "INVALID_RESOURCE",
    );
    assert.equal(
      current.authorizeOperation({
        operation: "source-write",
        resources: ["missing.txt"],
        sessionId: "0190f1e0-0000-7000-8000-000000000099",
      }).code,
      "SESSION_NOT_FOUND",
    );
    assert.equal(
      current.authorizeOperation({ operation: "source-write", resources: ["missing.txt"], sessionId: second.sessionId })
        .code,
      "DUPLICATE_WORKTREE_OWNERSHIP",
    );

    const staleRecord = { ...first, state: "stale" as const };
    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify(
        {
          schema_version: REGISTRY_SCHEMA_VERSION,
          repository_id: registry.repository.repositoryId,
          sessions: [toPersistedSessionRecord(staleRecord), toPersistedSessionRecord(second)],
          claims_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
          claims: [],
        },
        null,
      )}\n`,
    );
    assert.equal(
      current.authorizeOperation({ operation: "source-write", resources: ["missing.txt"], sessionId: first.sessionId })
        .code,
      "STALE_REGISTRY",
    );
  } finally {
    removeWorktree(repositoryPath, firstWorktree);
    removeWorktree(repositoryPath, secondWorktree);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("overlapping active claims produce a stable conflict decision", () => {
  const repositoryPath = createRepository();
  const firstWorktree = `${repositoryPath}-claim-first`;
  const secondWorktree = `${repositoryPath}-claim-second`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const first = registry.provision({ worktreePath: firstWorktree, branchName: "feature/claim-first" });
    const second = registry.provision({ worktreePath: secondWorktree, branchName: "feature/claim-second" });
    registry.claimResources({ sessionId: first.sessionId, claims: [{ resource: "shared.txt", mode: "write" }] });

    const decision = new SessionRegistry({ cwd: secondWorktree }).authorizeOperation({
      operation: "source-write",
      resources: ["shared.txt"],
      sessionId: second.sessionId,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "RESOURCE_CLAIM_CONFLICT");
    assert.equal(decision.details.ownerSessionId, first.sessionId);
  } finally {
    removeWorktree(repositoryPath, firstWorktree);
    removeWorktree(repositoryPath, secondWorktree);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("ordinary writes coexist with read declarations while exclusive operations do not", () => {
  const repositoryPath = createRepository();
  const firstWorktree = `${repositoryPath}-read`;
  const secondWorktree = `${repositoryPath}-write`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const reader = registry.provision({ worktreePath: firstWorktree, branchName: "feature/read" });
    const writer = registry.provision({ worktreePath: secondWorktree, branchName: "feature/write" });
    registry.claimResources({ sessionId: reader.sessionId, claims: [{ resource: "shared.txt", mode: "read" }] });
    registry.claimResources({ sessionId: writer.sessionId, claims: [{ resource: "shared.txt", mode: "write" }] });

    const ordinary = new SessionRegistry({ cwd: secondWorktree }).authorizeOperation({
      operation: "source-write",
      resources: ["shared.txt"],
      sessionId: writer.sessionId,
    });
    assert.equal(ordinary.allowed, true, JSON.stringify(ordinary));
    assert.equal(ordinary.requiredAccess, "write");

    const stronger = new SessionRegistry({ cwd: secondWorktree }).authorizeOperation({
      operation: "commit",
      resources: ["shared.txt"],
      sessionId: writer.sessionId,
    });
    assert.equal(stronger.allowed, false);
    assert.equal(stronger.code, "RESOURCE_CLAIM_CONFLICT");
    assert.equal(stronger.details.ownerSessionId, reader.sessionId);
  } finally {
    removeWorktree(repositoryPath, firstWorktree);
    removeWorktree(repositoryPath, secondWorktree);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("authorization rejects a detached physical worktree before evaluating claims", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-detached`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/detached" });
    registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "write" }] });
    runGit(["checkout", "--detach"], worktreePath);

    const decision = new SessionRegistry({ cwd: worktreePath }).authorizeOperation({
      operation: "source-write",
      resources: ["README.md"],
      sessionId: session.sessionId,
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "DETACHED_HEAD");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("checkpoint evidence is bounded, canonical, and explicitly reports out-of-claim paths", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-checkpoint`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/checkpoint" });
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [
        { resource: "README.md", mode: "write" },
        { resource: "staged.txt", mode: "write" },
        { resource: "untracked.txt", mode: "write" },
      ],
    });
    fs.writeFileSync(path.join(worktreePath, "README.md"), "changed\n");
    fs.writeFileSync(path.join(worktreePath, "staged.txt"), "staged\n");
    runGit(["add", "staged.txt"], worktreePath);
    fs.writeFileSync(path.join(worktreePath, "untracked.txt"), "untracked\n");
    fs.writeFileSync(path.join(worktreePath, "outside.txt"), "outside\n");

    const evidence = new SessionRegistry({ cwd: worktreePath }).checkpoint({ sessionId: session.sessionId });
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.source, "git");
    assert.equal(evidence.guarantee, "git-observable-only");
    assert.equal(evidence.maxPaths, CHECKPOINT_MAX_PATHS);
    assert.deepEqual(evidence.paths.changed, ["README.md", "outside.txt", "staged.txt", "untracked.txt"]);
    assert.deepEqual(evidence.paths.staged, ["staged.txt"]);
    assert.deepEqual(evidence.paths.unstaged, ["README.md"]);
    assert.deepEqual(evidence.paths.untracked, ["outside.txt", "untracked.txt"]);
    assert.deepEqual(evidence.inClaim, ["README.md", "staged.txt", "untracked.txt"]);
    assert.deepEqual(evidence.outOfClaim, ["outside.txt"]);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("checkpoint fails closed instead of silently dropping a Git-observed path it cannot canonicalize", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-unrepresentable`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/unrepresentable" });
    fs.writeFileSync(path.join(worktreePath, "README.md"), "changed\n");

    // A fake runner injects a traversal-like path Git could theoretically report
    // (e.g. via an unusual index state) that canonicalization must reject rather
    // than silently drop from the changed set.
    const injectingGit: GitCommandRunner = {
      run(args, cwd): string {
        return defaultGit.run(args, cwd);
      },
      runRaw(args, cwd): string {
        if (args[0] === "status") {
          return "?? README.md ?? ../escape.txt ";
        }
        return defaultGit.runRaw?.(args, cwd) ?? defaultGit.run(args, cwd);
      },
    };

    assert.throws(
      () => new SessionRegistry({ cwd: worktreePath, git: injectingGit }).checkpoint({ sessionId: session.sessionId }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "GIT_STATE_AMBIGUOUS" &&
        error.details.path === "../escape.txt",
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("checkpoint canonicalizes literal unusual Git path names without dropping them", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-unusual-names`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/unusual-names" });
    fs.writeFileSync(path.join(worktreePath, "weird name, spaced 名前 🎉.txt"), "literal unusual characters\n");

    const evidence = new SessionRegistry({ cwd: worktreePath }).checkpoint({ sessionId: session.sessionId });
    assert.deepEqual(evidence.paths.untracked, ["weird name, spaced 名前 🎉.txt"]);
    assert.deepEqual(evidence.outOfClaim, ["weird name, spaced 名前 🎉.txt"]);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("checkpoint fails closed on a real Git-observed path outside the claim resource syntax", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-real-unrepresentable`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/real-unrepresentable" });
    fs.writeFileSync(path.join(worktreePath, "literal(paren).txt"), "reserved glob syntax in a real filename\n");

    assert.throws(
      () => new SessionRegistry({ cwd: worktreePath }).checkpoint({ sessionId: session.sessionId }),
      (error: unknown) =>
        error instanceof SessionRegistryError &&
        error.code === "GIT_STATE_AMBIGUOUS" &&
        error.details.path === "literal(paren).txt",
    );
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("CLI exposes deterministic JSON for authorization and checkpoint evidence", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-cli`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/cli-authorization" });
    registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "write" }] });
    fs.writeFileSync(path.join(worktreePath, "README.md"), "changed\n");

    const authorizationOutput: string[] = [];
    const authorizationExit = await runCli(
      ["authorize", "--session", session.sessionId, "--operation", "source-write", "--resource", "README.md", "--json"],
      { cwd: worktreePath, io: { stdout: (line) => authorizationOutput.push(line), stderr: () => undefined } },
    );
    assert.equal(authorizationExit, 0);
    const authorization = JSON.parse(authorizationOutput[0] ?? "") as Record<string, unknown>;
    assert.equal(authorization.ok, true);
    assert.equal(authorization.command, "authorize");
    assert.equal(authorization.code, "ALLOWED");
    assert.ok(typeof authorization.schema_version === "number");
    assert.equal(authorization.required_access, "write");

    const checkpointOutput: string[] = [];
    const checkpointExit = await runCli(["checkpoint", "--session", session.sessionId, "--json"], {
      cwd: worktreePath,
      io: { stdout: (line) => checkpointOutput.push(line), stderr: () => undefined },
    });
    assert.equal(checkpointExit, 0);
    const checkpoint = JSON.parse(checkpointOutput[0] ?? "") as Record<string, unknown>;
    assert.equal(checkpoint.ok, true);
    assert.equal(checkpoint.command, "checkpoint");
    assert.deepEqual((checkpoint.paths as { changed: string[] }).changed, ["README.md"]);
    assert.ok(typeof checkpoint.schema_version === "number");
    assert.ok(Array.isArray(checkpoint.out_of_claim));
    assert.equal(typeof checkpoint.head, "string");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-authorization-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
  runGit(["config", "core.hooksPath", "/dev/null"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // Directory cleanup below is sufficient when Git already removed it.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
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
