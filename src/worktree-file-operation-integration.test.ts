import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "./cli.js";
import { success, type DomainResult } from "./domain/errors.js";
import { compileEffectiveFilesystemPolicy, type EffectiveFilesystemPolicyInputs } from "./domain/filesystem-policy.js";
import { createFilesystemPolicyToken, serializeFilesystemPolicyToken } from "./domain/filesystem-policy-revision.js";
import {
  SESSION_RUNTIME_PROJECTION_CONTRACT_ID,
  SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION,
  STRICT_RUNTIME_POLICY,
  type SessionRuntimeProjection,
} from "./domain/runtime-projection.js";
import type { FileOperationOptions, SessionBackend, SessionRecord as DomainSessionRecord } from "./domain/session.js";
import type { RuntimeExecutableProviderMaterialization } from "./domain/runtime-executable-projection.js";
import type { WorktreeFileOperation, WorktreeFileOperationResult } from "./domain/worktree-file-operation.js";
import { FILE_OPERATION_REQUIRED_FEATURE, type FileOperationRecord } from "./registry/file-operation-record.js";
import { SUPPORTED_REGISTRY_FEATURES } from "./registry/runtime-records.js";
import {
  SessionRegistry,
  type PersistedRegistryV2,
  type SessionRecord as RegistrySessionRecord,
} from "./session-registry.js";

type RepositoryIdentity = { readonly repositoryHost: string; readonly repositoryId: string };
type Fixture = {
  readonly repository: string;
  readonly worktreeRoot: string;
  readonly registry: SessionRegistry;
  readonly session: RegistrySessionRecord;
  readonly baseRevision: string;
  readonly repositoryIdentity: RepositoryIdentity;
  readonly paths: readonly string[];
};

const PROFILE_DIGEST_A = "a".repeat(64);
const PROFILE_DIGEST_B = "b".repeat(64);
const SESSION_ID = "00000000-0000-7000-8000-000000000001";

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    }),
  ).trim();
}

function createFixture(): Fixture {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-file-operation-repository-"));
  const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-file-operation-worktrees-"));
  runGit(["init", "--quiet", "-b", "main"], repository);
  runGit(["config", "user.email", "file-operation@example.invalid"], repository);
  runGit(["config", "user.name", "File Operation"], repository);
  fs.mkdirSync(path.join(repository, "docs"));
  fs.writeFileSync(path.join(repository, "docs", ".keep"), "fixture\n");
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  runGit(["add", "README.md", "docs/.keep"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);

  const registry = new SessionRegistry({ cwd: repository, worktreeRoot });
  const repositoryIdentity = { repositoryHost: "local", repositoryId: registry.repository.repositoryId };
  const baseRevision = runGit(["rev-parse", "HEAD"], repository);
  const paths = [
    "docs/applied.txt",
    "docs/legacy.txt",
    "docs/scope.txt",
    "docs/digest.txt",
    "docs/stale.txt",
    "docs/success.txt",
    "docs/unresolved.txt",
    "docs/other.txt",
    "docs/rename-source.txt",
    "docs/rename-target.txt",
  ];
  const executionScope = {
    version: 1,
    kind: "implementation-execution-scope",
    authorization: {
      version: 1,
      kind: "implementation-authorization",
      contractVersion: 1,
      implementation: { ...repositoryIdentity, number: 502 },
      governedBodyDigest: "c".repeat(64),
    },
    repository: { ...repositoryIdentity, repository: "local/nawabari" },
    base: { branch: "main", revision: baseRevision },
    scope: { readOnly: paths, write: paths, create: paths, delete: paths, deny: [] },
  };
  const candidateWorkingSet = {
    kind: "candidate-working-set",
    schemaVersion: 1,
    workingSetId: "candidate-file-operation-502",
    repository: { ...repositoryIdentity, repository: "local/nawabari" },
    revision: baseRevision,
    entries: paths.map((locator) => ({
      state: "supporting",
      target: { kind: "file", locator },
      reason: { id: "integration-test", summary: "file-operation integration" },
      evidence: [],
    })),
  };
  const session = registry.provision({
    worktreePath: path.join(worktreeRoot, "file-operation-session"),
    branchName: "feature/file-operation-502",
    baseRef: "main",
    executionScope,
    candidateWorkingSet,
    initialClaims: [{ resource: "docs/**", mode: "write" }],
  });
  return { repository, worktreeRoot, registry, session, baseRevision, repositoryIdentity, paths };
}

function cleanupFixture(fixture: Fixture): void {
  try {
    runGit(["worktree", "remove", "--force", fixture.session.worktreePath], fixture.repository);
  } catch {
    // The directory cleanup remains safe when Git metadata was already removed.
  }
  fs.rmSync(fixture.worktreeRoot, { recursive: true, force: true });
  fs.rmSync(fixture.repository, { recursive: true, force: true });
}

function readRegistry(registry: SessionRegistry): PersistedRegistryV2 {
  return JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as PersistedRegistryV2;
}

function receipt(registry: SessionRegistry, operationId: string): FileOperationRecord {
  const record = registry.fileOperations().find((candidate) => candidate.operationId === operationId);
  assert.ok(record, `missing receipt ${operationId}`);
  return record;
}

function profileBoundary(
  digest: string,
  scope: Record<string, readonly string[]> = {
    readOnly: ["docs/**"],
    write: ["docs/**"],
    create: ["docs/**"],
    delete: ["docs/**"],
    rename: ["docs/**"],
    deny: [],
    immutable: [],
  },
): Record<string, unknown> {
  return { status: "applied", identity: "profile-502", digest, revision: 1, epoch: 1, scope };
}

function policyFor(fixture: Fixture, profile: unknown, workingSet?: unknown): EffectiveFilesystemPolicyInputs {
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(workingSet === undefined ? {} : { working_set: workingSet }),
    repository: fixture.repositoryIdentity,
    base: { branch: "main", revision: fixture.baseRevision },
  };
}

function operation(
  fixture: Fixture,
  operationId: string,
  target: string,
  overrides: Partial<WorktreeFileOperation> = {},
): WorktreeFileOperation {
  return {
    contract_id: "nawabari.worktree-file-operation.v1",
    schema_version: 1,
    session_id: fixture.session.sessionId,
    operation_id: operationId,
    operation: "CREATE",
    worktree_root: fixture.repository,
    path: target,
    expected_digest: null,
    requested_generation: fixture.registry.claimSetGeneration(),
    scope: { create: [target], delete: [], deny: [] },
    claims: [],
    payload_ref: { encoding: "base64", data: Buffer.from(`payload:${operationId}`).toString("base64") },
    ...overrides,
  };
}

function stableCanonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assert.equal(Number.isFinite(value), true);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(",")}]`;
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(object[key])}`)
    .join(",")}}`;
}

function expectedAuthorityToken(
  fixture: Fixture,
  inputs: EffectiveFilesystemPolicyInputs,
  postReservationRevision: number,
): string {
  const state = readRegistry(fixture.registry);
  const session = fixture.registry.get(fixture.session.sessionId);
  assert.ok(session?.workingSet);
  const compiled = compileEffectiveFilesystemPolicy({
    ...inputs,
    repository: fixture.repositoryIdentity,
    base: { branch: "main", revision: fixture.baseRevision },
    working_set: inputs.working_set ?? session.workingSet,
    claims: fixture.registry.listClaims(fixture.session.sessionId),
    claim_set_generation: state.claim_set_generation,
    runtime_epoch: state.runtime_epoch,
    worktree_path: fixture.session.worktreePath,
  });
  if (!compiled.ok) throw new Error(compiled.error.message);
  const boundary = {
    status: compiled.value.profile.status,
    identity: compiled.value.profile.identity,
    digest: compiled.value.profile.digest,
    revision: compiled.value.profile.revision,
    epoch: compiled.value.profile.epoch,
    scope: compiled.value.profile.scope,
  };
  const profileDigest = createHash("sha256").update(stableCanonicalJson(boundary), "utf8").digest("hex");
  const token = createFilesystemPolicyToken({
    registry_revision: postReservationRevision,
    session_runtime_epoch: state.runtime_epoch,
    claim_set_generation: state.claim_set_generation,
    working_set_revision: compiled.value.provenance.working_set_revision as number,
    profile_digest: profileDigest,
    session_id: fixture.session.sessionId,
  });
  if (!token.ok) throw new Error(token.error.message);
  const serialized = serializeFilesystemPolicyToken(token.value);
  if (!serialized.ok) throw new Error(serialized.error.message);
  return `filesystem-policy:${createHash("sha256").update(serialized.value, "utf8").digest("hex")}`;
}

function python3Source(): string | null {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (directory.length === 0) continue;
    try {
      const candidate = fs.realpathSync.native(path.join(directory, "python3"));
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0 && path.basename(candidate).startsWith("python3"))
        return candidate;
    } catch {
      // Try the next runtime candidate.
    }
  }
  return null;
}

function runtimeProjection(source: string): SessionRuntimeProjection {
  return {
    contract_id: SESSION_RUNTIME_PROJECTION_CONTRACT_ID,
    schema_version: SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION,
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "development", version: "1" },
    requirements: [{ id: "landlock-helper", kind: "runtime", name: "python3", version: ">=3" }],
    filesystem: [{ source, target: source, access_mode: "read-only", provenance: "runtime-profile" }],
    executables: [
      {
        name: "python3",
        target: source,
        provider: { id: "fhs-landlock-helper-provider", requirement_id: "landlock-helper" },
        provenance: "runtime-profile",
      },
    ],
  };
}

function executionOptions(
  source: string,
  runHelper: (packet: string) => string,
): NonNullable<FileOperationOptions["execution_options"]> {
  const materialization: RuntimeExecutableProviderMaterialization = {
    provider: { id: "fhs-landlock-helper-provider", requirement_id: "landlock-helper" },
    source,
  };
  return { landlock_helper: materialization, runtime_projection: runtimeProjection(source), run_helper: runHelper };
}

function fileIdentity(file: string): { dev: string; ino: string; size: number; digest: string } {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Expected a regular file");
    const contents = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      stat.size !== contents.length ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("File changed during identity observation");
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: stat.size,
      digest: createHash("sha256").update(contents).digest("hex"),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function successfulHelper(calls: { value: number }): (packet: string) => string {
  return (packet) => {
    calls.value += 1;
    const request = JSON.parse(packet) as Record<string, string>;
    const root = request.root;
    const target = path.join(root, request.path);
    if (request.operation === "CREATE") {
      fs.writeFileSync(target, Buffer.from(request.payload_base64 ?? "", "base64"));
    } else if (request.operation === "DELETE") {
      fs.unlinkSync(target);
    } else {
      fs.renameSync(target, path.join(root, request.to_path));
    }
    const identityPath = request.operation === "DELETE" ? target : path.join(root, request.to_path ?? request.path);
    const identity =
      request.operation === "DELETE" ? JSON.parse(request.expected ?? "null") : fileIdentity(identityPath);
    return JSON.stringify({ ok: true, identity });
  };
}

function assertUncertain(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.match(error.message, /uncertain|reconciliation/u);
  return true;
}

test("file operations retain integrated registry features", () => {
  assert.ok(SUPPORTED_REGISTRY_FEATURES.includes(FILE_OPERATION_REQUIRED_FEATURE));
});

test("authority tokens hash applied, legacy, changed-scope, and changed-digest profile boundaries", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const variants: readonly [string, string, unknown][] = [
      ["applied", "docs/applied.txt", profileBoundary(PROFILE_DIGEST_A)],
      ["legacy", "docs/legacy.txt", { status: "unapplied-legacy" }],
      [
        "scope",
        "docs/scope.txt",
        profileBoundary(PROFILE_DIGEST_A, {
          readOnly: ["docs/scope.txt"],
          write: ["docs/scope.txt"],
          create: ["docs/scope.txt"],
          delete: ["docs/scope.txt"],
          rename: ["docs/scope.txt"],
          deny: [],
          immutable: [],
        }),
      ],
      ["digest", "docs/digest.txt", profileBoundary(PROFILE_DIGEST_B)],
    ];
    for (const [name, target, profile] of variants) {
      const inputs = policyFor(fixture, profile);
      const calls = { value: 0 };
      fixture.registry.executeFileOperation(operation(fixture, `profile-${name}`, target), {
        ...executionOptions(source, successfulHelper(calls)),
        policy: inputs,
      });
      assert.equal(calls.value, 1);
      const raw = readRegistry(fixture.registry);
      const record = receipt(fixture.registry, `profile-${name}`);
      assert.equal(record.authorityToken, expectedAuthorityToken(fixture, inputs, raw.registry_revision - 1));
    }
  } finally {
    cleanupFixture(fixture);
  }
});

test("reservation is durable before helper I/O and reconciliation increments only the registry revision", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const operationValue = operation(fixture, "durable-create", "docs/success.txt");
    const inputs = policyFor(fixture, profileBoundary(PROFILE_DIGEST_A));
    const initial = readRegistry(fixture.registry);
    const calls = { value: 0 };
    const beforeHelper: { raw?: PersistedRegistryV2; absent?: boolean } = {};
    fixture.registry.executeFileOperation(operationValue, {
      ...executionOptions(source, (packet) => {
        beforeHelper.raw = readRegistry(fixture.registry);
        beforeHelper.absent = !fs.existsSync(path.join(fixture.session.worktreePath, operationValue.path));
        return successfulHelper(calls)(packet);
      }),
      policy: inputs,
    });
    assert.equal(calls.value, 1);
    assert.equal(beforeHelper.absent, true);
    assert.equal(beforeHelper.raw?.registry_revision, (initial.registry_revision ?? 0) + 1);
    assert.deepEqual(beforeHelper.raw?.required_features, [
      "recent-events.v1",
      "session-history.v1",
      FILE_OPERATION_REQUIRED_FEATURE,
    ]);
    const reserved = beforeHelper.raw?.file_operations?.find((record) => record.operation_id === "durable-create");
    assert.equal(reserved?.stage, "apply-recorded");
    assert.equal(reserved?.apply_attempts, 1);
    const final = readRegistry(fixture.registry);
    assert.equal(final.registry_revision, (initial.registry_revision ?? 0) + 2);
    assert.equal(final.claim_set_generation, initial.claim_set_generation);
    assert.equal(final.runtime_epoch, initial.runtime_epoch);
    assert.equal(receipt(fixture.registry, "durable-create").stage, "completed");
    assert.equal(receipt(fixture.registry, "durable-create").effectObserved, true);
    assert.equal(receipt(fixture.registry, "durable-create").executionCompleted, true);
    assert.equal(fs.existsSync(path.join(fixture.session.worktreePath, operationValue.path)), true);
    assert.equal(
      expectedAuthorityToken(fixture, inputs, final.registry_revision - 1),
      receipt(fixture.registry, "durable-create").authorityToken,
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("rename reconciliation uses the helper result identity instead of the expected source identity", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const sourceFile = path.join(fixture.session.worktreePath, "docs/rename-source.txt");
    fs.writeFileSync(sourceFile, "rename-me\n");
    const expectedIdentity = fileIdentity(sourceFile);
    const rename = operation(fixture, "rename-result-identity", "docs/rename-source.txt", {
      operation: "RENAME",
      to_path: "docs/rename-target.txt",
      expected_digest: null,
      expected_identity: expectedIdentity,
      scope: { create: ["docs/rename-target.txt"], delete: ["docs/rename-source.txt"], deny: [] },
      payload_ref: undefined,
    });
    const policy = policyFor(fixture, undefined, {
      ...fixture.session.workingSet,
      scope: { ...fixture.session.workingSet?.scope, rename: ["docs/rename-source.txt", "docs/rename-target.txt"] },
    });
    const calls = { value: 0 };
    const helper = successfulHelper(calls);
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(rename, {
          ...executionOptions(source, (packet) => {
            const response = JSON.parse(helper(packet)) as { ok: boolean; identity: Record<string, unknown> };
            response.identity = { ...response.identity, ino: "999999999" };
            return JSON.stringify(response);
          }),
          policy,
        }),
      assertUncertain,
    );
    assert.equal(calls.value, 1);
    assert.equal(fs.existsSync(sourceFile), false);
    assert.equal(fs.existsSync(path.join(fixture.session.worktreePath, "docs/rename-target.txt")), true);
    const record = receipt(fixture.registry, "rename-result-identity");
    assert.equal(record.stage, "unresolved");
    assert.equal(record.effectObserved, false);
    assert.equal(record.executionCompleted, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("stale pre-I/O authority performs no helper I/O and persists unresolved evidence", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const first = policyFor(fixture, profileBoundary(PROFILE_DIGEST_A));
    const changed = policyFor(
      fixture,
      profileBoundary(PROFILE_DIGEST_A, {
        readOnly: ["docs/stale.txt"],
        write: ["docs/stale.txt"],
        create: ["docs/stale.txt"],
        delete: ["docs/stale.txt"],
        rename: ["docs/stale.txt"],
        deny: [],
        immutable: [],
      }),
      { ...fixture.session.workingSet, revision: 2 },
    );
    let policyCalls = 0;
    const helperCalls = { value: 0 };
    const initial = readRegistry(fixture.registry);
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(operation(fixture, "stale-before-io", "docs/stale.txt"), {
          ...executionOptions(source, () => {
            helperCalls.value += 1;
            return JSON.stringify({ ok: true });
          }),
          policy: () => {
            policyCalls += 1;
            return policyCalls === 1 ? first : changed;
          },
        }),
      assertUncertain,
    );
    assert.equal(policyCalls, 2);
    assert.equal(helperCalls.value, 0);
    const final = readRegistry(fixture.registry);
    assert.equal(final.registry_revision, (initial.registry_revision ?? 0) + 2);
    assert.equal(final.claim_set_generation, initial.claim_set_generation);
    assert.equal(final.runtime_epoch, initial.runtime_epoch);
    const stored = receipt(fixture.registry, "stale-before-io");
    assert.equal(stored.stage, "unresolved");
    assert.equal(stored.effectObserved, false);
    assert.equal(stored.executionCompleted, false);
  } finally {
    cleanupFixture(fixture);
  }
});

test("finalization collects policy outside the lock and rejects a post-helper claim race without replaying I/O", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const operationValue = operation(fixture, "stale-final-lock", "docs/stale.txt");
    const policy = policyFor(fixture, profileBoundary(PROFILE_DIGEST_A));
    const initial = readRegistry(fixture.registry);
    const helperCalls = { value: 0 };
    let policyCalls = 0;
    let finalizationPolicyMutationCompleted = false;
    const first = fixture.registry.executeFileOperation;
    assert.throws(
      () =>
        first.call(fixture.registry, operationValue, {
          ...executionOptions(source, successfulHelper(helperCalls)),
          policy: () => {
            policyCalls += 1;
            if (policyCalls === 4) {
              fixture.registry.releaseSessionClaims(fixture.session.sessionId);
              finalizationPolicyMutationCompleted = true;
            }
            return policy;
          },
        }),
      assertUncertain,
    );

    assert.equal(policyCalls, 4);
    assert.equal(finalizationPolicyMutationCompleted, true);
    assert.equal(helperCalls.value, 1);
    const final = readRegistry(fixture.registry);
    assert.equal(final.registry_revision, (initial.registry_revision ?? 0) + 3);
    const stored = receipt(fixture.registry, operationValue.operation_id);
    assert.equal(stored.stage, "unresolved");
    assert.equal(stored.effectObserved, true);
    assert.equal(stored.executionCompleted, false);
    assert.equal(fs.existsSync(path.join(fixture.session.worktreePath, operationValue.path)), true);

    assert.throws(
      () =>
        fixture.registry.executeFileOperation(operationValue, {
          ...executionOptions(source, () => {
            helperCalls.value += 1;
            throw new Error("unresolved receipt must not replay helper I/O");
          }),
          policy,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /uncertain|reconciliation|stale/u);
        return true;
      },
    );
    assert.equal(helperCalls.value, 1);
    assert.deepEqual(readRegistry(fixture.registry), final);
  } finally {
    cleanupFixture(fixture);
  }
});

test("completed, apply-recorded, and unresolved retries never execute a second helper", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const completedOperation = operation(fixture, "retry-completed", "docs/success.txt");
    const completedCalls = { value: 0 };
    const options = executionOptions(source, successfulHelper(completedCalls));
    const initial = readRegistry(fixture.registry);
    const first = fixture.registry.executeFileOperation(completedOperation, options);
    assert.equal(first.state, "applied");
    const afterFirst = readRegistry(fixture.registry);
    const retry = fixture.registry.executeFileOperation(completedOperation, {
      ...options,
      run_helper: () => {
        completedCalls.value += 1;
        throw new Error("second helper invocation");
      },
    });
    assert.equal(retry.state, "applied");
    assert.equal("identity" in retry, false);
    assert.equal(completedCalls.value, 1);
    assert.deepEqual(readRegistry(fixture.registry), afterFirst);
    assert.equal(afterFirst.registry_revision, (initial.registry_revision ?? 0) + 2);

    const unresolvedOperation = operation(fixture, "retry-unresolved", "docs/unresolved.txt");
    const unresolvedCalls = { value: 0 };
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(
          unresolvedOperation,
          executionOptions(source, (packet) => {
            unresolvedCalls.value += 1;
            const request = JSON.parse(packet) as Record<string, string>;
            const target = path.join(request.root, request.path);
            fs.writeFileSync(target, Buffer.from(request.payload_base64 ?? "", "base64"));
            return JSON.stringify({ ok: false, uncertain: true, code: "HELPER_TIMEOUT" });
          }),
        ),
      assertUncertain,
    );
    assert.equal(unresolvedCalls.value, 1);
    const unresolvedAfter = readRegistry(fixture.registry);
    const unresolvedRecord = receipt(fixture.registry, "retry-unresolved");
    assert.equal(unresolvedRecord.stage, "unresolved");
    assert.equal(unresolvedRecord.effectObserved, true);
    assert.equal(unresolvedRecord.executionCompleted, false);
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(unresolvedOperation, {
          ...executionOptions(source, () => {
            unresolvedCalls.value += 1;
            throw new Error("second unresolved helper invocation");
          }),
        }),
      assertUncertain,
    );
    assert.equal(unresolvedCalls.value, 1);
    assert.deepEqual(readRegistry(fixture.registry), unresolvedAfter);

    const applyRecordedOperation = operation(fixture, "retry-apply-recorded", "docs/other.txt");
    const applyCalls = { value: 0 };
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(
          applyRecordedOperation,
          executionOptions(source, () => {
            applyCalls.value += 1;
            return JSON.stringify({ ok: false, uncertain: true, code: "HELPER_TIMEOUT" });
          }),
        ),
      assertUncertain,
    );
    const applyRaw = readRegistry(fixture.registry);
    const applyIndex =
      applyRaw.file_operations?.findIndex((record) => record.operation_id === "retry-apply-recorded") ?? -1;
    assert.ok(applyRaw.file_operations && applyIndex >= 0);
    const applyEdited: PersistedRegistryV2 = {
      ...applyRaw,
      file_operations: applyRaw.file_operations.map((record, index) =>
        index === applyIndex
          ? { ...record, stage: "apply-recorded", effect_observed: false, execution_completed: false }
          : record,
      ),
    };
    fs.writeFileSync(fixture.registry.paths.registry, `${JSON.stringify(applyEdited, null, 2)}\n`);
    const applyBeforeRetry = readRegistry(fixture.registry);
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(applyRecordedOperation, {
          ...executionOptions(source, () => {
            applyCalls.value += 1;
            throw new Error("second apply-recorded helper invocation");
          }),
        }),
      assertUncertain,
    );
    assert.equal(applyCalls.value, 1);
    assert.deepEqual(readRegistry(fixture.registry), applyBeforeRetry);
  } finally {
    cleanupFixture(fixture);
  }
});

test("operation-id collision rejects without mutation and restart replays the durable receipt", () => {
  const fixture = createFixture();
  const source = python3Source();
  try {
    if (source === null) return;
    const original = operation(fixture, "collision", "docs/success.txt");
    const calls = { value: 0 };
    fixture.registry.executeFileOperation(original, executionOptions(source, successfulHelper(calls)));
    const beforeCollision = readRegistry(fixture.registry);
    const different = operation(fixture, "collision", "docs/other.txt");
    assert.throws(
      () => fixture.registry.executeFileOperation(different, executionOptions(source, successfulHelper(calls))),
      (error: unknown) => error instanceof Error && error.message.includes("operation_id"),
    );
    assert.deepEqual(readRegistry(fixture.registry), beforeCollision);
    const restarted = new SessionRegistry({ cwd: fixture.repository, worktreeRoot: fixture.worktreeRoot });
    const replay = restarted.executeFileOperation(original, {
      ...executionOptions(source, () => {
        calls.value += 1;
        throw new Error("restart replay executed helper");
      }),
    });
    assert.equal(replay.state, "applied");
    assert.equal(calls.value, 1);
    assert.deepEqual(
      restarted.fileOperations(fixture.session.sessionId),
      fixture.registry.fileOperations(fixture.session.sessionId),
    );
  } finally {
    cleanupFixture(fixture);
  }
});

test("CLI create/delete/rename dispatch uses the accepted parser, materializer, projector, and serializer", async () => {
  const calls: WorktreeFileOperation[] = [];
  const session = {
    schema_version: 1,
    session_id: SESSION_ID,
    repository: "repo",
    worktree: "/tmp",
    branch: "main",
    state: "active",
  } as unknown as DomainSessionRecord;
  const backend = {
    getSession: async () => success(session),
    listClaims: async () => success({ claims: [{ resource: "docs/**", mode: "write" }], claim_set_generation: 4 }),
    fileOperation: async (
      _context: unknown,
      options: FileOperationOptions,
    ): Promise<DomainResult<WorktreeFileOperationResult>> => {
      calls.push(options.operation);
      return success({
        contract_id: "nawabari.worktree-file-operation.v1",
        schema_version: 1,
        operation_id: options.operation.operation_id,
        operation: options.operation.operation,
        state: "applied",
        previous_generation: options.operation.requested_generation,
        next_generation: options.operation.requested_generation + 1,
        identity: { dev: "1", ino: "2", size: 0, digest: "a".repeat(64) },
        postcondition: {
          kind: "rebuild-execution-view",
          reason: "physical-operation-applied",
          generation: options.operation.requested_generation + 1,
        },
      });
    },
  } as unknown as SessionBackend;
  const output: string[] = [];
  const io = { stdout: (line: string) => output.push(line), stderr: () => undefined };
  const payloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-file-operation-cli-payload-"));
  const payloadFile = path.join(payloadDirectory, "payload.txt");
  fs.writeFileSync(payloadFile, "cli payload\n");
  const commands = [
    [
      "session",
      "file",
      "create",
      "--session",
      SESSION_ID,
      "--operation-id",
      "cli-create",
      "--path",
      "docs/create.txt",
      "--if-generation",
      "4",
      "--expect-absent",
      "--payload-file",
      payloadFile,
    ],
    [
      "session",
      "file",
      "delete",
      "--session",
      SESSION_ID,
      "--operation-id",
      "cli-delete",
      "--path",
      "docs/delete.txt",
      "--if-generation",
      "4",
      "--expected-digest",
      "a".repeat(64),
    ],
    [
      "session",
      "file",
      "rename",
      "--session",
      SESSION_ID,
      "--operation-id",
      "cli-rename",
      "--path",
      "docs/source.txt",
      "--to-path",
      "docs/target.txt",
      "--if-generation",
      "4",
      "--expected-digest",
      "a".repeat(64),
    ],
  ];
  for (const command of commands) {
    output.length = 0;
    const code = await runCli([...command, "--json"], { backend, cwd: "/tmp", io });
    assert.equal(code, 0);
    assert.equal(output.length, 1);
    const rendered = JSON.parse(output[0] ?? "") as Record<string, unknown>;
    assert.equal(rendered.ok, true);
    assert.equal((rendered.cli as Record<string, unknown>).state, "applied");
  }
  assert.deepEqual(
    calls.map((entry) => entry.operation),
    ["CREATE", "DELETE", "RENAME"],
  );
  assert.deepEqual(
    calls.map((entry) => entry.scope),
    [
      { create: ["docs/create.txt"], delete: [], deny: [] },
      { create: [], delete: ["docs/delete.txt"], deny: [] },
      { create: ["docs/target.txt"], delete: ["docs/source.txt"], deny: [] },
    ],
  );
  fs.rmSync(payloadDirectory, { recursive: true, force: true });
});

test("missing working-set revision fails before reserving a receipt", () => {
  const fixture = createFixture();
  try {
    const inputs = policyFor(fixture, profileBoundary(PROFILE_DIGEST_A), {
      ...fixture.session.workingSet,
      revision: null,
    });
    assert.throws(
      () =>
        fixture.registry.executeFileOperation(operation(fixture, "missing-revision", "docs/stale.txt"), {
          landlock_helper: null,
          runtime_projection: null,
          policy: inputs,
        }),
      (error: unknown) => error instanceof Error && /working[_-]set|revision/u.test(error.message),
    );
    assert.deepEqual(fixture.registry.fileOperations(fixture.session.sessionId), []);
  } finally {
    cleanupFixture(fixture);
  }
});
