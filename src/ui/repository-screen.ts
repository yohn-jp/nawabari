/**
 * Read-only projection of one Repository Runtime Snapshot.
 *
 * This module deliberately treats the producer snapshot as opaque data.  It
 * does not classify claims, calculate conflicts, or infer lifecycle state.
 * Those meanings belong to the snapshot producers; this file only lays out
 * fields that are already present in the supplied projection.
 */

export type ScreenRecord = Readonly<Record<string, unknown>>;

/** The five views are projections of the same snapshot, not five data reads. */
export type RepositoryScreenView = "sessions" | "files" | "attention" | "runtime" | "conflicts";

/**
 * Presentation input.  The fields are intentionally optional because the
 * integration surface supplies the accepted producer snapshot and may omit a
 * view when its evidence is unavailable.  No field is synthesized here.
 */
export type RepositoryScreenModel = ScreenRecord & {
  readonly snapshot_token?: unknown;
  readonly token?: unknown;
  readonly sessions?: unknown;
  readonly files?: unknown;
  readonly matrix?: unknown;
  readonly attention?: unknown;
  readonly runtime?: unknown;
  readonly profile?: unknown;
  readonly conflicts?: unknown;
  readonly lifecycle?: unknown;
  readonly truncated?: unknown;
  readonly next_cursor?: unknown;
};

export type RepositoryScreenViewport = {
  readonly width?: number;
  readonly height?: number;
};

export type RepositoryScreenSelection = {
  readonly view: RepositoryScreenView;
  readonly selected_id: string | null;
  readonly snapshot_token: string | null;
};

const VIEWS: readonly RepositoryScreenView[] = ["sessions", "files", "attention", "runtime", "conflicts"];
const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 32;
const MIN_WIDTH = 1;
const MIN_HEIGHT = 1;
const MAX_ROWS_PER_SECTION = 256;
const MAX_JSON_BYTES = 64 * 1024;
const ELLIPSIS = "…";

function asRecord(value: unknown): ScreenRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ScreenRecord;
}

function asRecords(value: unknown): readonly ScreenRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is ScreenRecord => item !== null);
}

function recordValue(record: ScreenRecord, names: readonly string[]): unknown {
  for (const name of names) {
    if (name in record && record[name] !== null && record[name] !== undefined) return record[name];
  }
  return undefined;
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return null;
}

function valueText(record: ScreenRecord, names: readonly string[], absent = "unknown"): string {
  return scalar(recordValue(record, names)) ?? absent;
}

/**
 * Make untrusted repository text visible without emitting terminal controls.
 * ESC/OSC and all C0/C1/Cf controls are represented as printable escapes.
 */
export function escapeTerminalText(value: string): string {
  let output = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0x09) {
      output += "\\t";
    } else if (codePoint === 0x0a) {
      output += "\\n";
    } else if (codePoint === 0x0d) {
      output += "\\r";
    } else if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      output += `\\u{${codePoint.toString(16)}}`;
    } else if (codePoint >= 0x200b && codePoint <= 0x200f) {
      output += `\\u{${codePoint.toString(16)}}`;
    } else if (codePoint >= 0x202a && codePoint <= 0x202e) {
      output += `\\u{${codePoint.toString(16)}}`;
    } else if (codePoint >= 0x2060 && codePoint <= 0x2064) {
      output += `\\u{${codePoint.toString(16)}}`;
    } else if (codePoint === 0xfeff || (codePoint >= 0xfff9 && codePoint <= 0xfffb)) {
      output += `\\u{${codePoint.toString(16)}}`;
    } else {
      output += character;
    }
  }
  return output;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x300 && codePoint <= 0x36f) ||
      (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
      (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
      (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
      (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    ) {
      continue;
    }
    width +=
      codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff))
        ? 2
        : 1;
  }
  return width;
}

function fitLine(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= displayWidth(ELLIPSIS)) return ELLIPSIS.slice(0, Math.max(1, width));
  let result = "";
  for (const character of value) {
    if (displayWidth(result + character) + displayWidth(ELLIPSIS) > width) break;
    result += character;
  }
  return result + ELLIPSIS;
}

function stableId(record: ScreenRecord, fallback: string): string {
  const value = recordValue(record, [
    "session_id",
    "claim_id",
    "resource_id",
    "attention_id",
    "conflict_id",
    "path",
    "resource",
    "id",
  ]);
  return scalar(value) ?? fallback;
}

function sectionRows(value: unknown): readonly ScreenRecord[] {
  if (Array.isArray(value)) return asRecords(value);
  const record = asRecord(value);
  return record === null ? [] : [record];
}

function rowText(record: ScreenRecord, view: RepositoryScreenView, index: number): string {
  const id = escapeTerminalText(stableId(record, `${view}-${index + 1}`));
  if (view === "sessions") {
    return `  ${id} branch=${escapeTerminalText(valueText(record, ["branch", "branch_name"]))} state=${escapeTerminalText(valueText(record, ["state", "lifecycle"]))}`;
  }
  if (view === "files") {
    const path = escapeTerminalText(valueText(record, ["path", "resource", "selector", "name"]));
    const sessions = recordValue(record, ["sessions", "session_ids"]);
    const sessionText = Array.isArray(sessions)
      ? sessions.map((item) => escapeTerminalText(scalar(item) ?? "unknown")).join(",") || "none"
      : scalar(sessions) !== null
        ? escapeTerminalText(scalar(sessions) as string)
        : "unknown";
    return `  ${path} sessions=${sessionText} claim=${escapeTerminalText(valueText(record, ["claim", "claim_mode", "mode"]))} change=${escapeTerminalText(valueText(record, ["changed", "observed_change", "change"]))} conflict=${escapeTerminalText(valueText(record, ["conflict", "conflict_state", "mergeability"]))}`;
  }
  if (view === "attention") {
    return `  [${escapeTerminalText(valueText(record, ["severity", "priority"]))}] ${id} ${escapeTerminalText(valueText(record, ["reason", "message", "detail"]))}`;
  }
  if (view === "runtime") {
    return `  ${id} status=${escapeTerminalText(valueText(record, ["status", "health", "state", "lifecycle"]))} profile=${escapeTerminalText(valueText(record, ["profile", "runtime_profile"]))} process=${escapeTerminalText(valueText(record, ["process", "process_state"]))}`;
  }
  return `  ${id} path=${escapeTerminalText(valueText(record, ["path", "resource"]))} state=${escapeTerminalText(valueText(record, ["state", "classification", "status"]))} message=${escapeTerminalText(valueText(record, ["message", "reason", "detail"]))}`;
}

function tokenOf(model: RepositoryScreenModel): string | null {
  return scalar(recordValue(model, ["snapshot_token", "token"]));
}

function rowsForView(model: RepositoryScreenModel, view: RepositoryScreenView): readonly ScreenRecord[] {
  if (view === "sessions") return sectionRows(model.sessions);
  if (view === "files") return sectionRows(model.matrix ?? model.files);
  if (view === "attention") return sectionRows(model.attention);
  if (view === "runtime") {
    const runtime = sectionRows(model.runtime);
    if (runtime.length > 0) return runtime;
    const profile = sectionRows(model.profile);
    if (profile.length > 0) return profile;
    return sectionRows(model.lifecycle);
  }
  return sectionRows(model.conflicts);
}

/** Reconcile an old selected stable ID against a newly read snapshot. */
export function reconcileScreenSelection(
  previous: RepositoryScreenSelection,
  model: RepositoryScreenModel,
): RepositoryScreenSelection {
  const rows = rowsForView(model, previous.view);
  const selected =
    previous.selected_id === null
      ? null
      : rows.some((row, index) => stableId(row, `${previous.view}-${index + 1}`) === previous.selected_id)
        ? previous.selected_id
        : null;
  return { view: previous.view, selected_id: selected, snapshot_token: tokenOf(model) };
}

/** Stable row identities shared by rendering and terminal navigation. */
export function repositoryScreenRowIds(model: RepositoryScreenModel, view: RepositoryScreenView): readonly string[] {
  return rowsForView(model, view).map((row, index) => stableId(row, `${view}-${index + 1}`));
}

function normalizeViewport(viewport: RepositoryScreenViewport): { width: number; height: number } {
  const width = Number.isFinite(viewport.width) ? Math.floor(viewport.width as number) : DEFAULT_WIDTH;
  const height = Number.isFinite(viewport.height) ? Math.floor(viewport.height as number) : DEFAULT_HEIGHT;
  return { width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) };
}

function renderSection(
  model: RepositoryScreenModel,
  view: RepositoryScreenView,
  selection: RepositoryScreenSelection | undefined,
): string[] {
  const rows = rowsForView(model, view);
  const lines = [`${view.toUpperCase()}:`];
  if (rows.length === 0) {
    lines.push("  unavailable");
    return lines;
  }
  const limit = Math.min(rows.length, MAX_ROWS_PER_SECTION);
  for (let index = 0; index < limit; index += 1) {
    const row = rows[index];
    if (row === undefined) continue;
    const id = stableId(row, `${view}-${index + 1}`);
    const marker = selection?.view === view && selection.selected_id === id ? ">" : " ";
    lines.push(`${marker}${rowText(row, view, index)}`);
  }
  if (rows.length > limit) lines.push(`  truncated rows=${rows.length - limit}`);
  return lines;
}

/**
 * Render one bounded, read-only screen from one snapshot.  Matrix and
 * conflict values are displayed exactly as supplied; no second classification
 * pass is performed here.
 */
export function renderRepositoryScreen(
  model: RepositoryScreenModel,
  viewport: RepositoryScreenViewport = {},
  selection?: RepositoryScreenSelection,
): string {
  const { width, height } = normalizeViewport(viewport);
  const token = tokenOf(model);
  const lines = [
    "NAWABARI repository (read-only)",
    `snapshot=${escapeTerminalText(token ?? "unavailable")}`,
    `views=${VIEWS.join("/")}  keys=↑↓ select  ←→ view  r refresh  q quit`,
    ...renderSection(model, selection?.view ?? "sessions", selection),
  ];

  const truncated = model.truncated === true || model.truncated === "true";
  const nextCursor = scalar(model.next_cursor);
  if (truncated || nextCursor !== null) {
    lines.push(
      `snapshot ${truncated ? "truncated" : "bounded"}${nextCursor === null ? "" : ` next_cursor=${escapeTerminalText(nextCursor)}`}`,
    );
  }
  const visible = lines.slice(0, height);
  if (lines.length > height) {
    const suffix = `… ${lines.length - height} more lines`;
    if (visible.length === 0) visible.push(fitLine(suffix, width));
    else visible[visible.length - 1] = suffix;
  }
  return visible.map((line) => fitLine(line, width)).join("\n");
}

/** JSON fallback metadata for non-interactive callers. */
export function repositoryScreenJson(model: RepositoryScreenModel, viewport: RepositoryScreenViewport = {}): string {
  const { width, height } = normalizeViewport(viewport);
  const value: ScreenRecord = {
    ui: "repository",
    interactive: false,
    snapshot_token: tokenOf(model),
    snapshot: model,
    screen: renderRepositoryScreen(model, { width, height }),
    truncated: model.truncated === true || model.truncated === "true",
    next_cursor: scalar(model.next_cursor),
  };
  try {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength <= MAX_JSON_BYTES) return encoded;
  } catch {
    // The bounded summary below remains valid JSON even for a non-JSON value.
  }
  return JSON.stringify({
    ui: "repository",
    interactive: false,
    snapshot_token: tokenOf(model),
    screen: renderRepositoryScreen(model, { width, height }),
    truncated: true,
    next_cursor: scalar(model.next_cursor),
  });
}

export function repositoryScreenViews(): readonly RepositoryScreenView[] {
  return VIEWS;
}
