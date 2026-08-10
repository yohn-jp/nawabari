export const LOCK_SCHEMA_VERSION = 1 as const;

export const OWNERSHIP_MUTATIONS = ["create", "claim", "close", "release", "gc"] as const;

export type OwnershipMutation = (typeof OWNERSHIP_MUTATIONS)[number];

export interface LockOwnerRecord {
  schemaVersion: typeof LOCK_SCHEMA_VERSION;
  token: string;
  pid: number;
  hostname: string;
  processStartTime: string | null;
  acquiredAt: string;
}

export interface RegistryCodec<State> {
  empty(): State;
  parse(value: unknown): State;
  validate(state: State): void;
  serialize?(state: State): unknown;
}

export type RegistryMutator<State, Result> = (draft: State) => Result | Promise<Result>;
