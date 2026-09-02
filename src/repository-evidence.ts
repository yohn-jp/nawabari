import { createHash } from "node:crypto";

import {
  DIFF_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_MAX_DIFF_BYTES,
  EVIDENCE_MAX_DIFF_HUNKS,
  EVIDENCE_MAX_DIFF_PATHS,
  REPOSITORY_EVIDENCE_SCHEMA_VERSION,
  type GitPathStat,
} from "./git.js";
import type { GitCheckpointPaths } from "./operation-authorization.js";

export {
  DIFF_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_MAX_DIFF_BYTES,
  EVIDENCE_MAX_DIFF_HUNKS,
  EVIDENCE_MAX_DIFF_PATHS,
  REPOSITORY_EVIDENCE_SCHEMA_VERSION,
};
export type { GitPathStat } from "./git.js";

export interface RepositoryEvidenceOptions {
  readonly sessionId: string;
}

export interface RepositoryDiffOptions {
  readonly sessionId: string;
  readonly paths: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly includePatch?: boolean;
  readonly maxBytes?: number;
  readonly maxHunks?: number;
}

export interface RepositoryEvidencePaths extends GitCheckpointPaths {
  readonly stats: readonly GitPathStat[];
}

export interface RepositoryEvidenceBounds {
  readonly maxPaths: number;
  readonly maxDiffPaths: number;
  readonly maxDiffBytes: number;
  readonly maxDiffHunks: number;
}

export interface RepositoryEvidenceSnapshot {
  readonly schemaVersion: typeof REPOSITORY_EVIDENCE_SCHEMA_VERSION;
  readonly source: "git";
  readonly guarantee: "git-observable-only";
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly sessionId: string;
  readonly sessionState: string;
  readonly sessionCreatedAt: string;
  /**
   * UTC timestamp of the last authoritative session-state mutation. Managed
   * commits advance this value; arbitrary external Git changes do not.
   */
  readonly sessionUpdatedAt: string;
  readonly baseRevision: string | null;
  readonly baseRevisionProven: boolean;
  readonly headId: string;
  readonly clean: boolean;
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly paths: RepositoryEvidencePaths;
  /** SHA-256 over all non-volatile evidence fields in this snapshot. */
  readonly evidenceHash: string;
  readonly bounds: RepositoryEvidenceBounds;
}

export interface RepositoryDiffEvidence {
  readonly schemaVersion: typeof DIFF_EVIDENCE_SCHEMA_VERSION;
  readonly source: "git";
  readonly guarantee: "git-observable-only";
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly sessionId: string;
  readonly sessionState: string;
  readonly headId: string;
  readonly fromRevision: string;
  readonly toRevision: string | null;
  readonly paths: readonly string[];
  readonly stats: readonly GitPathStat[];
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly patch: string | null;
  readonly patchBytes: number;
  readonly hunkCount: number;
  readonly maxBytes: number;
  readonly maxHunks: number;
  /** SHA-256 over all non-volatile evidence fields in this diff. */
  readonly evidenceHash: string;
}

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
