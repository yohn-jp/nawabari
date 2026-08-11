import type { JsonObject, JsonValue } from "./domain/errors.js";

/** Maximum number of members emitted for a failure-detail collection. */
export const FAILURE_DETAIL_ARRAY_LIMIT = 32 as const;
/** Maximum length of one emitted failure message. */
export const FAILURE_MESSAGE_LENGTH_LIMIT = 4_096 as const;

/**
 * Bound only presentation data. Domain and registry errors retain their full
 * in-process details for recovery and diagnostics; the JSON boundary adds
 * deterministic continuation metadata when it has to shorten a collection.
 */
export function boundOutputDetails(details: JsonObject): JsonObject {
  return boundObject(details);
}

export function boundOutputMessage(message: string): {
  value: string;
  truncated: boolean;
  total: number;
} {
  const total = message.length;
  return {
    value: total > FAILURE_MESSAGE_LENGTH_LIMIT ? `${message.slice(0, FAILURE_MESSAGE_LENGTH_LIMIT)}…` : message,
    truncated: total > FAILURE_MESSAGE_LENGTH_LIMIT,
    total,
  };
}

function boundObject(value: JsonObject): JsonObject {
  const bounded: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child)) {
      const truncated = child.length > FAILURE_DETAIL_ARRAY_LIMIT;
      bounded[key] = child.slice(0, FAILURE_DETAIL_ARRAY_LIMIT).map(boundValue);
      if (truncated) {
        bounded[`${key}_total`] = child.length;
        bounded[`${key}_limit`] = FAILURE_DETAIL_ARRAY_LIMIT;
        bounded[`${key}_truncated`] = true;
        bounded[`${key}_next_offset`] = FAILURE_DETAIL_ARRAY_LIMIT;
      }
      continue;
    }
    bounded[key] = boundValue(child);
  }
  return bounded;
}

function boundValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.slice(0, FAILURE_DETAIL_ARRAY_LIMIT).map(boundValue);
  }
  if (value !== null && typeof value === "object") return boundObject(value);
  return value;
}
