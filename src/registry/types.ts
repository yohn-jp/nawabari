export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const LOCK_SCHEMA_VERSION = 1 as const;

export const SESSION_LIFECYCLE_STATES = ["new", "active", "closing", "closed", "stale"] as const;

export type SessionLifecycleState = (typeof SESSION_LIFECYCLE_STATES)[number];

export const OWNERSHIP_MUTATIONS = ["create", "claim", "close", "release", "gc"] as const;

export type OwnershipMutation = (typeof OWNERSHIP_MUTATIONS)[number];

export interface SessionRecord {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  sessionId: string;
  repositoryId: string;
  worktreePath: string;
  branch: string;
  state: SessionLifecycleState;
  createdAt: string;
  updatedAt: string;
  label?: string;
}

export interface RegistryDocument {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  repositoryId: string;
  updatedAt: string;
  sessions: SessionRecord[];
}

export interface LockOwnerRecord {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  token: string;
  pid: number;
  hostname: string;
  processStartTime: string | null;
  acquiredAt: string;
}

export type RegistryMutator<T> = (draft: RegistryDocument) => T | Promise<T>;
