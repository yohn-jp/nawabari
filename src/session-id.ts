import { randomBytes } from "node:crypto";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Generates an RFC 9562 UUIDv7. The millisecond timestamp makes IDs useful
 * for diagnostics, while the random portion makes local concurrent creation
 * safe without a coordinator.
 */
export function generateSessionId(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("UUIDv7 timestamps must be non-negative safe integers");
  }

  const bytes = randomBytes(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
