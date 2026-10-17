import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./domain/errors.js";
import { launchManagedSessionCommand } from "./domain/session-console.js";
import {
  SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID,
  SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION,
  type SessionBackend,
  type SessionContext,
  type SessionVerificationSnapshot,
} from "./domain/session.js";
import { isSandboxExecutionEvidenceSnapshot } from "./domain/sandbox-execution-evidence.js";
import { isSessionId } from "./session-id.js";

export const SESSION_CANDIDATE_BUNDLE_CONTRACT_ID = "nawabari.session-candidate-bundle.v1" as const;
export const SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SESSION_CANDIDATE_BUNDLE_RESULT_SCHEMA = "nawabari.session-candidate-bundle.v1" as const;
export const SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID = "nawabari.session-candidate-bundle-paths.v1" as const;
export const SESSION_CANDIDATE_BUNDLE_PATHS_RESULT_SCHEMA = "nawabari.session-candidate-bundle-paths.v1" as const;
export const MAX_SESSION_CANDIDATE_BUNDLE_BYTES = 64 * 1024 * 1024;

export type SessionCandidateBundleSource = Readonly<{
  project_id: string;
  source_id: string;
  bundle_sha256: string;
  base_commit: string;
  candidate_commit: string;
  candidate_tree: string;
}>;

export type SessionCandidateBundleRequest = Readonly<{
  contract_id: typeof SESSION_CANDIDATE_BUNDLE_CONTRACT_ID;
  schema_version: typeof SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION;
  session_id: string;
  snapshot: SessionVerificationSnapshot;
  candidate_id: string;
  candidate_digest: string;
  bundles: readonly SessionCandidateBundleSource[];
}>;

export type SessionCandidateBundleStageResult = Readonly<{
  contract_id: typeof SESSION_CANDIDATE_BUNDLE_CONTRACT_ID;
  schema_version: typeof SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION;
  producer: Readonly<{ package: "nawabari"; version: string }>;
  session_id: string;
  candidate_id: string;
  candidate_digest: string;
  snapshot: SessionVerificationSnapshot;
  source: SessionCandidateBundleSource & Readonly<{ worktree: string; head_id: string; tree_id: string }>;
  managed_execution: Readonly<{
    execution_id: string;
    state: string;
    supervisor_status: string;
    physical_execution: JsonObject;
    owned_scope: JsonObject;
  }>;
  receipt_sha256: string;
}>;

export type SessionCandidateBundlePathsResult = Readonly<{
  contract_id: typeof SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID;
  schema_version: typeof SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION;
  producer: Readonly<{ package: "nawabari"; version: string }>;
  session_id: string;
  candidate_id: string;
  candidate_digest: string;
  snapshot: SessionVerificationSnapshot;
  transfers: readonly Readonly<{
    project_id: string;
    source_id: string;
    bundle_sha256: string;
    staging_root: string;
    transfer_path: string;
    repository_path: string;
  }>[];
  receipt_sha256: string;
}>;

const packageMetadata = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};
const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const digest = /^sha256:([0-9a-f]{64})$/u;
const MAX_REQUEST_BYTES = 1 * 1024 * 1024;

function canonicalClone(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("cyclic request data");
    ancestors.add(value);
    const cloned = value.map((entry) => canonicalClone(entry, ancestors));
    ancestors.delete(value);
    return cloned;
  }
  if (typeof value === "object" && value !== null) {
    if (ancestors.has(value)) throw new TypeError("cyclic request data");
    ancestors.add(value);
    const cloned: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      cloned[key] = canonicalClone((value as Record<string, unknown>)[key], ancestors);
    ancestors.delete(value);
    return cloned;
  }
  throw new TypeError("request contains non-JSON data");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalClone(value));
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalid(message: string, field: string): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, { field }));
}

function parseSnapshot(value: unknown, sessionId: string): SessionVerificationSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const snapshot = value as SessionVerificationSnapshot;
  const token = snapshot.filesystem_policy_token;
  const managed = snapshot.managed;
  if (
    snapshot.contract_id !== SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID ||
    snapshot.schema_version !== SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.session_id !== sessionId ||
    typeof snapshot.repository !== "string" ||
    typeof snapshot.worktree !== "string" ||
    !path.isAbsolute(snapshot.worktree) ||
    path.resolve(snapshot.worktree) !== snapshot.worktree ||
    typeof snapshot.branch !== "string" ||
    snapshot.state !== "active" ||
    typeof token !== "object" ||
    token === null ||
    token.session_id !== sessionId ||
    typeof token.profile_digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(token.profile_digest) ||
    typeof token.registry_revision !== "number" ||
    typeof token.claim_set_generation !== "number" ||
    typeof token.working_set_revision !== "number" ||
    typeof managed !== "object" ||
    managed === null ||
    managed.admission !== "open" ||
    managed.profile_digest !== token.profile_digest ||
    managed.registry_revision !== token.registry_revision ||
    managed.claim_set_generation !== token.claim_set_generation ||
    managed.runtime_epoch !== token.session_runtime_epoch
  )
    return null;
  return snapshot;
}

function parseRequest(value: unknown): DomainResult<SessionCandidateBundleRequest> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid("Candidate bundle request must be an object.", "request");
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(value), "utf8");
  } catch {
    return invalid("Candidate bundle request must contain bounded JSON data.", "request");
  }
  if (bytes > MAX_REQUEST_BYTES) return invalid("Candidate bundle request exceeds its size bound.", "request");
  const request = value as Record<string, unknown>;
  if (request.contract_id !== SESSION_CANDIDATE_BUNDLE_CONTRACT_ID)
    return invalid("Candidate bundle contract is unsupported.", "contract_id");
  if (request.schema_version !== SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION)
    return invalid("Candidate bundle schema version is unsupported.", "schema_version");
  if (typeof request.session_id !== "string" || !isSessionId(request.session_id))
    return invalid("A canonical owned session identity is required.", "session_id");
  const snapshot = parseSnapshot(request.snapshot, request.session_id);
  if (snapshot === null) return invalid("The owner snapshot must identify the active managed session.", "snapshot");
  if (typeof request.candidate_id !== "string" || request.candidate_id.length < 1 || request.candidate_id.length > 256)
    return invalid("Candidate identity is missing or oversized.", "candidate_id");
  if (typeof request.candidate_digest !== "string" || !digest.test(request.candidate_digest))
    return invalid("Candidate digest must be a SHA-256 identity.", "candidate_digest");
  if (!Array.isArray(request.bundles) || request.bundles.length !== 1)
    return invalid("This source-witness contract requires exactly one Git source bundle.", "bundles");
  const bundles: SessionCandidateBundleSource[] = [];
  for (const [index, value] of request.bundles.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return invalid("Candidate source bundle must be an object.", `bundles.${index}`);
    const bundle = value as Record<string, unknown>;
    if (typeof bundle.project_id !== "string" || bundle.project_id.length < 1 || bundle.project_id.length > 256)
      return invalid("Project identity is missing or oversized.", `bundles.${index}.project_id`);
    if (typeof bundle.source_id !== "string" || bundle.source_id.length < 1 || bundle.source_id.length > 256)
      return invalid("Source identity is missing or oversized.", `bundles.${index}.source_id`);
    if (typeof bundle.bundle_sha256 !== "string" || !digest.test(bundle.bundle_sha256))
      return invalid("Bundle digest must be a SHA-256 identity.", `bundles.${index}.bundle_sha256`);
    if (typeof bundle.base_commit !== "string" || !gitObjectId.test(bundle.base_commit))
      return invalid("Base commit must be a full Git object identity.", `bundles.${index}.base_commit`);
    if (typeof bundle.candidate_commit !== "string" || !gitObjectId.test(bundle.candidate_commit))
      return invalid("Candidate commit must be a full Git object identity.", `bundles.${index}.candidate_commit`);
    if (typeof bundle.candidate_tree !== "string" || !gitObjectId.test(bundle.candidate_tree))
      return invalid("Candidate tree must be a full Git object identity.", `bundles.${index}.candidate_tree`);
    bundles.push({
      project_id: bundle.project_id,
      source_id: bundle.source_id,
      bundle_sha256: bundle.bundle_sha256,
      base_commit: bundle.base_commit,
      candidate_commit: bundle.candidate_commit,
      candidate_tree: bundle.candidate_tree,
    });
  }
  const sourceKeys = bundles.map(({ project_id, source_id }) => `${project_id}\0${source_id}`);
  if (new Set(sourceKeys).size !== sourceKeys.length)
    return invalid("Candidate source identities must be unique.", "bundles");
  return success({
    contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    schema_version: SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
    session_id: request.session_id,
    snapshot,
    candidate_id: request.candidate_id,
    candidate_digest: request.candidate_digest,
    bundles,
  });
}

/** Public deterministic transfer location; callers cannot choose a path or widen the owned worktree. */
function candidateStagingIdentity(
  candidateDigest: string,
  projectId: string,
  sourceId: string,
): {
  candidateHex: string;
  sourceKey: string;
} {
  const candidate = digest.exec(candidateDigest);
  if (!candidate || projectId.length < 1 || sourceId.length < 1 || projectId.length > 256 || sourceId.length > 256)
    throw new TypeError("candidate bundle transfer identity is invalid");
  return {
    candidateHex: candidate[1]!,
    sourceKey: sha256(`${projectId}\0${sourceId}`).slice(0, 24),
  };
}

/** Public deterministic root for owner-only candidate staging; callers cannot choose filesystem paths. */
export function sessionCandidateBundleStagingRootPath(
  worktree: string,
  candidateDigest: string,
  projectId: string,
  sourceId: string,
): string {
  const identity = candidateStagingIdentity(candidateDigest, projectId, sourceId);
  if (!path.isAbsolute(worktree) || path.resolve(worktree) !== worktree)
    throw new TypeError("candidate bundle transfer identity is invalid");
  return path.join(worktree, ".nawabari-verification-candidates", identity.candidateHex, identity.sourceKey);
}

/** Public deterministic transfer location, within the exact candidate/source-owned scratch root. */
export function sessionCandidateBundleTransferPath(
  worktree: string,
  candidateDigest: string,
  projectId: string,
  sourceId: string,
  bundleSha256: string,
): string {
  const bundle = digest.exec(bundleSha256);
  if (!bundle) throw new TypeError("candidate bundle transfer identity is invalid");
  return path.join(
    sessionCandidateBundleStagingRootPath(worktree, candidateDigest, projectId, sourceId),
    `.candidate-${bundle[1]}.bundle`,
  );
}

/** Resolve exact transfer/repository paths only after verifying the owner snapshot. */
export async function describeSessionCandidateBundlePaths(
  context: SessionContext,
  backend: SessionBackend,
  requestInput: SessionCandidateBundleRequest | unknown,
): Promise<DomainResult<SessionCandidateBundlePathsResult>> {
  const parsed = parseRequest(requestInput);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (backend.getSessionVerificationSnapshot === undefined)
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The owned session snapshot authority is unavailable.", {
        operation: "verification.candidate-paths",
      }),
    );
  const observed = await backend.getSessionVerificationSnapshot(context, request.session_id);
  if (!observed.ok) return observed;
  if (!isDeepStrictEqual(observed.value, request.snapshot))
    return failure(
      new DomainError("STALE_REGISTRY", "Candidate transfer paths require the exact current owner snapshot.", {
        session_id: request.session_id,
      }),
    );
  const transfers = request.bundles.map((source) => ({
    project_id: source.project_id,
    source_id: source.source_id,
    bundle_sha256: source.bundle_sha256,
    staging_root: sessionCandidateBundleStagingRootPath(
      request.snapshot.worktree,
      request.candidate_digest,
      source.project_id,
      source.source_id,
    ),
    transfer_path: sessionCandidateBundleTransferPath(
      request.snapshot.worktree,
      request.candidate_digest,
      source.project_id,
      source.source_id,
      source.bundle_sha256,
    ),
    repository_path: candidatePath(request.snapshot, request, source),
  }));
  const payload = {
    contract_id: SESSION_CANDIDATE_BUNDLE_PATHS_CONTRACT_ID,
    schema_version: SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
    producer: { package: "nawabari" as const, version: packageMetadata.version },
    session_id: request.session_id,
    candidate_id: request.candidate_id,
    candidate_digest: request.candidate_digest,
    snapshot: request.snapshot,
    transfers,
  };
  return success({ ...payload, receipt_sha256: sha256(canonicalJson(payload)) });
}

function candidatePath(
  snapshot: SessionVerificationSnapshot,
  request: SessionCandidateBundleRequest,
  source: SessionCandidateBundleSource,
): string {
  const candidateHex = digest.exec(request.candidate_digest)![1]!;
  const sourceKey = sha256(`${source.project_id}\0${source.source_id}`).slice(0, 24);
  return path.join(snapshot.worktree, ".nawabari-verification-candidates", candidateHex, sourceKey, "repo");
}

function requestFenceMatches(expected: SessionVerificationSnapshot, actual: SessionVerificationSnapshot): boolean {
  return (
    actual.session_id === expected.session_id &&
    actual.repository === expected.repository &&
    actual.worktree === expected.worktree &&
    actual.branch === expected.branch &&
    actual.state === "active" &&
    actual.managed.admission === "open" &&
    actual.managed.profile_digest === expected.managed.profile_digest &&
    actual.managed.runtime_epoch === expected.managed.runtime_epoch &&
    actual.managed.claim_set_generation === expected.managed.claim_set_generation &&
    actual.filesystem_policy_token.profile_digest === expected.filesystem_policy_token.profile_digest &&
    actual.filesystem_policy_token.session_runtime_epoch === expected.filesystem_policy_token.session_runtime_epoch &&
    actual.filesystem_policy_token.claim_set_generation === expected.filesystem_policy_token.claim_set_generation &&
    actual.filesystem_policy_token.working_set_revision === expected.filesystem_policy_token.working_set_revision
  );
}

function bundleFileIsCurrent(worktree: string, candidateDigest: string, source: SessionCandidateBundleSource): boolean {
  const stagingRoot = sessionCandidateBundleStagingRootPath(
    worktree,
    candidateDigest,
    source.project_id,
    source.source_id,
  );
  const bundlePath = sessionCandidateBundleTransferPath(
    worktree,
    candidateDigest,
    source.project_id,
    source.source_id,
    source.bundle_sha256,
  );
  try {
    const root = fs.realpathSync(worktree);
    const stagingStat = fs.lstatSync(stagingRoot);
    const realBundlePath = fs.realpathSync(bundlePath);
    const stat = fs.lstatSync(bundlePath);
    const expected = digest.exec(source.bundle_sha256)![1]!;
    return (
      root === worktree &&
      fs.realpathSync(stagingRoot) === stagingRoot &&
      stagingStat.isDirectory() &&
      !stagingStat.isSymbolicLink() &&
      (stagingStat.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || stagingStat.uid === process.getuid()) &&
      realBundlePath === bundlePath &&
      path.dirname(realBundlePath) === stagingRoot &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || stat.uid === process.getuid()) &&
      stat.size > 0 &&
      stat.size <= MAX_SESSION_CANDIDATE_BUNDLE_BYTES &&
      sha256(fs.readFileSync(bundlePath)) === expected
    );
  } catch {
    return false;
  }
}

const stageScript = String.raw`
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const [worktree,bundlePath,candidateRoot,candidatePath,candidateHex,sourceKey,expectedSha,base,head,tree]=process.argv.slice(1);
const fail=(message)=>{process.stderr.write(message+'\n');process.exit(41)};
const within=(root,value)=>{const rel=path.relative(root,value);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)};
const expectedRoot=path.join(worktree,'.nawabari-verification-candidates',candidateHex,sourceKey);
if(fs.realpathSync(worktree)!==worktree||candidateRoot!==expectedRoot||candidatePath!==path.join(candidateRoot,'repo')||bundlePath!==path.join(candidateRoot,'.candidate-'+expectedSha+'.bundle')||!within(worktree,bundlePath)||!within(worktree,candidateRoot)||!within(worktree,candidatePath))fail('candidate stage path escaped the owned worktree');
const rootStat=fs.lstatSync(candidateRoot);if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||(rootStat.mode&0o077)!==0)fail('candidate stage root is not a private owner directory');
const st=fs.lstatSync(bundlePath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0||st.size<1||st.size>67108864)fail('candidate bundle file is not bounded and owner-private');
const bytes=fs.readFileSync(bundlePath);if(createHash('sha256').update(bytes).digest('hex')!==expectedSha)fail('candidate bundle digest changed before import');
const git=(args,cwd=candidatePath)=>execFileSync('/nawabari/bin/git',['-c','core.hooksPath=/dev/null',...args],{cwd,stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:1048576,env:{PATH:'/nawabari/bin:/usr/bin:/bin',HOME:'/home/nawabari',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}}).trim();
const repoExists=fs.existsSync(candidatePath);
if(repoExists){const repoStat=fs.lstatSync(candidatePath);if(!repoStat.isDirectory()||repoStat.isSymbolicLink()||(repoStat.mode&0o077)!==0)fail('existing candidate repository is not owner-private');}
else fs.mkdirSync(candidatePath,{mode:0o700});
if(!fs.existsSync(path.join(candidatePath,'.git')))git(['init','--quiet'],candidatePath);
const baseRef='refs/nawabari/bases/'+candidateHex;
const ref='refs/nawabari/candidates/'+candidateHex+'/'+sourceKey;
const baseExists=(()=>{try{return git(['rev-parse','--verify',baseRef])===base}catch{return false}})();
if(!baseExists){git(['fetch','--no-tags','--no-write-fetch-head',worktree,base+':'+baseRef],candidatePath);if(git(['rev-parse','--verify',baseRef])!==base)fail('owned source base differs from the declared exact base');}
git(['bundle','verify',bundlePath]);
const heads=git(['bundle','list-heads',bundlePath]).split('\n').filter(Boolean);
if(heads.length!==1||heads[0]!==head+' refs/heads/mottainai-candidate')fail('bundle advertises a different candidate ref');
let refExists=false;try{git(['show-ref','--verify','--quiet',ref]);refExists=true}catch{}
if(!refExists){
 git(['fetch','--no-tags','--no-write-fetch-head',bundlePath,'refs/heads/mottainai-candidate:'+ref]);
 const importedHead=git(['rev-parse','--verify',ref+'^{commit}']);
 const importedTree=git(['rev-parse','--verify',ref+'^{tree}']);
 if(importedHead!==head||importedTree!==tree)fail('imported candidate commit or tree differs from the source owner');
 try{git(['merge-base','--is-ancestor',base,ref]);}catch{fail('candidate commit is not descended from its exact source base');}
}
if(git(['rev-parse','--verify',ref+'^{commit}'])!==head)fail('existing candidate ref differs from the exact source identity');
git(['checkout','--detach','--force',head],candidatePath);
const finalHead=git(['rev-parse','--verify','HEAD'],candidatePath);
const finalTree=git(['rev-parse','--verify','HEAD^{tree}'],candidatePath);
const clean=git(['status','--porcelain','--untracked-files=all'],candidatePath);
if(finalHead!==head||finalTree!==tree||clean!=='')fail('staged candidate checkout failed exact clean-tree verification');
fs.unlinkSync(bundlePath);
process.stdout.write(JSON.stringify({worktree:candidatePath,head_id:finalHead,tree_id:finalTree,bundle_removed:true})+'\n');
`;

export async function stageSessionCandidateBundle(
  context: SessionContext,
  backend: SessionBackend,
  requestInput: SessionCandidateBundleRequest | unknown,
): Promise<DomainResult<SessionCandidateBundleStageResult>> {
  const parsed = parseRequest(requestInput);
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  if (backend.getSessionVerificationSnapshot === undefined)
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The owned session snapshot authority is unavailable.", {
        operation: "verification.stage-candidate",
      }),
    );
  const observed = await backend.getSessionVerificationSnapshot(context, request.session_id);
  if (!observed.ok) return observed;
  if (!isDeepStrictEqual(observed.value, request.snapshot))
    return failure(
      new DomainError("STALE_REGISTRY", "Candidate staging requires the exact current owner snapshot.", {
        session_id: request.session_id,
      }),
    );
  const source = request.bundles[0]!;
  if (!bundleFileIsCurrent(request.snapshot.worktree, request.candidate_digest, source))
    return failure(
      new DomainError(
        "INVALID_ARGUMENT",
        "The deterministic candidate bundle input is absent, changed, or not owner-private.",
        { field: "bundle_sha256" },
      ),
    );
  const identity = candidateStagingIdentity(request.candidate_digest, source.project_id, source.source_id);
  const candidateHex = identity.candidateHex;
  const sourceKey = identity.sourceKey;
  const stagingRoot = sessionCandidateBundleStagingRootPath(
    request.snapshot.worktree,
    request.candidate_digest,
    source.project_id,
    source.source_id,
  );
  const bundlePath = sessionCandidateBundleTransferPath(
    request.snapshot.worktree,
    request.candidate_digest,
    source.project_id,
    source.source_id,
    source.bundle_sha256,
  );
  const stagedPath = candidatePath(request.snapshot, request, source);
  const execution = await launchManagedSessionCommand(context, backend, {
    session_id: request.session_id,
    expected_session_snapshot: request.snapshot,
    command: {
      command: "/nawabari/bin/node",
      args: [
        "-e",
        stageScript,
        request.snapshot.worktree,
        bundlePath,
        stagingRoot,
        stagedPath,
        candidateHex,
        sourceKey,
        digest.exec(source.bundle_sha256)![1]!,
        source.base_commit,
        source.candidate_commit,
        source.candidate_tree,
      ],
      cwd: request.snapshot.worktree,
    },
    owner_candidate_staging: {
      candidate_digest: request.candidate_digest,
      source_key: sourceKey,
    },
  });
  if (!execution.ok) return execution;
  if (
    execution.value === null ||
    execution.value.result === undefined ||
    execution.value.execution_evidence === undefined ||
    execution.value.owned_execution?.state !== "empty" ||
    execution.value.owned_execution.cgroups?.population.state !== "empty"
  )
    return failure(
      new DomainError(
        "PHYSICAL_OBSERVATION_UNAVAILABLE",
        "Candidate staging did not return completed owner-backed process and cgroup cleanup evidence.",
        { session_id: request.session_id },
      ),
    );
  const result = execution.value.result;
  const physical = execution.value.execution_evidence;
  if (
    result.exit_code !== 0 ||
    result.signal !== null ||
    !isSandboxExecutionEvidenceSnapshot(physical) ||
    physical.physical_execution.termination.state !== "observed-exited" ||
    physical.physical_execution.cleanup.state !== "observed-empty" ||
    physical.raw_output.complete !== true ||
    physical.raw_output.truncated !== false
  )
    return failure(
      new DomainError(
        "SANDBOX_EXECUTION_FAILED",
        "Protected candidate staging failed or its physical output/cleanup is incomplete.",
        {
          session_id: request.session_id,
          exit_code: result.exit_code,
          signal: result.signal,
          execution_evidence: physical as unknown as JsonObject,
        },
      ),
    );
  let stageOutput: unknown;
  try {
    if (!result.stdout.endsWith("\n") || result.stdout.endsWith("\n\n")) throw new Error("non-canonical output");
    stageOutput = JSON.parse(result.stdout);
    if (JSON.stringify(stageOutput) + "\n" !== result.stdout) throw new Error("non-canonical output");
  } catch {
    return failure(
      new DomainError("RUNTIME_PROJECTION_INVALID", "Protected candidate staging returned invalid identity output.", {
        session_id: request.session_id,
      }),
    );
  }
  if (
    typeof stageOutput !== "object" ||
    stageOutput === null ||
    (stageOutput as Record<string, unknown>).worktree !== stagedPath ||
    (stageOutput as Record<string, unknown>).head_id !== source.candidate_commit ||
    (stageOutput as Record<string, unknown>).tree_id !== source.candidate_tree ||
    (stageOutput as Record<string, unknown>).bundle_removed !== true ||
    fs.existsSync(bundlePath)
  )
    return failure(
      new DomainError(
        "RUNTIME_PROJECTION_INVALID",
        "Protected candidate staging did not produce the exact declared source revision.",
        { session_id: request.session_id },
      ),
    );
  const finalSnapshotResult = await backend.getSessionVerificationSnapshot(context, request.session_id);
  if (!finalSnapshotResult.ok) return finalSnapshotResult;
  const finalSnapshot = finalSnapshotResult.value;
  if (!requestFenceMatches(request.snapshot, finalSnapshot))
    return failure(
      new DomainError(
        "STALE_REGISTRY",
        "The session profile, claim, or runtime fence changed during candidate staging.",
        { session_id: request.session_id },
      ),
    );
  const physicalJson = physical as unknown as JsonObject;
  const ownedJson = execution.value.owned_execution as unknown as JsonObject;
  const managedExecution = {
    execution_id: execution.value.execution.execution_id,
    state: execution.value.execution.state,
    supervisor_status: execution.value.supervisor.status,
    physical_execution: physicalJson,
    owned_scope: ownedJson,
  };
  const payload = {
    contract_id: SESSION_CANDIDATE_BUNDLE_CONTRACT_ID,
    schema_version: SESSION_CANDIDATE_BUNDLE_SCHEMA_VERSION,
    producer: { package: "nawabari" as const, version: packageMetadata.version },
    session_id: request.session_id,
    candidate_id: request.candidate_id,
    candidate_digest: request.candidate_digest,
    snapshot: finalSnapshot,
    source: {
      ...source,
      worktree: stagedPath,
      head_id: source.candidate_commit,
      tree_id: source.candidate_tree,
    },
    managed_execution: managedExecution,
  };
  return success({
    ...payload,
    receipt_sha256: sha256(canonicalJson(payload)),
  });
}
