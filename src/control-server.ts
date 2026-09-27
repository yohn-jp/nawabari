import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./domain/errors.js";
import type { SessionBackend } from "./domain/session.js";
import type { GitCommandRunner } from "./git.js";
import { renderControlWebDocument } from "./control-web.js";
import {
  acquireControlServerLease,
  defaultControlServerOperationalDirectory,
  type ControlServerLease,
} from "./control-server-lease.js";
import {
  ControlRequestPool,
  MAX_CONTROL_REQUEST_BYTES,
  executeControlApiRequest,
  transportError,
  type CanonicalLockObservation,
  type ControlApiRequest,
  type ControlRequestBody,
  type ControlReply,
} from "./control-server-request-pool.js";

export { controlStatusForError, parseControlActionRequest } from "./control-server-request-pool.js";
export { MAX_CONTROL_REQUEST_BYTES } from "./control-server-request-pool.js";

/**
 * Machine-local Control Server: a transport/presentation adapter over the
 * existing per-repository backends. It owns only ephemeral listener/token
 * state; every read re-projects canonical state and every mutation goes
 * through the repository's own SessionActionDispatcher.
 */
export const CONTROL_SERVER_SCHEMA = "control-server.v1" as const;
export const CONTROL_SERVER_HOST = "127.0.0.1" as const;
export const DEFAULT_CONTROL_SERVER_PORT = 47_471 as const;
export const CONTROL_TOKEN_HEADER = "x-nawabari-control-token" as const;

export type ControlServerOptions = {
  /** 0 selects an ephemeral port; the CLI only accepts 1..65535. */
  readonly port: number;
  readonly backend: SessionBackend;
  readonly catalogPath: string;
  readonly git?: GitCommandRunner;
  /** Internal test seam; production uses a stable per-user operational path. */
  readonly operationalDirectory?: string;
  /** Set only by runCli when it composed the production default local backend. */
  readonly isolateLocalBackendRequests?: boolean;
  /** Test-only signal from the real canonical lock acquisition method. */
  readonly onCanonicalLockAcquire?: (observation: CanonicalLockObservation) => void;
};

export type ControlServer = {
  readonly port: number;
  readonly url: string;
  /** Host-only, owner-readable bootstrap artifact for the trusted operator. */
  readonly credentialFile: string;
  close(): Promise<void>;
};

const SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
});

function sameSecret(expected: string, supplied: string | string[] | undefined): boolean {
  if (typeof supplied !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(supplied, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

type HostCredentialArtifact = { readonly directory: string; readonly file: string };

/**
 * Use the per-user runtime directory when the OS provides one. The fallback
 * is the host temporary directory, which protected sessions replace with a
 * private tmpfs instead of mounting from the host.
 */
function hostCredentialDirectory(): string {
  if (process.platform === "linux" && typeof process.getuid === "function") {
    const runtime = `/run/user/${process.getuid()}`;
    try {
      const stat = fs.lstatSync(runtime);
      if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0) {
        return runtime;
      }
    } catch {
      // Fall back to host /tmp, which is replaced by a private tmpfs in the
      // protected runtime and is therefore outside its filesystem view.
    }
    return "/tmp";
  }
  return os.tmpdir();
}

function createHostCredentialArtifact(token: string): HostCredentialArtifact {
  const directory = fs.mkdtempSync(path.join(hostCredentialDirectory(), "nawabari-control-"));
  try {
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "credential");
    const descriptor = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(descriptor, `${token}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(file, 0o600);
    return { directory, file };
  } catch (error: unknown) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

class RequestBodyTooLarge extends Error {}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CONTROL_REQUEST_BYTES) throw new RequestBodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_CONTROL_REQUEST_BYTES) throw new RequestBodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startControlServer(options: ControlServerOptions): Promise<DomainResult<ControlServer>> {
  let lease: ControlServerLease;
  try {
    lease = await acquireControlServerLease({
      directory: options.operationalDirectory ?? defaultControlServerOperationalDirectory(),
    });
  } catch (error: unknown) {
    return failure(
      error instanceof DomainError
        ? error
        : new DomainError("BACKEND_UNAVAILABLE", "The Control Server singleton lease could not be acquired."),
    );
  }

  const token = randomBytes(32).toString("hex");
  let port = options.port;
  const allowedHosts = () => new Set([`${CONTROL_SERVER_HOST}:${port}`, `localhost:${port}`]);
  let requestPool: ControlRequestPool | undefined;
  try {
    if (options.isolateLocalBackendRequests === true && options.git === undefined) {
      requestPool = new ControlRequestPool({ onLockAcquire: options.onCanonicalLockAcquire });
      await requestPool.ready();
    }
  } catch {
    await requestPool?.close();
    await lease.release();
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The bounded Control Server request workers could not start."),
    );
  }

  async function route(request: http.IncomingMessage, segments: readonly string[]): Promise<ControlReply> {
    const method = request.method ?? "GET";
    const [, , resource, key] = segments;
    if (resource === "health" && key === undefined) {
      if (method !== "GET") return transportError(405, "INVALID_ARGUMENT", "Method not allowed.");
      return {
        status: 200,
        body: { ok: true, schema: CONTROL_SERVER_SCHEMA, status: "ok", host: CONTROL_SERVER_HOST, port },
      };
    }
    const extraSegments = segments.length > 7;
    if (resource !== "repositories" || extraSegments) {
      return transportError(404, "INVALID_ARGUMENT", "Unknown API resource.");
    }
    const [, , , requestKey, child, sessionId, leaf] = segments;
    let contentType: string | undefined;
    let readBody: (() => Promise<ControlRequestBody>) | undefined;
    if (
      method === "POST" &&
      requestKey !== undefined &&
      child === "sessions" &&
      sessionId !== undefined &&
      leaf === "actions" &&
      segments.length === 7
    ) {
      contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (contentType === "application/json") {
        readBody = async () => {
          try {
            return { body: await readJsonBody(request) };
          } catch (error: unknown) {
            return { bodyFailure: error instanceof RequestBodyTooLarge ? "too-large" : "invalid-json" };
          }
        };
      }
    }
    const requestData: ControlApiRequest = {
      method,
      segments,
      ...(contentType === undefined ? {} : { contentType }),
    };
    if (requestPool !== undefined) {
      const pending = requestPool.dispatch(requestData, options.catalogPath, readBody);
      return (
        (await pending) ??
        transportError(503, "BACKEND_UNAVAILABLE", "The bounded Control Server request capacity is full.")
      );
    }
    return executeControlApiRequest(
      requestData,
      {
        backend: options.backend,
        catalogPath: options.catalogPath,
        ...(options.git === undefined ? {} : { git: options.git }),
      },
      readBody,
    );
  }

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const send = (reply: ControlReply) => {
      response.writeHead(reply.status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(reply.body)}\n`);
    };
    const host = request.headers.host;
    if (host === undefined || !allowedHosts().has(host)) {
      send(transportError(403, "OPERATION_REJECTED", "Unexpected Host header."));
      return;
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://${host}`) {
      send(transportError(403, "OPERATION_REJECTED", "Cross-origin requests are rejected."));
      return;
    }
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (pathname === "/") {
      if (request.method !== "GET") {
        send(transportError(405, "INVALID_ARGUMENT", "Method not allowed."));
        return;
      }
      const nonce = randomBytes(16).toString("base64");
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` +
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      response.end(renderControlWebDocument({ nonce }));
      return;
    }
    let segments: string[];
    try {
      segments = pathname.split("/").slice(1).map(decodeURIComponent);
    } catch {
      send(transportError(400, "INVALID_ARGUMENT", "Malformed request path."));
      return;
    }
    if (segments[0] !== "api" || segments[1] !== "v1") {
      send(transportError(404, "INVALID_ARGUMENT", "Unknown resource."));
      return;
    }
    const supplied = request.headers[CONTROL_TOKEN_HEADER];
    if (supplied === undefined) {
      send(transportError(401, "OPERATION_REJECTED", "The local control token header is required."));
      return;
    }
    if (!sameSecret(token, supplied)) {
      send(transportError(403, "OPERATION_REJECTED", "The local control token is invalid."));
      return;
    }
    send(await route(request, segments));
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(500, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
      response.end(
        `${JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "An unexpected internal error occurred." } })}\n`,
      );
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  const listening = await new Promise<DomainResult<void>>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      resolve(
        failure(
          new DomainError(
            "OPERATION_REJECTED",
            error.code === "EADDRINUSE"
              ? `The control server port ${options.port} on ${CONTROL_SERVER_HOST} is already in use.`
              : `The control server could not listen on ${CONTROL_SERVER_HOST}:${options.port}.`,
            {
              reason: error.code === "EADDRINUSE" ? "address-in-use" : "listen-failed",
              host: CONTROL_SERVER_HOST,
              port: options.port,
            },
          ),
        ),
      );
    });
    server.listen({ host: CONTROL_SERVER_HOST, port: options.port, exclusive: true }, () =>
      resolve(success(undefined)),
    );
  });
  if (!listening.ok) {
    await requestPool?.close();
    await lease.release();
    return listening;
  }
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : options.port;

  let credential: HostCredentialArtifact;
  try {
    credential = createHostCredentialArtifact(token);
  } catch {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await requestPool?.close();
    await lease.release();
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The host-only Control credential file could not be created."),
    );
  }

  try {
    await lease.publishEndpoint(port);
  } catch {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await requestPool?.close();
    fs.rmSync(credential.directory, { recursive: true, force: true });
    await lease.release();
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The Control Server endpoint locator could not be published."),
    );
  }

  let closePromise: Promise<void> | undefined;

  return success({
    port,
    url: `http://${CONTROL_SERVER_HOST}:${port}/`,
    credentialFile: credential.file,
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          void (async () => {
            let cleanupError: unknown;
            try {
              await requestPool?.close();
            } catch (error: unknown) {
              cleanupError = error;
            }
            try {
              fs.rmSync(credential.directory, { recursive: true, force: true });
            } catch (error: unknown) {
              cleanupError ??= error;
            }
            try {
              await lease.release();
            } catch (error: unknown) {
              cleanupError ??= error;
            }
            if (cleanupError === undefined) resolve();
            else reject(cleanupError);
          })();
        });
        server.closeAllConnections();
      });
      return closePromise;
    },
  });
}
