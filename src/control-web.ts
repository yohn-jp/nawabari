/**
 * Built-in Control Server Web UI. It reads only the HTTP v1 API, renders data
 * with textContent (never HTML injection), and offers only the typed actions
 * listed by the canonical diagnostic action projection.
 */
export const CONTROL_WEB_POLL_INTERVAL_MS = 3_000;

export type ControlWebDocumentInput = {
  readonly nonce: string;
};

const STYLE = `
body{font:14px/1.4 system-ui,sans-serif;margin:0;background:#f7f7f8;color:#1b1b1f}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;background:#1b1b1f;color:#fff}
header h1{font-size:16px;margin:0;flex:1}
#operator-connect{max-width:520px;margin:24px auto;padding:16px;background:#fff;border:1px solid #ddd;border-radius:6px}
#operator-connect label,#operator-connect input{display:block;width:100%;box-sizing:border-box;margin:8px 0}
#operator-connect input{font:inherit;padding:8px}
#operator-connect p{font-size:12px;color:#444}
[hidden]{display:none!important}
main{display:grid;grid-template-columns:minmax(200px,260px) 1fr;gap:16px;padding:16px}
section{background:#fff;border:1px solid #ddd;border-radius:6px;padding:10px 12px;margin-bottom:12px;overflow-x:auto}
h2{font-size:14px;margin:0 0 8px}
button{font:inherit;cursor:pointer}
.repo{display:block;width:100%;text-align:left;margin-bottom:4px;padding:6px;border:1px solid #ccc;border-radius:4px;background:#fff}
.repo[aria-current=true]{border-color:#1b5fd0;background:#e8f0fe}
table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #eee;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-all}
tr.selectable{cursor:pointer}tr.selectable:hover{background:#f0f4ff}
pre{margin:0;white-space:pre-wrap;word-break:break-all;font-size:12px;max-height:320px;overflow:auto}
.status{font-size:12px;opacity:.85}.error{color:#b00020}
@media (max-width:720px){main{grid-template-columns:1fr}}
`;

const SCRIPT = `
const TOKEN_HEADER = "x-nawabari-control-token";
const POLL_MS = ${CONTROL_WEB_POLL_INTERVAL_MS};
let token = "";
const state = { repository: null, session: null, snapshotToken: null, pending: null };
const $ = (id) => document.getElementById(id);

function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}
function json(value) { return el("pre", JSON.stringify(value, null, 2)); }
function status(text, isError) { const s = $("status"); s.textContent = text; s.className = isError ? "status error" : "status"; }

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { [TOKEN_HEADER]: token, ...(init && init.body ? { "content-type": "application/json" } : {}) },
  });
  const body = await response.json();
  if ((response.status === 401 || response.status === 403) && body.error && body.error.code === "OPERATION_REJECTED") {
    token = "";
    $("operator-connect").hidden = false;
    $("control").hidden = true;
    $("disconnect").hidden = true;
    $("refresh").hidden = true;
    status("Credential rejected or expired. Enter the current host operator credential.", true);
  }
  return { status: response.status, body };
}

$("operator-connect").addEventListener("submit", (event) => {
  event.preventDefault();
  const supplied = $("operator-token").value.trim();
  if (!/^[0-9a-f]{64}$/u.test(supplied)) {
    status("Enter the 64-character credential from the host operator's credential file.", true);
    return;
  }
  token = supplied;
  $("operator-token").value = "";
  $("operator-connect").hidden = true;
  $("control").hidden = false;
  $("disconnect").hidden = false;
  $("refresh").hidden = false;
  loadRepositories();
});

$("disconnect").addEventListener("click", () => {
  token = "";
  $("operator-connect").hidden = false;
  $("control").hidden = true;
  $("disconnect").hidden = true;
  $("refresh").hidden = true;
  status("Enter the current host operator credential.");
});

function table(columns, rows, onSelect) {
  const t = el("table");
  const head = el("tr");
  for (const column of columns) head.append(el("th", column));
  t.append(head);
  for (const row of rows) {
    const tr = el("tr");
    for (const column of columns) {
      const value = row[column];
      tr.append(el("td", value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : value));
    }
    if (onSelect) { tr.className = "selectable"; tr.addEventListener("click", () => onSelect(row)); }
    t.append(tr);
  }
  return t;
}

function section(title, ...children) {
  const s = el("section");
  s.append(el("h2", title), ...children);
  return s;
}

async function loadRepositories() {
  const { status: code, body } = await api("/api/v1/repositories");
  const list = $("repositories");
  list.replaceChildren();
  if (code !== 200) { list.append(el("p", body.error && body.error.message, { class: "error" })); return; }
  if (body.repositories.length === 0) list.append(el("p", "No locally known repositories."));
  for (const repository of body.repositories) {
    const button = el("button", repository.worktree_path + (repository.available ? "" : " (unavailable)"), {
      class: "repo", "aria-current": String(state.repository === repository.repository_key),
    });
    button.addEventListener("click", () => { state.repository = repository.repository_key; state.session = null; state.snapshotToken = null; loadRepositories(); refresh(true); });
    list.append(button);
  }
}

async function refresh(force) {
  if (state.repository === null) return;
  const { status: code, body } = await api("/api/v1/repositories/" + encodeURIComponent(state.repository) + "/snapshot");
  if (code !== 200) { status("Snapshot unavailable: " + (body.error && body.error.message), true); return; }
  status("Snapshot " + body.view.snapshot_token + " captured " + body.snapshot.captured_at);
  if (!force && body.view.snapshot_token === state.snapshotToken) { if (state.session) await loadSession(); return; }
  state.snapshotToken = body.view.snapshot_token;
  renderSnapshot(body);
  if (state.session) await loadSession();
}

function renderSnapshot(body) {
  const view = body.view, snapshot = body.snapshot;
  const root = $("repository");
  root.replaceChildren(
    section("Repository", table(["repository_id", "worktree_path"], [body.repository]), json({
      registry: snapshot.registry, complete: snapshot.complete, incomplete_reasons: snapshot.incomplete_reasons,
    })),
    section("Sessions", table(["session_id", "state", "branch", "worktree"], view.sessions || [], (row) => { state.session = row.session_id; loadSession(); })),
    section("Claims", table(["resource", "mode", "sessionId", "claimId"], snapshot.claims || [])),
    section("Runtime / processes", json({ runtime: view.runtime, processes: snapshot.observations.processes })),
    section("Attention", json(view.attention)),
    section("Conflicts", json(view.conflicts)),
    section("History", json(snapshot.history || {})),
    ...(view.unavailable_sections ? [section("Unavailable", json(view.unavailable_sections))] : []),
    el("div", null, { id: "session" }),
  );
}

async function loadSession() {
  const target = $("session");
  if (!target || state.session === null) return;
  const path = "/api/v1/repositories/" + encodeURIComponent(state.repository) + "/sessions/" + encodeURIComponent(state.session);
  const { status: code, body } = await api(path);
  if (code !== 200) { target.replaceChildren(section("Session", el("p", body.error && body.error.message, { class: "error" }))); return; }
  const actions = el("div");
  const snapshot = body.action_snapshot;
  const offered = snapshot && snapshot.diagnostic && Array.isArray(snapshot.diagnostic.next_actions) ? snapshot.diagnostic.next_actions : [];
  if (offered.length === 0) actions.append(el("p", snapshot ? "No authorized lifecycle actions." : "Action evidence unavailable: " + JSON.stringify(body.action_snapshot_error)));
  for (const action of offered) {
    const button = el("button", action.action_id);
    button.addEventListener("click", () => dispatch(path, action.action_id, snapshot.token, { confirmed: false }));
    actions.append(button, document.createTextNode(" "));
  }
  const children = [
    table(["session_id", "state", "branch", "worktree"], [body.session]),
    json(snapshot ? { lifecycle_state: snapshot.diagnostic.lifecycle_state, physical_state: snapshot.diagnostic.physical_state, blockers: snapshot.diagnostic.blockers, token: snapshot.token } : body.action_snapshot_error),
    el("h2", "Authorized actions"), actions,
  ];
  if (state.pending && state.pending.session === state.session) children.push(renderConfirmation(path));
  target.replaceChildren(section("Session " + state.session, ...children));
}

function renderConfirmation(path) {
  const pending = state.pending;
  const confirm = el("button", "Confirm " + pending.action_id);
  confirm.addEventListener("click", () => dispatch(path, pending.action_id, pending.token, { confirmed: true, preview: pending.preview, operation_id: pending.operation_id }));
  const cancel = el("button", "Cancel");
  cancel.addEventListener("click", () => { state.pending = null; loadSession(); });
  return section("Destructive action preview (explicit confirmation required)", json(pending.preview), confirm, document.createTextNode(" "), cancel);
}

async function dispatch(path, actionId, actionToken, confirmation) {
  const { status: code, body } = await api(path + "/actions", { method: "POST", body: JSON.stringify({ action_id: actionId, token: actionToken, confirmation }) });
  if (code === 200 && body.result.status === "confirmation-required") {
    state.pending = { session: state.session, action_id: actionId, token: body.result.token, preview: body.result.preview, operation_id: crypto.randomUUID() };
    status("Review the authoritative preview before confirming.");
  } else if (code === 200) {
    state.pending = null;
    status(actionId + ": " + body.result.status);
  } else {
    state.pending = null;
    status((code === 409 ? "Stale or rejected; refreshed current state. " : "Action failed. ") + (body.error && body.error.code + ": " + body.error.message), true);
  }
  await refresh(true);
}

$("refresh").addEventListener("click", () => { if (token !== "") { loadRepositories(); refresh(true); } });
setInterval(() => { if (token !== "" && document.visibilityState === "visible") refresh(false); }, POLL_MS);
`;

export function renderControlWebDocument(input: ControlWebDocumentInput): string {
  if (!/^[A-Za-z0-9+/=]+$/u.test(input.nonce)) {
    throw new Error("Control Web document requires a base64 nonce.");
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Nawabari Control</title>
<style nonce="${input.nonce}">${STYLE}</style>
</head>
<body>
<header><h1>Nawabari Control</h1><span id="status" class="status"></span><button id="disconnect" type="button" hidden>Disconnect</button><button id="refresh" type="button" hidden>Refresh</button></header>
<form id="operator-connect">
<label for="operator-token">Host operator credential</label>
<input id="operator-token" type="password" autocomplete="off" spellcheck="false" aria-describedby="operator-help">
<p id="operator-help">Paste the credential from the host-only file path printed by the running server command. It expires when that server stops.</p>
<button type="submit">Connect</button>
</form>
<main id="control" hidden>
<nav><h2>Repositories</h2><div id="repositories"></div></nav>
<div id="repository"><p>Select a repository.</p></div>
</main>
<script nonce="${input.nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
