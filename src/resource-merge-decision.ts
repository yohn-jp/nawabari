/**
 * The small, read-only decision surface used by the resource-coordination
 * merge preview.  This module deliberately does not know about sessions,
 * registries, or worktrees: callers provide the three observed path states
 * and this function classifies only facts that can be proved from them.
 */

export const MERGE_PREVIEW_OPERATION = "merge-preview" as const;
export const MERGE_PREVIEW_SCHEMA_VERSION = 1 as const;

export const THREE_WAY_DECISION_KINDS = [
  "unchanged",
  "left-only",
  "right-only",
  "both-same",
  "delete-delete",
  "delete-modify",
  "add-add",
  "mode-conflict",
  "text-merge",
  "unknown",
] as const;
export type ThreeWayDecisionKind = (typeof THREE_WAY_DECISION_KINDS)[number];

export type MergePathKind = "regular" | "binary" | "submodule" | "directory" | "unknown";

export const THREE_WAY_UNKNOWN_REASONS = [
  "observation-unavailable",
  "binary",
  "submodule",
  "directory",
  "merge-driver",
  "multiple-merge-bases",
  "path-kind-ambiguous",
  "identity-unavailable",
] as const;
export type ThreeWayUnknownReason = (typeof THREE_WAY_UNKNOWN_REASONS)[number];

export type MergeBytes = Uint8Array | string;

/**
 * A path state may be populated from Git's `ls-tree` evidence or from a
 * byte-level observation.  `sha`/`oid` is intentionally accepted as an
 * identity fallback when bytes are not available; a state with neither is
 * unknown rather than being guessed equal to another state.
 */
export interface MergePathState {
  readonly exists?: boolean;
  readonly present?: boolean;
  readonly mode?: string | null;
  readonly type?: string | null;
  readonly kind?: MergePathKind | "file" | "blob" | "commit" | "tree";
  readonly sha?: string | null;
  readonly oid?: string | null;
  readonly content?: MergeBytes | null;
  readonly bytes?: MergeBytes | null;
  readonly binary?: boolean;
  readonly mergeDriver?: string | null;
  readonly driver?: string | null;
  readonly mergeBases?: number;
}

export type MergePathInput = MergePathState | MergeBytes | null | undefined;

export interface ThreeWayDecision {
  readonly operation: typeof MERGE_PREVIEW_OPERATION;
  readonly schemaVersion: typeof MERGE_PREVIEW_SCHEMA_VERSION;
  readonly kind: ThreeWayDecisionKind;
  /** Explicit result class for consumers that must fail closed. */
  readonly outcome: "clean" | "conflict" | "unknown";
  /** True only when a regular-file text merge is required. */
  readonly requiresTextMerge: boolean;
  readonly reason?: ThreeWayUnknownReason;
}

interface NormalizedPathState {
  readonly exists: boolean;
  readonly mode: string | null;
  readonly kind: MergePathKind;
  readonly identity: string | null;
  readonly content: Uint8Array | null;
  readonly known: boolean;
  readonly reason?: ThreeWayUnknownReason;
  readonly mergeDriver: string | null;
  readonly mergeBases: number | null;
}

const ABSENT: NormalizedPathState = Object.freeze({
  exists: false,
  mode: null,
  kind: "regular",
  identity: null,
  content: null,
  known: true,
  mergeDriver: null,
  mergeBases: null,
});

/**
 * Classify a path before invoking a content merger.  In particular, delete /
 * modify and mode differences never get collapsed into a textual clean
 * result.  Any fact that is not observable from the supplied states is
 * represented as `unknown` so a caller cannot accidentally authorize a
 * merge from incomplete evidence.
 */
export function classifyThreeWayPath(
  base: MergePathInput,
  left: MergePathInput,
  right: MergePathInput,
): ThreeWayDecision {
  const normalizedBase = normalizePathState(base);
  const normalizedLeft = normalizePathState(left);
  const normalizedRight = normalizePathState(right);

  const unknownReason = firstUnknownReason(normalizedBase, normalizedLeft, normalizedRight);
  if (unknownReason !== undefined) return decision("unknown", "unknown", false, unknownReason);

  const unsupportedReason = firstUnsupportedReason(normalizedBase, normalizedLeft, normalizedRight);
  if (unsupportedReason !== undefined) return decision("unknown", "unknown", false, unsupportedReason);

  const baseExists = normalizedBase.exists;
  const leftExists = normalizedLeft.exists;
  const rightExists = normalizedRight.exists;

  if (!baseExists) {
    if (!leftExists && !rightExists) return decision("unchanged", "clean", false);
    if (!leftExists) return decision("right-only", "clean", false);
    if (!rightExists) return decision("left-only", "clean", false);
    if (statesEqual(normalizedLeft, normalizedRight)) return decision("both-same", "clean", false);
    return decision("add-add", "conflict", false);
  }

  if (!leftExists && !rightExists) return decision("delete-delete", "clean", false);
  if (!leftExists || !rightExists) {
    const surviving = leftExists ? normalizedLeft : normalizedRight;
    const changed = !statesEqual(surviving, normalizedBase);
    return decision(
      changed ? "delete-modify" : leftExists ? "right-only" : "left-only",
      changed ? "conflict" : "clean",
      false,
    );
  }

  const leftChanged = !statesEqual(normalizedBase, normalizedLeft);
  const rightChanged = !statesEqual(normalizedBase, normalizedRight);
  if (!leftChanged && !rightChanged) return decision("unchanged", "clean", false);
  if (leftChanged && !rightChanged) return decision("left-only", "clean", false);
  if (!leftChanged && rightChanged) return decision("right-only", "clean", false);
  if (statesEqual(normalizedLeft, normalizedRight)) return decision("both-same", "clean", false);

  if (normalizedLeft.mode !== normalizedRight.mode) return decision("mode-conflict", "conflict", false);
  return decision("text-merge", "unknown", true);
}

function decision(
  kind: ThreeWayDecisionKind,
  outcome: ThreeWayDecision["outcome"],
  requiresTextMerge: boolean,
  reason?: ThreeWayUnknownReason,
): ThreeWayDecision {
  return Object.freeze({
    operation: MERGE_PREVIEW_OPERATION,
    schemaVersion: MERGE_PREVIEW_SCHEMA_VERSION,
    kind,
    outcome,
    requiresTextMerge,
    ...(reason === undefined ? {} : { reason }),
  });
}

function normalizePathState(value: MergePathInput): NormalizedPathState {
  if (value === null || value === undefined) return ABSENT;
  if (typeof value === "string" || value instanceof Uint8Array) {
    const content = toBytes(value);
    return Object.freeze({
      exists: true,
      mode: null,
      kind: "regular",
      identity: null,
      content,
      known: true,
      mergeDriver: null,
      mergeBases: null,
    });
  }
  if (!isRecord(value)) return unknownState("observation-unavailable");

  const presence = value.exists ?? value.present;
  if (presence === false) return ABSENT;
  if (presence !== undefined && typeof presence !== "boolean") return unknownState("observation-unavailable");

  const kind = pathKind(value);
  const type = typeof value.type === "string" ? value.type : null;
  const mode =
    value.mode === null || value.mode === undefined ? null : typeof value.mode === "string" ? value.mode : null;
  const rawContent = value.content ?? value.bytes;
  const content =
    rawContent === null || rawContent === undefined ? null : isBytes(rawContent) ? toBytes(rawContent) : null;
  const identity = typeof value.sha === "string" ? value.sha : typeof value.oid === "string" ? value.oid : null;
  const mergeDriver = value.mergeDriver ?? value.driver;
  const mergeBasesValue = value.mergeBases;
  const mergeBases =
    mergeBasesValue === undefined ? null : typeof mergeBasesValue === "number" ? mergeBasesValue : Number.NaN;

  if (presence === undefined && kind === "unknown" && type === null && identity === null && content === null) {
    return unknownState("observation-unavailable");
  }
  if (mergeDriver !== undefined && mergeDriver !== null && typeof mergeDriver !== "string") {
    return unknownState("merge-driver");
  }
  if (mergeBases !== null && (!Number.isSafeInteger(mergeBases) || mergeBases < 1)) {
    return unknownState("multiple-merge-bases");
  }
  if (mergeBases !== null && mergeBases !== 1) return unknownState("multiple-merge-bases");
  if (rawContent !== null && rawContent !== undefined && content === null)
    return unknownState("observation-unavailable");
  if (content !== null && content.includes(0)) return unsupportedState("binary", mode, identity, content, mergeBases);
  if (kind === "regular" && content === null && identity === null) return unknownState("identity-unavailable");
  if (type !== null && type !== "blob" && type !== "file" && type !== "regular") {
    // Git represents a submodule as a `commit` tree entry and a directory as
    // `tree`; both are unsupported by a regular-file content merge.
    return Object.freeze({
      exists: true,
      mode,
      kind,
      identity,
      content,
      known: true,
      reason: kindReason(kind) ?? "path-kind-ambiguous",
      mergeDriver: typeof mergeDriver === "string" ? mergeDriver : null,
      mergeBases,
    });
  }
  return Object.freeze({
    exists: true,
    mode,
    kind,
    identity,
    content,
    known: true,
    ...(kind === "unknown" ? { reason: "path-kind-ambiguous" as const } : {}),
    mergeDriver: typeof mergeDriver === "string" ? mergeDriver : null,
    mergeBases,
  });
}

function unsupportedState(
  reason: ThreeWayUnknownReason,
  mode: string | null,
  identity: string | null,
  content: Uint8Array | null,
  mergeBases: number | null,
): NormalizedPathState {
  return Object.freeze({
    exists: true,
    mode,
    kind: reason === "binary" ? "binary" : "unknown",
    identity,
    content,
    known: true,
    reason,
    mergeDriver: null,
    mergeBases,
  });
}

function unknownState(reason: ThreeWayUnknownReason): NormalizedPathState {
  return Object.freeze({
    exists: true,
    mode: null,
    kind: "unknown",
    identity: null,
    content: null,
    known: false,
    reason,
    mergeDriver: null,
    mergeBases: null,
  });
}

function pathKind(value: Record<string, unknown>): MergePathKind {
  if (value.binary === true) return "binary";
  const rawKind = value.kind;
  if (rawKind === "binary") return "binary";
  if (rawKind === "submodule" || rawKind === "commit") return "submodule";
  if (rawKind === "directory" || rawKind === "tree") return "directory";
  if (rawKind === "regular" || rawKind === "file" || rawKind === "blob") return "regular";
  if (value.type === "commit") return "submodule";
  if (value.type === "tree") return "directory";
  if (value.type === "blob" || value.type === "file" || value.type === "regular") return "regular";
  if (value.binary === false || value.content !== undefined || value.bytes !== undefined) return "regular";
  return "unknown";
}

function kindReason(kind: MergePathKind): ThreeWayUnknownReason | undefined {
  if (kind === "binary") return "binary";
  if (kind === "submodule") return "submodule";
  if (kind === "directory") return "directory";
  if (kind === "unknown") return "path-kind-ambiguous";
  return undefined;
}

function firstUnknownReason(...states: readonly NormalizedPathState[]): ThreeWayUnknownReason | undefined {
  for (const state of states) {
    if (state.known === false) return state.reason ?? "observation-unavailable";
  }
  return undefined;
}

function firstUnsupportedReason(...states: readonly NormalizedPathState[]): ThreeWayUnknownReason | undefined {
  for (const state of states) {
    if (state.mergeDriver !== null) return "merge-driver";
    if (state.mergeBases !== null && state.mergeBases !== 1) return "multiple-merge-bases";
    if (state.reason !== undefined) return state.reason;
    const kindReasonValue = kindReason(state.kind);
    if (kindReasonValue !== undefined) return kindReasonValue;
  }
  return undefined;
}

function statesEqual(left: NormalizedPathState, right: NormalizedPathState): boolean {
  if (!left.exists || !right.exists) return left.exists === right.exists;
  if (left.kind !== right.kind || left.mode !== right.mode) return false;
  if (left.content !== null || right.content !== null) {
    return left.content !== null && right.content !== null && bytesEqual(left.content, right.content);
  }
  return left.identity !== null && right.identity !== null && left.identity === right.identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBytes(value: unknown): value is MergeBytes {
  return typeof value === "string" || value instanceof Uint8Array;
}

function toBytes(value: MergeBytes): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
