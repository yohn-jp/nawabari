import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CONTROL_SERVER_HOST, startControlServer } from "./control-server.js";
import { CONTROL_WEB_POLL_INTERVAL_MS, renderControlWebDocument } from "./control-web.js";
import { createLocalSessionBackend } from "./domain/session-backend.js";

const TOKEN = "ab".repeat(32);
const NONCE = "bm9uY2U=";

test("Web UI document is dependency-free, nonce-bound and uses bounded polling only", () => {
  const document = renderControlWebDocument({ token: TOKEN, nonce: NONCE });
  assert.match(document, /^<!doctype html>/u);
  assert.match(document, new RegExp(`<script nonce="${NONCE}">`, "u"));
  assert.match(document, new RegExp(`<style nonce="${NONCE}">`, "u"));
  assert.equal(document.match(/<script/gu)?.length, 1);
  assert.doesNotMatch(document, /<script[^>]+src=|<link |https?:\/\//u, "no external framework or asset");
  assert.doesNotMatch(document, /WebSocket|EventSource/u, "no push channel");
  assert.doesNotMatch(document, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/u);
  assert.ok(CONTROL_WEB_POLL_INTERVAL_MS >= 2_000 && CONTROL_WEB_POLL_INTERVAL_MS <= 5_000);
  assert.match(document, /setInterval\([^]*POLL_MS\)/u);
  // The token is bootstrapped from the same-origin document into a header, never a URL.
  assert.equal(document.split(TOKEN).length - 1, 1);
  assert.match(document, /x-nawabari-control-token/u);
  assert.doesNotMatch(document, /[?&]token=/u);
  assert.throws(() => renderControlWebDocument({ token: "<script>", nonce: NONCE }));
});

test("Web UI reads only the v1 API and offers only canonical next_actions", () => {
  const document = renderControlWebDocument({ token: TOKEN, nonce: NONCE });
  const fetchTargets = [...document.matchAll(/api\("([^"]+)/gu)].map((match) => match[1]);
  assert.ok(fetchTargets.length > 0);
  for (const target of fetchTargets) assert.match(target ?? "", /^\/api\/v1\//u);
  assert.match(document, /diagnostic\.next_actions/u);
  assert.match(document, /confirmation-required/u);
  assert.match(document, /confirmed: true, preview: pending\.preview/u);
  for (const label of [
    "Repository",
    "Sessions",
    "Claims",
    "Runtime / processes",
    "Attention",
    "Conflicts",
    "History",
  ]) {
    assert.match(document, new RegExp(`section\\("${label.replace("/", "\\/")}"`, "u"));
  }
});

test("GET / serves the Web UI with a restrictive CSP and no CORS", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-control-web-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = await startControlServer({
    port: 0,
    backend: createLocalSessionBackend(),
    catalogPath: path.join(root, "control-repositories.json"),
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  t.after(() => started.value.close());
  const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>(
    (resolve, reject) => {
      http
        .get(
          {
            host: CONTROL_SERVER_HOST,
            port: started.value.port,
            path: "/",
            headers: { host: `${CONTROL_SERVER_HOST}:${started.value.port}` },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => (text += chunk));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          },
        )
        .on("error", reject);
    },
  );
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"]), /^text\/html/u);
  const csp = String(response.headers["content-security-policy"]);
  assert.match(csp, /default-src 'none'/u);
  assert.match(csp, /connect-src 'self'/u);
  assert.match(csp, /frame-ancestors 'none'/u);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.ok(response.text.includes(started.value.token));
  assert.ok(response.text.includes("Nawabari Control"));
});
