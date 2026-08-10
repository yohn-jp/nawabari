import { DomainError, type DomainResult, failure, type ErrorCode, type JsonObject } from "./errors.js";

export type SessionState = "new" | "active" | "closing" | "closed" | "stale";

export type SessionRecord = {
  schema_version: number;
  session_id: string;
  repository: string;
  worktree: string;
  branch: string;
  state: SessionState;
  created_at: string;
  updated_at: string;
  label?: string;
};

export type SessionContext = {
  cwd: string;
};

export type SessionCreateOptions = {
  branch: string | null;
  worktree: string | null;
  label: string | null;
  base?: string | null;
};

export type SessionCloseOptions = {
  session_id: string | null;
};

export type GuardOptions = {
  session_id: string | null;
};

export type GuardDecision = {
  allowed: boolean;
  code: ErrorCode | "ALLOWED";
  repository: string;
  worktree: string;
  branch: string | null;
  session_id: string | null;
  owner_session_id: string | null;
  requested_session_id: string | null;
  state: SessionState | null;
  details: JsonObject;
};

export type GarbageCollectOptions = {
  apply: boolean;
};

export type BackendCapabilities = {
  session_registry: boolean;
  provisioning: boolean;
  lifecycle: boolean;
  garbage_collection: boolean;
  current_session_resolution: boolean;
};

export type SessionListResult = {
  sessions: SessionRecord[];
};

export type StatusResult = {
  repository: string | null;
  current_session: SessionRecord | null;
  sessions: SessionRecord[];
  capabilities: BackendCapabilities;
};

export type SessionCloseResult = {
  session: SessionRecord;
  worktree_removed: boolean;
  branch_removed: boolean;
  idempotent?: boolean;
};

export type GarbageCollectBlocked = {
  session_id: string;
  code: ErrorCode;
  message: string;
  details: JsonObject;
};

export type GarbageCollectResult = {
  apply: boolean;
  candidates: SessionRecord[];
  cleaned: SessionRecord[];
  blocked?: GarbageCollectBlocked[];
};

export interface SessionBackend {
  createSession(context: SessionContext, options: SessionCreateOptions): Promise<DomainResult<SessionRecord>>;
  resolveCurrentSession(context: SessionContext): Promise<DomainResult<SessionRecord>>;
  getSession(context: SessionContext, sessionId: string): Promise<DomainResult<SessionRecord>>;
  guard(context: SessionContext, options: GuardOptions): Promise<DomainResult<GuardDecision>>;
  listSessions(context: SessionContext): Promise<DomainResult<SessionListResult>>;
  status(context: SessionContext): Promise<DomainResult<StatusResult>>;
  closeSession(context: SessionContext, options: SessionCloseOptions): Promise<DomainResult<SessionCloseResult>>;
  garbageCollect(context: SessionContext, options: GarbageCollectOptions): Promise<DomainResult<GarbageCollectResult>>;
}

const UNAVAILABLE_CAPABILITIES: BackendCapabilities = {
  session_registry: false,
  provisioning: false,
  lifecycle: false,
  garbage_collection: false,
  current_session_resolution: false,
};

export function unavailableCapabilities(): BackendCapabilities {
  return { ...UNAVAILABLE_CAPABILITIES };
}

class UnavailableSessionBackend implements SessionBackend {
  private unavailable<T>(operation: string): Promise<DomainResult<T>> {
    return Promise.resolve(
      failure(
        new DomainError("BACKEND_UNAVAILABLE", "The requested GitPaw session capability is not available.", {
          operation,
          capabilities: unavailableCapabilities(),
        }),
      ),
    );
  }

  createSession(_context: SessionContext, _options: SessionCreateOptions): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.create");
  }

  resolveCurrentSession(_context: SessionContext): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.resolve_current");
  }

  guard(_context: SessionContext, _options: GuardOptions): Promise<DomainResult<GuardDecision>> {
    return this.unavailable("guard");
  }

  getSession(_context: SessionContext, _sessionId: string): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.show");
  }

  listSessions(_context: SessionContext): Promise<DomainResult<SessionListResult>> {
    return this.unavailable("session.list");
  }

  status(_context: SessionContext): Promise<DomainResult<StatusResult>> {
    return this.unavailable("status");
  }

  closeSession(_context: SessionContext, _options: SessionCloseOptions): Promise<DomainResult<SessionCloseResult>> {
    return this.unavailable("session.close");
  }

  garbageCollect(
    _context: SessionContext,
    _options: GarbageCollectOptions,
  ): Promise<DomainResult<GarbageCollectResult>> {
    return this.unavailable("gc");
  }
}

export function createUnavailableSessionBackend(): SessionBackend {
  return new UnavailableSessionBackend();
}
