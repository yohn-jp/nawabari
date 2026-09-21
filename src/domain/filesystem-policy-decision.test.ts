import assert from "node:assert/strict";
import test from "node:test";

import { claimModeGrantsAccess, resourceMatchesClaim, type ResourceClaim } from "../resource-claims.js";
import {
  FILESYSTEM_POLICY_CONTRACT_ID,
  decideEffectivePathAccess,
  profileRuntimeBoundaryToken,
  validateProfileRuntimeBoundary,
} from "./filesystem-policy-decision.js";
import type { WorktreeRuntimeFilesystemCeiling } from "./worktree-runtime-profile.js";
import {
  validateWorkingSetRuntimeProjection,
  type WorkingSetRuntimeProjection,
} from "./working-set-runtime-projection.js";

const ceiling: WorktreeRuntimeFilesystemCeiling = {
  readOnly: ["README.md", "src/index.ts"],
  write: ["src/index.ts"],
  create: [],
  delete: [],
  deny: ["src/secret.ts"],
  immutable: ["src/immutable.ts"],
};

function workingSet(): WorkingSetRuntimeProjection {
  const result = validateWorkingSetRuntimeProjection({
    contract_id: "nawabari.working-set-runtime-projection.v1",
    schema_version: 1,
    working_set_id: "ews-1",
    revision: 7,
    repository: { repositoryHost: "github.com", repositoryId: "repo", repository: "yohn-jp/nawabari" },
    base: { branch: "epic/401-worktree-runtime-profiles", revision: "a".repeat(40) },
    scope: { readOnly: ["README.md", "src/**"], write: ["src/index.ts"], create: [], delete: [], deny: [] },
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("invalid working-set fixture");
  return result.value;
}

function claim(resource: string, mode: ResourceClaim["mode"]): ResourceClaim {
  return {
    schemaVersion: 2,
    claimId: "claim-1",
    sessionId: "session-1",
    repositoryId: "repo",
    worktreePath: "/tmp/worktree",
    resource,
    mode,
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
}

test("the decision is one fail-closed conjunction across profile, EWS, and claims", () => {
  const result = decideEffectivePathAccess({
    path: "src/index.ts",
    operation: "WRITE",
    profile: ceiling,
    workingSet: workingSet(),
    claims: [claim("src/index.ts", "write")],
    claimsRequired: true,
    repositoryId: "repo",
  });
  assert.equal(result.contract_id, FILESYSTEM_POLICY_CONTRACT_ID);
  assert.equal(result.status, "allowed");
  assert.deepEqual(result.authorities, { profile: "allow", working_set: "allow", claim: "allow" });
});

test("DENY and immutable areas override broader profile grants", () => {
  const denied = decideEffectivePathAccess({
    path: "src/secret.ts",
    operation: "READONLY",
    profile: { ...ceiling, readOnly: ["src/**"] },
  });
  assert.equal(denied.status, "denied");
  assert.match(denied.reason, /DENY/u);

  const immutable = decideEffectivePathAccess({
    path: "src/immutable.ts",
    operation: "WRITE",
    profile: { ...ceiling, write: ["src/**"] },
  });
  assert.equal(immutable.status, "denied");
  assert.match(immutable.reason, /immutable/u);
});

test("CREATE, DELETE, non-concrete paths, and missing required claims are unsupported or denied", () => {
  const create = decideEffectivePathAccess({ path: "src/new.ts", operation: "CREATE", profile: ceiling });
  assert.equal(create.status, "unsupported");

  const broad = decideEffectivePathAccess({ path: "src/**", operation: "READONLY", profile: ceiling });
  assert.equal(broad.status, "unsupported");

  const noClaim = decideEffectivePathAccess({
    path: "src/index.ts",
    operation: "WRITE",
    profile: ceiling,
    claims: [],
    claimsRequired: true,
    repositoryId: "repo",
  });
  assert.equal(noClaim.status, "denied");
});

test("missing claim evidence is unsupported when claims are required", () => {
  const result = decideEffectivePathAccess({
    path: "src/index.ts",
    operation: "WRITE",
    profile: ceiling,
    claimsRequired: true,
    repositoryId: "repo",
  });
  assert.equal(result.status, "unsupported");
  assert.match(result.reason, /required ResourceClaim evidence/u);
  assert.equal(result.authorities.claim, "not_provided");
});

test("claim matching and access strength remain delegated to the existing claim authority", () => {
  const current = claim("src/*.ts", "write");
  assert.equal(resourceMatchesClaim(current, "src/index.ts"), true);
  assert.equal(claimModeGrantsAccess("write", "read"), true);
  assert.equal(claimModeGrantsAccess("read", "write"), false);
});

test("profile boundary token is deterministic and detects tampering", () => {
  const input = {
    contract_id: "nawabari.profile-runtime-boundary.v1" as const,
    schema_version: 1 as const,
    profile_id: "profile",
    profile_version: "1",
    scope: { readOnly: ["README.md"], write: ["src/index.ts"], deny: [], immutable: [] },
  };
  const valid = validateProfileRuntimeBoundary({ ...input, token: profileRuntimeBoundaryToken(input) });
  assert.equal(valid.ok, true);
  const invalid = validateProfileRuntimeBoundary({ ...input, token: "0".repeat(64) });
  assert.equal(invalid.ok, false);
});
