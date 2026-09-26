import type { ParsedRuntimeRecords, RuntimeRecord } from "./registry/runtime-records.js";
import { MAX_RUNTIME_RECORDS, REGISTRY_FEATURES } from "./registry/runtime-records.js";

/** Presentation evidence only. Neither these records nor their absence grants authority. */
export interface SessionRuntimeHistoryEvent {
  readonly kind: "lifecycle" | "execution";
  readonly schema_version: 1;
  readonly event_id: string;
  readonly sequence: number;
  readonly session_id: string;
  readonly execution_id: string | null;
  readonly source: "session-registry";
  readonly operation: string;
  readonly before_revision: number;
  readonly after_revision: number;
  readonly observed_at: string;
}

export interface SessionRuntimeHistory {
  readonly events: readonly SessionRuntimeHistoryEvent[];
  readonly bound: number;
  readonly retained_from: number | null;
  readonly retained_through: number | null;
  readonly truncated: boolean;
  readonly coverage: "from-session-creation" | "prior-history-unknown";
}

/** Only history entries are evicted; other registry records are never touched. */
export function appendRuntimeEvent(
  state: ParsedRuntimeRecords,
  events: readonly Omit<SessionRuntimeHistoryEvent, "event_id" | "sequence" | "schema_version">[],
  bound: number = MAX_RUNTIME_RECORDS,
): ParsedRuntimeRecords {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > MAX_RUNTIME_RECORDS)
    throw new RangeError("Invalid history bound");
  if (events.length === 0) return state;
  const recent = state.records.recent_events ?? [];
  const handoffs = recent.filter((record) => record.kind === "resource-handoff");
  if (handoffs.length >= MAX_RUNTIME_RECORDS) throw new RangeError("No registry capacity for history evidence");
  const existing = recent.filter(
    (record) => record.kind !== "resource-handoff",
  ) as unknown as SessionRuntimeHistoryEvent[];
  let sequence = existing.at(-1)?.sequence ?? 0;
  const appended = events.map((event) => {
    if (!Number.isSafeInteger(++sequence)) throw new RangeError("History sequence exhausted");
    return Object.freeze({ ...event, schema_version: 1 as const, sequence, event_id: `history:${sequence}` });
  });
  return Object.freeze({
    requiredFeatures: Object.freeze(
      REGISTRY_FEATURES.filter(
        (feature) =>
          feature === "recent-events.v1" ||
          feature === "session-history.v1" ||
          state.requiredFeatures.includes(feature),
      ),
    ),
    records: Object.freeze({
      ...state.records,
      recent_events: Object.freeze([
        ...handoffs,
        ...[...existing, ...appended].slice(-Math.min(bound, MAX_RUNTIME_RECORDS - handoffs.length)),
      ]) as unknown as readonly RuntimeRecord[],
    }),
  });
}

export function projectSessionRuntimeHistory(records: ParsedRuntimeRecords, sessionId: string): SessionRuntimeHistory {
  const retained = (records.records.recent_events ?? []).filter(
    (record) => record.kind !== "resource-handoff",
  ) as unknown as SessionRuntimeHistoryEvent[];
  const first = retained[0]?.sequence ?? null;
  const last = retained.at(-1)?.sequence ?? null;
  const sessionEvents = retained.filter((event) => event.session_id === sessionId);
  const firstSessionEvent = sessionEvents[0];
  const coversSessionCreation =
    firstSessionEvent?.kind === "lifecycle" && firstSessionEvent.operation.startsWith("absent->");
  return Object.freeze({
    events: Object.freeze(sessionEvents.map((event) => Object.freeze({ ...event }))),
    bound: MAX_RUNTIME_RECORDS,
    retained_from: first,
    retained_through: last,
    truncated: first !== null && first > 1,
    coverage: coversSessionCreation ? "from-session-creation" : "prior-history-unknown",
  });
}
