import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeExecutableProjection, runtimeExecutableProviderKey } from "./runtime-executable-projection.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { projectSessionRuntimeProjection, STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";
import {
  materializePnpmMiddlewareBackends,
  materializePnpmMiddlewareFhsRuntime,
  PNPM_BACKEND_EVIDENCE,
  PNPM_BUNDLE_RELATIVE_PATH,
  PNPM_EXECUTABLE_RELATIVE_PATH,
  PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
  PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
  PNPM_MIDDLEWARE_RTK_TARGET,
  PNPM_NIX_INSTALLABLE,
  PNPM_NIXPKGS_REF,
  REAL_PNPM_BACKEND_REQUIREMENT,
  REAL_PNPM_BACKEND_PROVIDER,
  RTK_BACKEND_EVIDENCE,
  RTK_BACKEND_REQUIREMENT,
  RTK_BACKEND_PROVIDER,
  RTK_NIX_INSTALLABLE,
  RTK_NIXPKGS_REF,
  type PnpmMiddlewareBackendDescriptor,
} from "./pnpm-middleware-backend-materialization.js";

type Fixture = Readonly<{
  readonly store: string;
  readonly roots: Readonly<{ readonly rtk: string; readonly pnpm: string }>;
  readonly closures: Readonly<{ readonly rtk: readonly string[]; readonly pnpm: readonly string[] }>;
  readonly cleanup: () => void;
}>;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-backend-materialization-"));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const roots = {
    rtk: path.join(store, "aaa-rtk-0.45.0"),
    pnpm: path.join(store, "bbb-pnpm-11.18.0"),
  };
  const dependencies = {
    rtk: path.join(store, "ccc-rtk-runtime-dependency"),
    pnpm: path.join(store, "ddd-pnpm-runtime-dependency"),
  };
  fs.mkdirSync(path.join(roots.rtk, "bin"), { recursive: true });
  fs.writeFileSync(path.join(roots.rtk, "bin", "rtk"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(roots.pnpm, "libexec", "pnpm", "bin"), { recursive: true });
  fs.mkdirSync(path.join(roots.pnpm, "libexec", "pnpm", "dist"), { recursive: true });
  fs.writeFileSync(path.join(roots.pnpm, PNPM_EXECUTABLE_RELATIVE_PATH), "#!/bin/sh\nprintf '11.18.0\\n'\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(roots.pnpm, PNPM_BUNDLE_RELATIVE_PATH), "export default undefined;\n");
  for (const dependency of Object.values(dependencies)) fs.mkdirSync(dependency);
  return {
    store,
    roots,
    closures: {
      rtk: [roots.rtk, dependencies.rtk],
      pnpm: [roots.pnpm, dependencies.pnpm],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function profile() {
  const result = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "remove", requirement_id: "node-runtime" },
      { operation: "add", requirement: RTK_BACKEND_REQUIREMENT },
      { operation: "add", requirement: REAL_PNPM_BACKEND_REQUIREMENT },
    ],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the pnpm middleware profile could not be resolved");
  return result.value;
}

function runnerFor(fixture: Fixture, reverse = false, failPnpm = false): NixCommandRunner {
  const rootsByInstallable: Readonly<Record<string, "rtk" | "pnpm">> = {
    [RTK_NIX_INSTALLABLE]: "rtk",
    [PNPM_NIX_INSTALLABLE]: "pnpm",
  };
  return (_executable, args) => {
    const installable = args.at(-1);
    if (typeof installable !== "string" || rootsByInstallable[installable] === undefined) {
      return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    }
    if (failPnpm && installable === PNPM_NIX_INSTALLABLE) {
      return { exit_code: 1, stdout: "", stderr: "pnpm is not materialized" };
    }
    const key = rootsByInstallable[installable] as "rtk" | "pnpm";
    const paths = reverse ? [...fixture.closures[key]].reverse() : fixture.closures[key];
    const selected = args.includes("--recursive") ? paths : [fixture.roots[key]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
}

function materializeFixture(
  fixture: Fixture,
  runner: NixCommandRunner = runnerFor(fixture),
): ReturnType<typeof materializePnpmMiddlewareBackends> {
  return materializePnpmMiddlewareBackends(profile(), {
    store_root: fixture.store,
    command_runner: runner,
    nix_executable: "/nix/store/pinned-nix/bin/nix",
  });
}

function evidenceBlock(markdown: string, heading: string): string {
  const fence = "```";
  const prefix = `## ${heading}\n\n${fence}text\n`;
  const start = markdown.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${heading} evidence`);
  const contentStart = start + prefix.length;
  const end = markdown.indexOf(`\n${fence}`, contentStart);
  assert.notEqual(end, -1, `unterminated ${heading} evidence`);
  return `${markdown.slice(contentStart, end)}\n`;
}

function checkedInEvidence(): Readonly<Record<string, string>> {
  const document = fs.readFileSync(
    new URL("../../docs/architecture/pnpm-middleware-backend-materialization.md", import.meta.url),
    "utf8",
  );
  return {
    rtk_version: evidenceBlock(document, "Exact RTK `--version` evidence"),
    rtk_proxy_help: evidenceBlock(document, "Exact RTK `proxy --help` evidence"),
    pnpm_version: evidenceBlock(document, "Exact pnpm `--version` evidence"),
    pnpm_help: evidenceBlock(document, "Exact pnpm `--help` evidence"),
  };
}

function sha256(source: string): string {
  return createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

test("materializes exact RTK and real pnpm sources for #306", () => {
  const fixture = makeFixture();
  try {
    const result = materializeFixture(fixture);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.deepEqual(result.value.requirements, [RTK_BACKEND_REQUIREMENT, REAL_PNPM_BACKEND_REQUIREMENT]);
    assert.equal(result.value.rtk.path, PNPM_MIDDLEWARE_RTK_TARGET);
    assert.equal(result.value.rtk.source, path.join(fixture.roots.rtk, "bin", "rtk"));
    assert.equal(result.value.rtk.provider, RTK_BACKEND_PROVIDER);
    assert.equal(result.value.real_pnpm.path, PNPM_MIDDLEWARE_REAL_PNPM_TARGET);
    assert.equal(result.value.real_pnpm.source, path.join(fixture.roots.pnpm, PNPM_EXECUTABLE_RELATIVE_PATH));
    assert.equal(result.value.real_pnpm.provider, REAL_PNPM_BACKEND_PROVIDER);
    assert.equal(result.value.projection.policy, STRICT_RUNTIME_POLICY);
    assert.equal(result.value.projection.executables.length, 0);
    assert.equal(
      result.value.projection.filesystem.some(
        (entry) => entry.source === fixture.store || entry.target === fixture.store,
      ),
      false,
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) => entry.source === result.value.rtk.source && entry.target === PNPM_MIDDLEWARE_RTK_TARGET,
      ),
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) => entry.source === result.value.real_pnpm.source && entry.target === PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
      ),
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) =>
          entry.source === path.join(fixture.roots.pnpm, PNPM_BUNDLE_RELATIVE_PATH) &&
          entry.target === PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
      ),
    );
    assert.ok(result.value.rtk_closure.store_paths.includes(fixture.roots.rtk));
    assert.ok(result.value.real_pnpm_closure.store_paths.includes(fixture.roots.pnpm));
    assert.equal(result.value.real_pnpm.source.endsWith("/bin/pnpm"), false);
    assert.deepEqual(result.value.rtk_provider_materialization, {
      provider: RTK_BACKEND_PROVIDER,
      source: result.value.rtk.source,
    });
    assert.deepEqual(result.value.real_pnpm_provider_materialization, {
      provider: REAL_PNPM_BACKEND_PROVIDER,
      source: result.value.real_pnpm.source,
    });
  } finally {
    fixture.cleanup();
  }
});

test("#293 consumes the exact file sources without creating backend aliases", () => {
  const fixture = makeFixture();
  try {
    const materialized = materializeFixture(fixture);
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;

    const withBackendEntrypoints = projectSessionRuntimeProjection({
      ...materialized.value.projection,
      executables: [
        {
          name: "rtk-backend",
          target: PNPM_MIDDLEWARE_RTK_TARGET,
          provider: RTK_BACKEND_PROVIDER,
          provenance: "package" as const,
        },
        {
          name: "pnpm-real-backend",
          target: PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
          provider: REAL_PNPM_BACKEND_PROVIDER,
          provenance: "package" as const,
        },
      ],
    });
    assert.equal(
      withBackendEntrypoints.ok,
      true,
      withBackendEntrypoints.ok ? "" : withBackendEntrypoints.error.message,
    );
    if (!withBackendEntrypoints.ok) return;
    const compiled = compileRuntimeExecutableProjection(
      withBackendEntrypoints.value,
      new Map([
        [runtimeExecutableProviderKey(RTK_BACKEND_PROVIDER), materialized.value.rtk_provider_materialization],
        [
          runtimeExecutableProviderKey(REAL_PNPM_BACKEND_PROVIDER),
          materialized.value.real_pnpm_provider_materialization,
        ],
      ]),
    );
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (!compiled.ok) return;
    assert.deepEqual(
      compiled.value.map((entry) => [entry.source, entry.target]),
      [
        [materialized.value.real_pnpm.source, "/nawabari/bin/pnpm-real-backend"],
        [materialized.value.rtk.source, "/nawabari/bin/rtk-backend"],
      ].sort((left, right) => left[1].localeCompare(right[1])),
    );
  } finally {
    fixture.cleanup();
  }
});

test("pins both immutable sources, canonicalizes ordering, and fails closed on drift or absence", () => {
  const fixture = makeFixture();
  try {
    const first = materializeFixture(fixture, runnerFor(fixture));
    const second = materializeFixture(fixture, runnerFor(fixture, true));
    assert.equal(first.ok, true, first.ok ? "" : first.error.message);
    assert.equal(second.ok, true, second.ok ? "" : second.error.message);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);

    const calls: string[] = [];
    const observingRunner: NixCommandRunner = (executable, args) => {
      calls.push(`${executable}\u0000${args.join("\u0000")}`);
      return runnerFor(fixture)(executable, args);
    };
    const observed = materializeFixture(fixture, observingRunner);
    assert.equal(observed.ok, true);
    assert.equal(
      calls.some((call) => call.includes("/host/path")),
      false,
    );
    assert.equal(
      calls.some((call) => call.includes(RTK_NIXPKGS_REF)),
      true,
    );
    assert.equal(
      calls.some((call) => call.includes(PNPM_NIXPKGS_REF)),
      true,
    );

    const overridden = materializePnpmMiddlewareBackends(profile(), {
      store_root: fixture.store,
      command_runner: observingRunner,
      package_attributes: { rtk: "host-rtk" },
    } as unknown as Parameters<typeof materializePnpmMiddlewareBackends>[1]);
    assert.equal(overridden.ok, false);
    if (!overridden.ok) assert.equal(overridden.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const missing = materializeFixture(fixture, runnerFor(fixture, false, true));
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.equal(missing.error.details?.requirement_id, REAL_PNPM_BACKEND_REQUIREMENT.id);
    }

    const driftRoot = path.join(fixture.store, "eee-pnpm-11.19.0");
    fs.cpSync(fixture.roots.pnpm, driftRoot, { recursive: true });
    const driftRunner: NixCommandRunner = (executable, args) => {
      const result = runnerFor(fixture)(executable, args);
      if (args.at(-1) !== PNPM_NIX_INSTALLABLE) return result;
      const selected = args.includes("--recursive") ? [driftRoot] : [driftRoot];
      return { ...result, stdout: JSON.stringify(Object.fromEntries(selected.map((item) => [item, null]))) };
    };
    const drifted = materializeFixture(fixture, driftRunner);
    assert.equal(drifted.ok, false);
    if (!drifted.ok) {
      assert.equal(drifted.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(drifted.error.message, /version/u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("#292 FHS input fails closed with the precise missing immutable binding", () => {
  const result = materializePnpmMiddlewareFhsRuntime({
    executables: [{ requirement_id: REAL_PNPM_BACKEND_REQUIREMENT.id, path: "/usr/bin/pnpm" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.equal(result.error.details?.missing_primitive, "immutable package source/version/provenance binding");
    assert.equal(result.error.details?.authority, "nawabari.fhs-runtime-materialization.v1");
  }
});

test("returns backend descriptors at the stable #306 handoff boundary", () => {
  const fixture = makeFixture();
  try {
    const materialized = materializeFixture(fixture);
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;

    const handoff = {
      rtk: materialized.value.rtk,
      real_pnpm: materialized.value.real_pnpm,
    } satisfies Readonly<{
      readonly rtk: PnpmMiddlewareBackendDescriptor;
      readonly real_pnpm: PnpmMiddlewareBackendDescriptor;
    }>;
    assert.deepEqual(handoff, {
      rtk: {
        path: PNPM_MIDDLEWARE_RTK_TARGET,
        source: materialized.value.rtk.source,
        provider: RTK_BACKEND_PROVIDER,
      },
      real_pnpm: {
        path: PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
        source: materialized.value.real_pnpm.source,
        provider: REAL_PNPM_BACKEND_PROVIDER,
      },
    });
    assert.deepEqual(Object.keys(handoff.rtk).sort(), ["path", "provider", "source"]);
    assert.deepEqual(Object.keys(handoff.real_pnpm).sort(), ["path", "provider", "source"]);
  } finally {
    fixture.cleanup();
  }
});

test("verifies exact pinned artifact hashes and checked-in evidence", (t) => {
  if (process.env.NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE !== "1") {
    t.skip("set NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE=1 for Nix artifact conformance");
    return;
  }

  const materialized = materializePnpmMiddlewareBackends(profile());
  assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
  if (!materialized.ok) return;

  assert.equal(sha256(materialized.value.rtk.source), RTK_BACKEND_EVIDENCE.executable_sha256);
  assert.equal(sha256(materialized.value.real_pnpm.source), PNPM_BACKEND_EVIDENCE.executable_sha256);
  const pnpmRoot = materialized.value.real_pnpm_closure.packages.find(
    (candidate) => candidate.requirement_id === REAL_PNPM_BACKEND_REQUIREMENT.id,
  )?.root;
  assert.notEqual(pnpmRoot, undefined);
  if (pnpmRoot === undefined) return;
  assert.equal(sha256(path.posix.join(pnpmRoot, PNPM_BUNDLE_RELATIVE_PATH)), PNPM_BACKEND_EVIDENCE.bundle_sha256);

  const evidence = checkedInEvidence();
  assert.equal(evidence.rtk_version, RTK_BACKEND_EVIDENCE.version);
  assert.equal(evidence.pnpm_version, PNPM_BACKEND_EVIDENCE.version);
  assert.equal(
    createHash("sha256").update(evidence.rtk_proxy_help).digest("hex"),
    RTK_BACKEND_EVIDENCE.proxy_help_sha256,
  );
  assert.equal(createHash("sha256").update(evidence.pnpm_help).digest("hex"), PNPM_BACKEND_EVIDENCE.help_sha256);
});
