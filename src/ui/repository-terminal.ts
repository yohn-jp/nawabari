import {
  reconcileScreenSelection,
  renderRepositoryScreen,
  repositoryScreenJson,
  repositoryScreenRowIds,
  repositoryScreenViews,
  escapeTerminalText,
  type RepositoryScreenModel,
  type RepositoryScreenSelection,
  type RepositoryScreenView,
  type RepositoryScreenViewport,
} from "./repository-screen.js";
import type { RepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import { type DomainResult, type JsonObject } from "../domain/errors.js";
import { projectFileSessionMatrix } from "../resource-coordination-view.js";
import { projectAgentRuntimeStatus, projectSessionAttention } from "../session-attention.js";
import type { SessionActionDispatcher, SessionActionIdentity, SessionActionToken } from "./session-actions.js";
import type { SessionLifecycleAction } from "../domain/session.js";

/** Map one canonical runtime snapshot into the screen's projection-only model. */
export function repositoryScreenModelFromRuntimeSnapshot(
  snapshot: RepositoryRuntimeSnapshot,
): DomainResult<RepositoryScreenModel> {
  const matrix = projectFileSessionMatrix(snapshot, { limit: 4_096 });
  if (!matrix.ok) return matrix;
  const attention = projectSessionAttention(snapshot);
  if (!attention.ok) return attention;

  const runtime: Record<string, unknown>[] = [];
  for (const session of snapshot.sessions) {
    const status = projectAgentRuntimeStatus(snapshot, session.sessionId, 4_096);
    if (!status.ok) return status;
    runtime.push(status.value as unknown as Record<string, unknown>);
  }

  const unavailable_sections: Record<string, JsonObject> = {};
  if (matrix.value.status === "unavailable") {
    const reason = matrix.value.reason;
    unavailable_sections.files = { status: "unavailable", source: "projectFileSessionMatrix", reason };
    unavailable_sections.conflicts = { status: "unavailable", source: "projectFileSessionMatrix", reason };
  }
  const unknownObservations = ["coordination", "profiles", "filesystem", "processes", "lifecycle"].filter(
    (name) => snapshot.observations[name as keyof typeof snapshot.observations].status === "unknown",
  );
  if (unknownObservations.length > 0) {
    const reason = `observations unavailable: ${unknownObservations.join(", ")}`;
    unavailable_sections.attention = { status: "unavailable", source: "projectSessionAttention", reason };
    unavailable_sections.runtime = { status: "unavailable", source: "projectAgentRuntimeStatus", reason };
  }

  const matrixRows = matrix.value.status === "available" ? matrix.value.rows : [];
  const conflicts = matrixRows.filter(
    (row) =>
      row.conflict !== "none" ||
      row.permission !== "allowed" ||
      row.mergeability === "conflict" ||
      row.mergeability === "unknown" ||
      row.blockers.length > 0,
  );
  const token = JSON.stringify({
    repository_id: snapshot.repository_id,
    registry_revision: snapshot.registry.revision,
    runtime_epoch: snapshot.registry.runtime_epoch,
    claim_set_generation: snapshot.registry.claim_set_generation,
  });
  return {
    ok: true,
    value: {
      snapshot_token: token,
      snapshot_identity: JSON.parse(token) as JsonObject,
      sessions: snapshot.sessions.map((session) => ({
        session_id: session.sessionId,
        repository: session.repositoryId,
        branch: session.branchName,
        state: session.state,
        worktree: session.worktreePath,
      })),
      files: matrixRows,
      matrix: matrixRows,
      attention: attention.value,
      runtime,
      conflicts,
      truncated:
        !snapshot.complete ||
        (matrix.value.status === "available" && matrix.value.truncated) ||
        runtime.some((item) => item.truncated === true),
      next_cursor: matrix.value.status === "available" ? matrix.value.cursor : null,
      ...(Object.keys(unavailable_sections).length === 0 ? {} : { unavailable_sections }),
    },
  };
}

export type RepositoryTerminalInput = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => RepositoryTerminalInput;
};

export type RepositoryTerminalOutput = NodeJS.WritableStream & {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
};

export type RepositorySnapshotReader = () => RepositoryScreenModel | Promise<RepositoryScreenModel>;

export type RepositoryTerminalController = {
  readonly readSnapshot?: RepositorySnapshotReader;
  /** Alias used by integration adapters that call the snapshot read directly. */
  readonly snapshot?: RepositorySnapshotReader;
  readonly stdin: RepositoryTerminalInput;
  readonly stdout: RepositoryTerminalOutput;
  readonly stderr?: RepositoryTerminalOutput;
  readonly viewport?: RepositoryScreenViewport;
  readonly json?: boolean;
  readonly isTTY?: boolean;
  readonly signal?: AbortSignal;
  /** Existing typed lifecycle action adapter; presentation never mutates state directly. */
  readonly sessionActions?: SessionActionDispatcher;
};

export type RepositoryTerminalResult = {
  readonly interactive: boolean;
  readonly reason: "quit" | "interrupt" | "eof" | "aborted" | "error";
  readonly snapshot_token: string | null;
  readonly view: RepositoryScreenView | null;
  readonly selected_id: string | null;
};

type EventSource = {
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const CLEAR_FRAME = "\u001b[2J\u001b[H";

function outputIsTTY(controller: RepositoryTerminalController): boolean {
  if (controller.isTTY !== undefined) return controller.isTTY;
  return controller.stdin.isTTY === true && controller.stdout.isTTY === true;
}

function write(output: RepositoryTerminalOutput, value: string): void {
  output.write(value);
}

function viewportFor(controller: RepositoryTerminalController): RepositoryScreenViewport {
  return {
    width: controller.viewport?.width ?? controller.stdout.columns ?? 100,
    height: controller.viewport?.height ?? controller.stdout.rows ?? 32,
  };
}

function readerFor(controller: RepositoryTerminalController): RepositorySnapshotReader {
  const reader = controller.readSnapshot ?? controller.snapshot;
  if (reader === undefined) throw new Error("Repository terminal requires one snapshot reader");
  return reader;
}

function inputText(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  return "";
}

function selectedIds(model: RepositoryScreenModel, view: RepositoryScreenView): readonly string[] {
  return repositoryScreenRowIds(model, view);
}

function changeSelection(
  model: RepositoryScreenModel,
  selection: RepositoryScreenSelection,
  delta: -1 | 1,
): RepositoryScreenSelection {
  const ids = selectedIds(model, selection.view);
  if (ids.length === 0) return selection;
  const current = selection.selected_id === null ? (delta > 0 ? -1 : ids.length) : ids.indexOf(selection.selected_id);
  const next = (current + delta + ids.length) % ids.length;
  return { ...selection, selected_id: ids[next] ?? null };
}

function changeView(
  model: RepositoryScreenModel,
  selection: RepositoryScreenSelection,
  delta: -1 | 1,
): RepositoryScreenSelection {
  const views = repositoryScreenViews();
  const current = views.indexOf(selection.view);
  const next = (current + delta + views.length) % views.length;
  const view = views[next] ?? "sessions";
  return reconcileScreenSelection({ view, selected_id: null, snapshot_token: selection.snapshot_token }, model);
}

function initialSelection(model: RepositoryScreenModel): RepositoryScreenSelection {
  return { view: "sessions", selected_id: null, snapshot_token: scalarToken(model) };
}

function scalarToken(model: RepositoryScreenModel): string | null {
  const token = model.snapshot_token ?? model.token;
  return typeof token === "string" ? token : null;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /[\u0000-\u001f\u007f-\u009f]/gu,
    (value) => `\\u{${(value.codePointAt(0) ?? 0).toString(16)}}`,
  );
}

function selectedSessionIdentity(
  model: RepositoryScreenModel,
  selection: RepositoryScreenSelection,
): SessionActionIdentity | null {
  if (selection.view !== "sessions" || selection.selected_id === null || !Array.isArray(model.sessions)) return null;
  const row = model.sessions.find((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    const id = record.session_id ?? record.id;
    return typeof id === "string" && id === selection.selected_id;
  });
  if (row === undefined || row === null || typeof row !== "object" || Array.isArray(row)) return null;
  const record = row as Record<string, unknown>;
  if (
    typeof record.session_id !== "string" ||
    typeof record.repository !== "string" ||
    typeof record.worktree !== "string"
  )
    return null;
  return { session_id: record.session_id, repository: record.repository, worktree: record.worktree };
}

type ActionMenu = {
  readonly identity: SessionActionIdentity;
  readonly token: SessionActionToken;
  readonly actions: readonly SessionLifecycleAction[];
};

type ActionConfirmation = {
  readonly identity: SessionActionIdentity;
  readonly action_id: SessionLifecycleAction["action_id"];
  readonly token: SessionActionToken;
  readonly preview?: import("../domain/session.js").SessionDiscardPreview;
};

function actionId(action: SessionLifecycleAction): string {
  return action.action_id;
}

function boundedActionJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength <= 16 * 1024) return encoded;
  } catch {
    // The fallback remains a safe printable diagnostic.
  }
  return "<bounded preview unavailable>";
}

function actionLine(action: SessionLifecycleAction, index: number): string {
  return `  ${index + 1}. ${actionId(action)}`;
}

function reasonResult(
  interactive: boolean,
  reason: RepositoryTerminalResult["reason"],
  model: RepositoryScreenModel | null,
  selection: RepositoryScreenSelection | null,
): RepositoryTerminalResult {
  return {
    interactive,
    reason,
    snapshot_token: model === null ? null : scalarToken(model),
    view: selection?.view ?? null,
    selected_id: selection?.selected_id ?? null,
  };
}

/**
 * Run the optional read-only terminal.  Non-TTY callers receive one bounded
 * projection and never enter raw mode or install terminal signal handlers.
 */
export async function runRepositoryTerminal(
  controller: RepositoryTerminalController,
): Promise<RepositoryTerminalResult> {
  const interactive = outputIsTTY(controller);
  if (controller.signal?.aborted) return reasonResult(interactive, "aborted", null, null);
  const readSnapshot = readerFor(controller);
  let model: RepositoryScreenModel;
  try {
    model = await readSnapshot();
  } catch (error) {
    const line = `repository ui: unavailable: ${safeError(error)}\n`;
    write(controller.stderr ?? controller.stdout, line);
    return reasonResult(interactive, "error", null, null);
  }

  let viewport = viewportFor(controller);
  if (!interactive) {
    const output = controller.json ? repositoryScreenJson(model, viewport) : renderRepositoryScreen(model, viewport);
    write(controller.stdout, `${output}\n`);
    return reasonResult(false, "eof", model, initialSelection(model));
  }

  let selection = initialSelection(model);
  if (controller.signal?.aborted) return reasonResult(true, "aborted", model, selection);
  const input = controller.stdin;
  const output = controller.stdout;
  const inputSource = input as unknown as EventSource;
  const outputSource = output as unknown as EventSource;
  const originalRawMode = input.setRawMode;
  let settled = false;
  let rawMode = false;
  let pending = "";
  let actionMenu: ActionMenu | null = null;
  let confirmation: ActionConfirmation | null = null;
  let actionMessage: string | null = null;
  let resolveResult: (result: RepositoryTerminalResult) => void = () => undefined;

  const result = new Promise<RepositoryTerminalResult>((resolve) => {
    resolveResult = resolve;
  });

  const cleanup = (reason: RepositoryTerminalResult["reason"]): void => {
    if (settled) return;
    settled = true;
    if (rawMode && originalRawMode !== undefined) {
      originalRawMode.call(input, false);
      rawMode = false;
    }
    inputSource.removeListener?.("data", onData);
    inputSource.removeListener?.("end", onEnd);
    inputSource.removeListener?.("error", onError);
    outputSource.removeListener?.("resize", onResize);
    controller.signal?.removeEventListener("abort", onAbort);
    process.removeListener("SIGINT", onSigint);
    write(output, "\n");
    resolveResult(reasonResult(true, reason, model, selection));
  };

  const draw = (): void => {
    const lines = [renderRepositoryScreen(model, viewport, selection)];
    if (actionMenu !== null) {
      lines.push(
        `ACTIONS for ${escapeTerminalText(actionMenu.identity.session_id)} (choose 1-${actionMenu.actions.length}, Escape cancels):`,
        ...actionMenu.actions.map(actionLine),
      );
    }
    if (confirmation !== null) {
      lines.push(
        `CONFIRM ${escapeTerminalText(confirmation.action_id)} for ${escapeTerminalText(confirmation.identity.session_id)}: press y to authorize, n/Escape to cancel`,
        ...(confirmation.preview === undefined
          ? []
          : [`preview=${escapeTerminalText(boundedActionJson(confirmation.preview))}`]),
      );
    }
    if (actionMessage !== null) lines.push(`action: ${escapeTerminalText(actionMessage)}`);
    write(output, `${CLEAR_FRAME}${lines.join("\n")}\n`);
  };

  const openActionMenu = async (): Promise<void> => {
    if (controller.sessionActions === undefined) {
      actionMessage = "typed session actions are unavailable";
      if (!settled) draw();
      return;
    }
    const identity = selectedSessionIdentity(model, selection);
    if (identity === null) {
      actionMessage = "select a stable session row before opening actions";
      if (!settled) draw();
      return;
    }
    const snapshot = await controller.sessionActions.readSessionActionSnapshot(identity);
    if (!snapshot.ok) {
      actionMessage = snapshot.error.message;
      if (!settled) draw();
      return;
    }
    actionMenu = {
      identity,
      token: snapshot.value.token,
      actions: (snapshot.value.diagnostic.next_actions ?? []).slice(0, 9),
    };
    confirmation = null;
    actionMessage = actionMenu.actions.length === 0 ? "no currently authorized actions" : null;
    if (!settled) draw();
  };

  const chooseAction = async (index: number): Promise<void> => {
    if (actionMenu === null || controller.sessionActions === undefined) return;
    const action = actionMenu.actions[index];
    if (action === undefined) return;
    const dispatched = await controller.sessionActions.dispatchSessionAction(
      action.action_id,
      actionMenu.identity,
      actionMenu.token,
      { confirmed: false },
    );
    if (dispatched.ok) {
      if (dispatched.value.status === "confirmation-required") {
        confirmation = {
          identity: actionMenu.identity,
          action_id: action.action_id,
          token: dispatched.value.token,
          preview: dispatched.value.preview,
        };
        actionMessage = "authoritative preview received";
      } else {
        actionMessage = `${action.action_id}: ${dispatched.value.status}`;
      }
    } else if (
      dispatched.error.code === "OPERATION_REJECTED" &&
      dispatched.error.details !== null &&
      dispatched.error.details.reason === "confirmation-required"
    ) {
      confirmation = { identity: actionMenu.identity, action_id: action.action_id, token: actionMenu.token };
      actionMessage = "explicit confirmation required";
    } else {
      actionMessage = dispatched.error.message;
    }
    if (!settled) draw();
  };

  const confirmAction = async (): Promise<void> => {
    if (confirmation === null || controller.sessionActions === undefined) return;
    const request = confirmation;
    const dispatched = await controller.sessionActions.dispatchSessionAction(
      request.action_id,
      request.identity,
      request.token,
      {
        confirmed: true,
        ...(request.preview === undefined ? {} : { preview: request.preview }),
      },
    );
    confirmation = null;
    actionMessage = dispatched.ok ? `${request.action_id}: ${dispatched.value.status}` : dispatched.error.message;
    if (!settled) draw();
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await readSnapshot();
      model = next;
      selection = reconcileScreenSelection(selection, next);
      actionMenu = null;
      confirmation = null;
      actionMessage = null;
      if (!settled) draw();
    } catch (error) {
      write(output, `\nrefresh unavailable: ${safeError(error)}\n`);
    }
  };

  const onResize = (): void => {
    viewport = viewportFor(controller);
    draw();
  };
  const onAbort = (): void => cleanup("aborted");
  const onSigint = (): void => cleanup("interrupt");
  const onEnd = (): void => cleanup("eof");
  const onError = (): void => cleanup("error");
  const onData = (chunk: unknown): void => {
    pending += inputText(chunk);
    while (pending.length > 0 && !settled) {
      let key: string | undefined;
      if (pending.startsWith("\u001b[")) {
        if (pending.length < 3) return;
        key = pending.slice(0, 3);
        pending = pending.slice(3);
      } else {
        key = pending[0];
        pending = pending.slice(1);
      }
      if (key === "\u001b" && (actionMenu !== null || confirmation !== null)) {
        actionMenu = null;
        confirmation = null;
        actionMessage = "action cancelled";
      } else if (key === "q" || key === "Q" || key === "\u001b") cleanup("quit");
      else if (key === "\u0003") cleanup("interrupt");
      else if (key === "r" || key === "R") void refresh();
      else if (confirmation !== null && (key === "n" || key === "N")) {
        confirmation = null;
        actionMessage = "action cancelled";
      } else if (confirmation !== null && (key === "y" || key === "Y")) {
        void confirmAction();
      } else if (actionMenu !== null && key !== undefined && /^[1-9]$/u.test(key)) {
        void chooseAction(Number(key) - 1);
      } else if (key === "a" || key === "A") {
        void openActionMenu();
      } else if (key === "\u001b[A" || key === "k") selection = changeSelection(model, selection, -1);
      else if (key === "\u001b[B" || key === "j") selection = changeSelection(model, selection, 1);
      else if (key === "\u001b[D" || key === "h") selection = changeView(model, selection, -1);
      else if (key === "\u001b[C" || key === "l") selection = changeView(model, selection, 1);
      else if (key === "1" || key === "2" || key === "3" || key === "4" || key === "5") {
        const view = repositoryScreenViews()[Number(key) - 1] ?? "sessions";
        selection = reconcileScreenSelection(
          { view, selected_id: null, snapshot_token: selection.snapshot_token },
          model,
        );
      }
      if (!settled && key !== "r" && key !== "R") draw();
    }
  };

  if (originalRawMode !== undefined) {
    originalRawMode.call(input, true);
    rawMode = true;
  }
  inputSource.on?.("data", onData as (...args: unknown[]) => void);
  inputSource.on?.("end", onEnd as (...args: unknown[]) => void);
  inputSource.on?.("error", onError as (...args: unknown[]) => void);
  outputSource.on?.("resize", onResize as (...args: unknown[]) => void);
  process.once("SIGINT", onSigint);
  controller.signal?.addEventListener("abort", onAbort, { once: true });
  if (controller.signal?.aborted) {
    onAbort();
    return result;
  }
  draw();
  return result;
}
