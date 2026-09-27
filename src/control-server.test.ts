import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "./cli.js";
import { repositoryKey } from "./control-repositories.js";
import {
  CONTROL_SERVER_HOST,
  CONTROL_TOKEN_HEADER,
  MAX_CONTROL_REQUEST_BYTES,
  controlStatusForError,
  startControlServer,
  type ControlServer,
} from "./control-server.js";
import { DomainError } from "./domain/errors.js";
import { createLocalSessionBackend } from "./domain/session-backend.js";

type Fixture = {
  readonly root: string;
  readonly catalog: string;
  readonly worktreeRoot: string;
};

type Response = { status: number; headers: http.IncomingHttpHeaders; text: string; body: unknown };
type CreatedSession = { readonly session_id: string; readonly repository: string; readonly worktree: string };

/** Read one field path from a parsed JSON response. */
function at(value: unknown, ...keys: readonly (string | number)[]): unknown {
  return keys.reduce<unknown>(
    (current, key) => (current as Record<string | number, unknown> | undefined)?.[key],
    value,
  );
}

function list(value: unknown, ...keys: readonly (string | number)[]): readonly unknown[] {
  const found = at(value, ...keys);
  assert.ok(Array.isArray(found), `expected an array at ${keys.join(".")}`);
  return found;
}

function fixture(t: test.TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-control-server-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "wt"));
  return { root, catalog: path.join(root, "state", "control-repositories.json"), worktreeRoot: path.join(root, "wt") };
}

function repository(context: Fixture, name: string): string {
  const directory = path.join(context.root, name);
  fs.mkdirSync(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
  git("init", "--quiet", "-b", "main");
  git("config", "user.name", "Nawabari Tests");
  git("config", "user.email", "tests@example.invalid");
  fs.writeFileSync(path.join(directory, "README.md"), `${name}\n`);
  git("add", "README.md");
  git("commit", "--quiet", "-m", "initial");
  return directory;
}

async function cli(context: Fixture, cwd: string, args: string[]): Promise<{ code: number; body: unknown }> {
  const stdout: string[] = [];
  const code = await runCli(["--json", ...args], {
    cwd,
    controlServer: { catalogPath: context.catalog },
    io: { stdout: (line) => stdout.push(line), stderr: () => undefined },
  });
  return { code, body: JSON.parse(stdout[0] ?? "{}") };
}

async function createSession(context: Fixture, cwd: string, branch: string): Promise<CreatedSession> {
  const created = await cli(context, cwd, [
    "session",
    "create",
    "--branch",
    branch,
    "--worktree-root",
    context.worktreeRoot,
  ]);
  assert.equal(created.code, 0, JSON.stringify(created.body));
  return created.body as CreatedSession;
}

async function start(t: test.TestContext, context: Fixture, port = 0): Promise<ControlServer> {
  const started = await startControlServer({
    port,
    backend: createLocalSessionBackend(),
    catalogPath: context.catalog,
  });
  if (!started.ok) throw started.error;
  t.after(() => started.value.close());
  return started.value;
}

function call(
  server: Pick<ControlServer, "port" | "token">,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { host: `${CONTROL_SERVER_HOST}:${server.port}`, ...options.headers };
  const token = options.token === undefined ? server.token : options.token;
  if (token !== null) headers[CONTROL_TOKEN_HEADER] = token;
  if (options.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: CONTROL_SERVER_HOST, port: server.port, path: pathname, method: options.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = {};
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            // HTML document
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text, body });
        });
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

function postAction(server: ControlServer, repositoryKeyValue: string, sessionId: string, body: unknown) {
  return call(server, `/api/v1/repositories/${repositoryKeyValue}/sessions/${sessionId}/actions`, {
    method: "POST",
    headers: { origin: `http://${CONTROL_SERVER_HOST}:${server.port}` },
    body: JSON.stringify(body),
  });
}

async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, CONTROL_SERVER_HOST, resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("one loopback listener serves multiple repositories with isolated authority", async (t) => {
  const context = fixture(t);
  const alpha = repository(context, "alpha");
  const beta = repository(context, "beta");
  const alphaSession = await createSession(context, alpha, "feature/alpha");
  const betaSession = await createSession(context, beta, "feature/beta");
  const server = await start(t, context);
  assert.equal(server.url, `http://127.0.0.1:${server.port}/`);

  const health = await call(server, "/api/v1/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    ok: true,
    schema: "control-server.v1",
    status: "ok",
    host: "127.0.0.1",
    port: server.port,
  });
  assert.equal(health.headers["access-control-allow-origin"], undefined);

  const listed = await call(server, "/api/v1/repositories");
  assert.equal(listed.status, 200);
  const alphaKey = repositoryKey(alphaSession.repository);
  const betaKey = repositoryKey(betaSession.repository);
  assert.deepEqual(
    list(listed.body, "repositories").map((entry) => [
      at(entry, "repository_key"),
      at(entry, "worktree_path"),
      at(entry, "available"),
    ]),
    [
      [alphaKey, alpha, true],
      [betaKey, beta, true],
    ],
  );
  assert.deepEqual(Object.keys(at(listed.body, "repositories", 0) as object).sort(), [
    "available",
    "repository_id",
    "repository_key",
    "worktree_path",
  ]);

  const [alphaSnapshot, betaSnapshot] = await Promise.all([
    call(server, `/api/v1/repositories/${alphaKey}/snapshot`),
    call(server, `/api/v1/repositories/${betaKey}/snapshot`),
  ]);
  assert.equal(alphaSnapshot.status, 200);
  assert.equal(at(alphaSnapshot.body, "snapshot", "contract_id"), "nawabari.repository-runtime-snapshot.v1");
  assert.equal(at(alphaSnapshot.body, "snapshot", "repository_id"), alphaSession.repository);
  assert.equal(at(betaSnapshot.body, "snapshot", "repository_id"), betaSession.repository);
  assert.deepEqual(
    list(alphaSnapshot.body, "snapshot", "sessions").map((session) => at(session, "sessionId")),
    [alphaSession.session_id],
  );
  assert.deepEqual(
    list(betaSnapshot.body, "snapshot", "sessions").map((session) => at(session, "sessionId")),
    [betaSession.session_id],
  );
  assert.deepEqual(JSON.parse(String(at(alphaSnapshot.body, "view", "snapshot_token"))), {
    repository_id: alphaSession.repository,
    registry_revision: at(alphaSnapshot.body, "snapshot", "registry", "revision"),
    runtime_epoch: at(alphaSnapshot.body, "snapshot", "registry", "runtime_epoch"),
    claim_set_generation: at(alphaSnapshot.body, "snapshot", "registry", "claim_set_generation"),
  });

  const own = await call(server, `/api/v1/repositories/${alphaKey}/sessions/${alphaSession.session_id}`);
  assert.equal(own.status, 200);
  assert.equal(at(own.body, "session", "session_id"), alphaSession.session_id);
  assert.equal(at(own.body, "action_snapshot", "token", "session_id"), alphaSession.session_id);
  const crossed = await call(server, `/api/v1/repositories/${betaKey}/sessions/${alphaSession.session_id}`);
  assert.equal(crossed.status, 404, "a session is never resolved through another repository's authority");
  assert.equal(at(crossed.body, "error", "code"), "SESSION_NOT_FOUND");
  const unknownRepository = await call(server, `/api/v1/repositories/${"0".repeat(32)}/snapshot`);
  assert.equal(unknownRepository.status, 404);
  assert.equal((await call(server, "/api/v1/unknown")).status, 404);
  assert.equal((await call(server, "/api/v1/repositories", { method: "DELETE" })).status, 405);
});

test("browser refresh observes concurrent direct CLI changes and restart rebuilds from persistence", async (t) => {
  const context = fixture(t);
  const alpha = repository(context, "alpha");
  const first = await createSession(context, alpha, "feature/first");
  const key = repositoryKey(first.repository);
  const server = await start(t, context);
  const before = await call(server, `/api/v1/repositories/${key}/snapshot`);

  const second = await createSession(context, alpha, "feature/second");
  const after = await call(server, `/api/v1/repositories/${key}/snapshot`);
  assert.notEqual(at(after.body, "view", "snapshot_token"), at(before.body, "view", "snapshot_token"));
  assert.deepEqual(
    list(after.body, "snapshot", "sessions")
      .map((session) => String(at(session, "sessionId")))
      .sort(),
    [first.session_id, second.session_id].sort(),
  );

  await server.close();
  const restarted = await start(t, context);
  assert.notEqual(restarted.token, server.token, "the control token rotates on restart");
  const reread = await call(restarted, `/api/v1/repositories/${key}/snapshot`);
  assert.equal(at(reread.body, "view", "snapshot_token"), at(after.body, "view", "snapshot_token"));
  assert.equal((await call(restarted, "/api/v1/health", { token: server.token })).status, 403);
});

test("typed actions reject stale evidence and keep destructive preview plus confirmation", async (t) => {
  const context = fixture(t);
  const alpha = repository(context, "alpha");
  const session = await createSession(context, alpha, "feature/dirty");
  fs.writeFileSync(path.join(session.worktree, "scratch.txt"), "uncommitted\n");
  const key = repositoryKey(session.repository);
  const server = await start(t, context);
  const sessionPath = `/api/v1/repositories/${key}/sessions/${session.session_id}`;

  const read = await call(server, sessionPath);
  assert.equal(read.status, 200);
  const offered = list(read.body, "action_snapshot", "diagnostic", "next_actions").map((action) =>
    at(action, "action_id"),
  );
  assert.deepEqual(offered, ["retain-session", "discard-session"]);
  const token = at(read.body, "action_snapshot", "token");

  const observed = await postAction(server, key, session.session_id, { action_id: "retain-session", token });
  assert.equal(observed.status, 200, observed.text);
  assert.equal(at(observed.body, "result", "status"), "observed");
  const unauthorized = await postAction(server, key, session.session_id, {
    action_id: "reconcile-physical-state",
    token,
  });
  assert.equal(unauthorized.status, 409);
  assert.equal(at(unauthorized.body, "error", "code"), "OPERATION_REJECTED");

  // A concurrent direct CLI mutation invalidates the browser's evidence.
  const claimed = await cli(context, alpha, [
    "session",
    "claim",
    "--session",
    session.session_id,
    "--resource",
    "README.md",
    "--mode",
    "read",
  ]);
  assert.equal(claimed.code, 0, JSON.stringify(claimed.body));
  const stale = await postAction(server, key, session.session_id, { action_id: "retain-session", token });
  assert.equal(stale.status, 409);
  assert.equal(at(stale.body, "error", "code"), "STALE_SESSION");
  const refreshed = at((await call(server, sessionPath)).body, "action_snapshot", "token");
  assert.notDeepEqual(refreshed, token);
  assert.equal(
    (await postAction(server, key, session.session_id, { action_id: "retain-session", token: refreshed })).status,
    200,
  );

  const previewed = await postAction(server, key, session.session_id, {
    action_id: "discard-session",
    token: refreshed,
    confirmation: { confirmed: false },
  });
  assert.equal(previewed.status, 200, previewed.text);
  assert.equal(at(previewed.body, "result", "status"), "confirmation-required");
  const preview = at(previewed.body, "result", "preview");
  assert.equal(at(preview, "session_id"), session.session_id);

  const unreviewed = await postAction(server, key, session.session_id, {
    action_id: "discard-session",
    token: refreshed,
    confirmation: { confirmed: true },
  });
  assert.equal(unreviewed.status, 409);
  assert.equal(at(unreviewed.body, "error", "details", "reason"), "discard-preview-required");
  assert.equal(fs.existsSync(session.worktree), true, "no destructive mutation without the reviewed preview");

  const discarded = await postAction(server, key, session.session_id, {
    action_id: "discard-session",
    token: at(previewed.body, "result", "token"),
    confirmation: { confirmed: true, preview, operation_id: "control-server-test-discard" },
  });
  assert.equal(discarded.status, 200, discarded.text);
  assert.equal(at(discarded.body, "result", "status"), "completed");
  assert.equal(fs.existsSync(session.worktree), false);
  assert.ok(!JSON.stringify(discarded.body).includes(server.token));
  assert.ok(!fs.readFileSync(context.catalog, "utf8").includes(server.token));
});

test("transport security rejects host, origin, token, content-type and body violations", async (t) => {
  const context = fixture(t);
  const alpha = repository(context, "alpha");
  const session = await createSession(context, alpha, "feature/security");
  fs.writeFileSync(path.join(session.worktree, "scratch.txt"), "uncommitted\n");
  const key = repositoryKey(session.repository);
  const server = await start(t, context);
  const actions = `/api/v1/repositories/${key}/sessions/${session.session_id}/actions`;
  const token = at(
    (await call(server, `/api/v1/repositories/${key}/sessions/${session.session_id}`)).body,
    "action_snapshot",
    "token",
  );
  const valid = JSON.stringify({ action_id: "retain-session", token });

  assert.equal((await call(server, "/api/v1/health", { token: null })).status, 401);
  assert.equal((await call(server, "/api/v1/health", { token: "0".repeat(64) })).status, 403);
  assert.equal((await call(server, "/api/v1/health", { token: `${server.token}0` })).status, 403);
  for (const host of [`evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, "127.0.0.1"]) {
    const rejected = await call(server, "/", { headers: { host } });
    assert.equal(rejected.status, 403, host);
    assert.ok(!rejected.text.includes(server.token));
  }
  const localhost = await call(server, "/api/v1/health", { headers: { host: `localhost:${server.port}` } });
  assert.equal(localhost.status, 200);
  const crossOrigin = await call(server, actions, {
    method: "POST",
    headers: { origin: "http://evil.example" },
    body: valid,
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers["access-control-allow-origin"], undefined);
  const preflight = await call(server, actions, { method: "OPTIONS", headers: { origin: "http://evil.example" } });
  assert.equal(preflight.status, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);

  const origin = { origin: `http://${CONTROL_SERVER_HOST}:${server.port}` };
  const form = await call(server, actions, {
    method: "POST",
    headers: { ...origin, "content-type": "application/x-www-form-urlencoded" },
    body: valid,
  });
  assert.equal(form.status, 415);
  assert.equal((await call(server, actions, { method: "POST", headers: origin, body: "{" })).status, 400);
  const oversized = await call(server, actions, {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ padding: "x".repeat(MAX_CONTROL_REQUEST_BYTES) }),
  });
  assert.equal(oversized.status, 413);
  for (const body of [
    { action_id: "retain-session", token, command: "rm -rf /" },
    { action_id: "session discard", token },
    { action_id: "retain-session" },
    { action_id: "retain-session", token, confirmation: { confirmed: false, preview: {} } },
  ]) {
    const rejected = await call(server, actions, { method: "POST", headers: origin, body: JSON.stringify(body) });
    assert.equal(rejected.status, 400, JSON.stringify(body));
    assert.equal(at(rejected.body, "error", "code"), "INVALID_ARGUMENT");
  }
  assert.equal((await call(server, `${actions}/../x`, { method: "GET" })).status, 404);
  assert.equal((await call(server, actions, { method: "GET" })).status, 405);
  const accepted = await call(server, actions, { method: "POST", headers: origin, body: valid });
  assert.equal(accepted.status, 200, accepted.text);
});

test("transport status mapping preserves domain error semantics", () => {
  assert.equal(controlStatusForError(new DomainError("SESSION_NOT_FOUND", "x")), 404);
  assert.equal(controlStatusForError(new DomainError("INVALID_ARGUMENT", "x")), 400);
  assert.equal(controlStatusForError(new DomainError("INVALID_SESSION_ID", "x")), 400);
  assert.equal(controlStatusForError(new DomainError("STALE_SESSION", "x")), 409);
  assert.equal(controlStatusForError(new DomainError("STALE_CLAIM_SET", "x")), 409);
  assert.equal(controlStatusForError(new DomainError("BACKEND_UNAVAILABLE", "x")), 503);
  assert.equal(controlStatusForError(new DomainError("INTERNAL_ERROR", "x")), 500);
});

test("port conflicts fail explicitly and shutdown releases the listener", async (t) => {
  const context = fixture(t);
  const port = await freePort();
  const first = await start(t, context, port);
  const conflict = await startControlServer({
    port,
    backend: createLocalSessionBackend(),
    catalogPath: context.catalog,
  });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) {
    assert.equal(conflict.error.code, "OPERATION_REJECTED");
    assert.equal(conflict.error.details?.reason, "address-in-use");
  }
  const conflictCli = await cli(context, context.root, ["server", "--port", String(port)]);
  assert.equal(conflictCli.code, 3);
  assert.equal(at(conflictCli.body, "details", "reason"), "address-in-use");

  await first.close();
  const again = await start(t, context, port);
  assert.equal(again.port, port);
});

test("server CLI runs in the foreground on loopback, never prints the token, and stops on signal", async (t) => {
  const context = fixture(t);
  const alpha = repository(context, "alpha");
  const session = await createSession(context, alpha, "feature/cli-server");
  fs.rmSync(context.catalog);
  const port = await freePort();
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let listening: ControlServer | undefined;
  const running = runCli(["--json", "server", "--port", String(port)], {
    cwd: alpha,
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    controlServer: {
      catalogPath: context.catalog,
      signal: controller.signal,
      onListening: (server) => {
        listening = server;
        void call(server, "/api/v1/repositories").then((response) => {
          assert.deepEqual(
            list(response.body, "repositories").map((entry) => at(entry, "repository_id")),
            [session.repository],
            "starting from a managed repository records it for discovery",
          );
          controller.abort();
        });
      },
    },
  });
  assert.equal(await running, 0);
  assert.ok(listening);
  assert.equal(stdout.length, 1);
  const document = JSON.parse(stdout[0] ?? "{}");
  assert.deepEqual(document, {
    ok: true,
    command: "server",
    schema: "control-server.v1",
    status: "listening",
    url: `http://127.0.0.1:${port}/`,
    host: "127.0.0.1",
    port,
  });
  assert.ok(![...stdout, ...stderr].join("\n").includes(listening.token));
  const released = net.createServer();
  await new Promise<void>((resolve, reject) => {
    released.once("error", reject);
    released.listen(port, CONTROL_SERVER_HOST, resolve);
  });
  await new Promise<void>((resolve) => released.close(() => resolve()));

  const remote = await cli(context, alpha, ["server", "--host", "0.0.0.0"]);
  assert.equal(remote.code, 2);
  assert.equal(at(remote.body, "code"), "INVALID_ARGUMENT");
  for (const invalid of ["0", "65536", "-1", "80a"]) {
    const rejected = await cli(context, alpha, ["server", `--port=${invalid}`]);
    assert.equal(rejected.code, 2, invalid);
  }
  const direct = await cli(context, alpha, ["session", "list"]);
  assert.equal(direct.code, 0, "direct CLI operation needs no running server");
  assert.equal(list(direct.body, "sessions").length, 1);
});
