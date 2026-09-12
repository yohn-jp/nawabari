import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializePnpmMiddleware,
  PNPM_MIDDLEWARE_LAUNCHER_TARGET,
  PNPM_MIDDLEWARE_PROVIDER_IDS,
  PNPM_MIDDLEWARE_REQUIREMENTS,
  PROJECTED_PNPM_TARGET,
  type PnpmMiddlewareBackend,
} from "./runtime-provider-pnpm-middleware.js";
import {
  STRICT_RUNTIME_POLICY,
  validateSessionRuntimeProjection,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";

function executable(root: string, name: string, body: string): string {
  const result = path.join(root, name);
  fs.writeFileSync(result, body, { mode: 0o755 });
  fs.chmodSync(result, 0o755);
  return result;
}

function baseProjection(rtkSource: string, pnpmSource: string): SessionRuntimeProjection {
  const result = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "pnpm-middleware-test", version: "1" },
    requirements: [
      { id: "node-runtime", kind: "runtime", name: "node", version: ">=24" },
      PNPM_MIDDLEWARE_REQUIREMENTS.rtk,
      PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm,
    ],
    filesystem: [
      {
        source: rtkSource,
        target: "/materialized/rtk",
        access_mode: "read-only",
        provenance: "package",
      },
      {
        source: pnpmSource,
        target: "/materialized/pnpm",
        access_mode: "read-only",
        provenance: "package",
      },
    ],
    executables: [],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function backend(
  pathInSandbox: string,
  source: string,
  providerId: string,
  requirementId: string,
): PnpmMiddlewareBackend {
  return {
    path: pathInSandbox,
    source,
    provider: { id: providerId, requirement_id: requirementId },
  };
}

function materializationInput(root: string): {
  readonly projection: SessionRuntimeProjection;
  readonly launcher_path: string;
  readonly rtk: PnpmMiddlewareBackend;
  readonly real_pnpm: PnpmMiddlewareBackend;
} {
  const rtkSource = executable(
    root,
    "rtk",
    '#!/bin/sh\nset -eu\ntest "$1" = proxy\nbackend=$2\nshift 2\nexec "$backend" "$@"\n',
  );
  const pnpmSource = executable(
    root,
    "real-pnpm",
    "#!/bin/sh\nprintf 'cwd=%s\\n' \"$PWD\"\nprintf 'argv=%s\\n' \"$*\"\nprintf 'path=%s\\n' \"$PATH\"\nprintf 'stderr=%s\\n' 'forwarded' >&2\n",
  );
  return {
    projection: baseProjection(rtkSource, pnpmSource),
    launcher_path: path.join(root, "launcher", "pnpm"),
    rtk: backend("/materialized/rtk", rtkSource, PNPM_MIDDLEWARE_PROVIDER_IDS.rtk, PNPM_MIDDLEWARE_REQUIREMENTS.rtk.id),
    real_pnpm: backend(
      "/materialized/pnpm",
      pnpmSource,
      PNPM_MIDDLEWARE_PROVIDER_IDS.real_pnpm,
      PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
    ),
  };
}

test("materializes one exact pnpm launcher through the canonical executable projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const result = materializePnpmMiddleware(input);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.equal(result.value.executable_target, PROJECTED_PNPM_TARGET);
    assert.equal(result.value.launcher_target, PNPM_MIDDLEWARE_LAUNCHER_TARGET);
    assert.notEqual(fs.statSync(result.value.launcher_source).mode & 0o111, 0);

    const launcher = fs.readFileSync(result.value.launcher_source, "utf8");
    assert.match(launcher, /spawn\(rtkPath, \["proxy", realPnpmPath, \.\.\.process\.argv\.slice\(2\)\]/u);
    assert.match(launcher, /shell: false/u);
    assert.match(launcher, /stdio: "inherit"/u);
    assert.doesNotMatch(launcher, /command -v|which|env pnpm/u);
    assert.equal(result.value.projection.executables.at(-1)?.target, PNPM_MIDDLEWARE_LAUNCHER_TARGET);

    const compiled = compileRuntimeExecutableProjection(result.value.projection);
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (compiled.ok) {
      const pnpmEntry = compiled.value.find((entry) => entry.target === PROJECTED_PNPM_TARGET);
      assert.equal(pnpmEntry?.source, result.value.launcher_source);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the fixed launcher preserves argv, cwd, inherited PATH, stdout, and stderr without host fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-cwd-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const runnableProjection = validateSessionRuntimeProjection({
      ...input.projection,
      filesystem: input.projection.filesystem.map((entry) => ({ ...entry, target: entry.source })),
    });
    assert.equal(runnableProjection.ok, true, runnableProjection.ok ? "" : JSON.stringify(runnableProjection.error));
    if (!runnableProjection.ok) return;
    const runnable = materializePnpmMiddleware({
      ...input,
      projection: runnableProjection.value,
      rtk: { ...input.rtk, path: input.rtk.source },
      real_pnpm: { ...input.real_pnpm, path: input.real_pnpm.source },
    });
    assert.equal(runnable.ok, true, runnable.ok ? "" : JSON.stringify(runnable.error));
    if (!runnable.ok) return;

    const child = spawnSync(
      process.execPath,
      [runnable.value.launcher_source, "run", "arg with spaces", "--flag=value"],
      {
        cwd,
        env: { ...process.env, PATH: "/nawabari/bin", NAWABARI_PNPM_TEST: "selected" },
        input: "stdin is inherited by the fixed process chain\n",
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.match(child.stdout, new RegExp(`^cwd=${cwd.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n`, "u"));
    assert.match(child.stdout, /argv=run arg with spaces --flag=value\n/u);
    assert.match(child.stdout, /path=\/nawabari\/bin\n/u);
    assert.match(child.stderr, /stderr=forwarded\n/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("signal termination is forwarded through the fixed launcher chain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const hangingPnpm = executable(root, "hanging-pnpm", "#!/bin/sh\nwhile :; do sleep 1; done\n");
    const projection = baseProjection(input.rtk.source, hangingPnpm);
    const runnableProjection = validateSessionRuntimeProjection({
      ...projection,
      filesystem: projection.filesystem.map((entry) => ({ ...entry, target: entry.source })),
    });
    assert.equal(runnableProjection.ok, true, runnableProjection.ok ? "" : JSON.stringify(runnableProjection.error));
    if (!runnableProjection.ok) return;
    const result = materializePnpmMiddleware({
      ...input,
      projection: runnableProjection.value,
      rtk: { ...input.rtk, path: input.rtk.source },
      real_pnpm: { ...input.real_pnpm, path: hangingPnpm, source: hangingPnpm },
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    const child = spawn(process.execPath, [result.value.launcher_source], {
      cwd: root,
      env: { ...process.env, PATH: "/nawabari/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");
    const outcome = await closed;
    assert.equal(outcome.code, null);
    assert.equal(outcome.signal, "SIGTERM");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects projected, relative, equal, missing, non-executable, and mismatched backends before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);

    const relative = materializePnpmMiddleware({ ...input, rtk: { ...input.rtk, path: "rtk" } });
    assert.equal(relative.ok, false);
    if (!relative.ok) assert.equal(relative.error.code, "RUNTIME_PROJECTION_INVALID");

    const projected = materializePnpmMiddleware({ ...input, rtk: { ...input.rtk, path: PROJECTED_PNPM_TARGET } });
    assert.equal(projected.ok, false);
    if (!projected.ok) assert.equal(projected.error.code, "RUNTIME_PROJECTION_INVALID");

    const equal = materializePnpmMiddleware({
      ...input,
      real_pnpm: { ...input.real_pnpm, path: input.rtk.path, source: input.rtk.source },
    });
    assert.equal(equal.ok, false);
    if (!equal.ok) assert.equal(equal.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

    const missing = materializePnpmMiddleware({
      ...input,
      real_pnpm: { ...input.real_pnpm, source: path.join(root, "missing-pnpm") },
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const nonExecutable = path.join(root, "non-executable-pnpm");
    fs.writeFileSync(nonExecutable, "not executable\n", { mode: 0o644 });
    const nonExecutableProjection = baseProjection(input.rtk.source, nonExecutable);
    const rejectedMode = materializePnpmMiddleware({
      ...input,
      projection: nonExecutableProjection,
      real_pnpm: { ...input.real_pnpm, source: nonExecutable },
    });
    assert.equal(rejectedMode.ok, false);
    if (!rejectedMode.ok) assert.equal(rejectedMode.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const mismatch = materializePnpmMiddleware({
      ...input,
      rtk: { ...input.rtk, provider: { ...input.rtk.provider, id: "not-rtk" } },
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "RUNTIME_PROJECTION_INVALID");

    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires exact read-only materialization and never falls back to an ambient host executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const missingProjection = validateSessionRuntimeProjection({
      ...input.projection,
      filesystem: [
        {
          source: input.rtk.source,
          target: input.rtk.path,
          access_mode: "read-only",
          provenance: "package",
        },
      ],
    });
    assert.equal(missingProjection.ok, true, missingProjection.ok ? "" : JSON.stringify(missingProjection.error));
    if (!missingProjection.ok) return;
    const result = materializePnpmMiddleware({ ...input, projection: missingProjection.value });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(result.error.message, /exact read-only source-to-target materialization/u);
    }
    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
