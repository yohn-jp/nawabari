export const LOCK_SCHEMA_VERSION = 1 as const;

export interface LockOwnerRecord {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  token: string;
  pid: number;
  hostname: string;
  processStartTime: string | null;
  acquiredAt: string;
}
