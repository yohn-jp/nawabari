import {
  reconcileScreenSelection,
  renderRepositoryScreen,
  repositoryScreenJson,
  repositoryScreenRowIds,
  repositoryScreenViews,
  type RepositoryScreenModel,
  type RepositoryScreenSelection,
  type RepositoryScreenView,
  type RepositoryScreenViewport,
} from "./repository-screen.js";
import type { RepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";

/** Map one canonical runtime snapshot into the screen's projection-only model. */
export function repositoryScreenModelFromRuntimeSnapshot(snapshot: RepositoryRuntimeSnapshot): RepositoryScreenModel {
  const observations = snapshot.observations;
  return {
    snapshot_token: `${snapshot.registry.revision}:${snapshot.registry.claim_set_generation}`,
    sessions: snapshot.sessions.map((session) => ({
      session_id: session.sessionId,
      branch: session.branchName,
      state: session.state,
      worktree: session.worktreePath,
    })),
    files: observations.filesystem.status === "available" ? observations.filesystem.value : [],
    matrix: observations.coordination.status === "available" ? observations.coordination.value : [],
    attention: observations.lifecycle.status === "available" ? observations.lifecycle.value : [],
    runtime: observations.profiles.status === "available" ? observations.profiles.value : [],
    conflicts: snapshot.claims.map((claim) => ({
      claim_id: claim.claimId,
      resource: claim.resource,
      session_id: claim.sessionId,
      mode: claim.mode,
    })),
    truncated: !snapshot.complete,
    next_cursor: null,
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
    write(output, `${CLEAR_FRAME}${renderRepositoryScreen(model, viewport, selection)}\n`);
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await readSnapshot();
      model = next;
      selection = reconcileScreenSelection(selection, next);
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
      if (key === "q" || key === "Q" || key === "\u001b") cleanup("quit");
      else if (key === "\u0003") cleanup("interrupt");
      else if (key === "r" || key === "R") void refresh();
      else if (key === "\u001b[A" || key === "k") selection = changeSelection(model, selection, -1);
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
