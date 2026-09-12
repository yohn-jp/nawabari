import assert from "node:assert/strict";
import fs from "node:fs";
import process from "node:process";
import { test } from "node:test";

import {
  buildExplicitCompatibilityRuntimeProjection,
  discoverSandboxRuntimeLayout,
  type LegacyCompatibilityPathInputs,
} from "./sandbox.js";

const BACKEND_OWNED = new Set(["/dev", "/proc", "/tmp"]);

function legacyInputs(): LegacyCompatibilityPathInputs {
  const layout = discoverSandboxRuntimeLayout();
  return {
    runtime_paths: [
      "/dev",
      "/proc",
      "/tmp",
      ...[layout.nix_store, layout.nix_current_system, layout.nix_wrappers, layout.nix_user_profile].filter(
        (candidate): candidate is string => candidate !== null,
      ),
    ],
    system_paths: [
      ...[
        layout.usr,
        layout.bin,
        layout.lib,
        layout.lib64,
        layout.passwd,
        layout.group,
        layout.nsswitch,
        layout.hosts,
        layout.resolv_conf,
        layout.alternatives,
        layout.ssl_certs,
        layout.pki_certs,
        layout.ca_certificates,
      ].filter((candidate): candidate is string => candidate !== null),
    ],
    user_tool_paths: [layout.user_local_bin, layout.user_local_lib, layout.user_pnpm_bin].filter(
      (candidate): candidate is string => candidate !== null,
    ),
    user_tool_home: layout.user_home,
  };
}

test("compatibility builder preserves every supported legacy path with explicit provenance", (t) => {
  if (process.platform !== "linux") {
    t.skip("compatibility projection is Linux-only");
    return;
  }
  const layout = discoverSandboxRuntimeLayout();
  const result = buildExplicitCompatibilityRuntimeProjection(layout);
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (!result.ok) return;

  const byTarget = new Map(result.value.filesystem.map((entry) => [entry.target, entry]));
  assert.ok(result.value.filesystem.length > 0);
  assert.ok(result.value.filesystem.every((entry) => entry.provenance === "compatibility"));
  assert.ok(result.value.filesystem.every((entry) => entry.access_mode === "read-only"));
  assert.deepEqual(
    result.value.filesystem.map((entry) => entry.target),
    [...result.value.filesystem]
      .sort((left, right) => {
        const leftKey = `${left.target}:${left.source}`;
        const rightKey = `${right.target}:${right.source}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((entry) => entry.target),
  );

  const expectedRuntime = [
    "/dev",
    "/proc",
    "/tmp",
    ...[layout.nix_store, layout.nix_current_system, layout.nix_wrappers, layout.nix_user_profile].filter(
      (candidate): candidate is string => candidate !== null,
    ),
  ];
  for (const source of expectedRuntime) {
    if (BACKEND_OWNED.has(source)) {
      assert.equal(byTarget.has(source), false, `${source} remains backend-owned`);
      continue;
    }
    assert.equal(byTarget.has(source), true, `missing runtime projection for ${source}`);
  }

  const expectedSystem = [
    layout.usr,
    layout.bin,
    layout.lib,
    layout.lib64,
    layout.passwd,
    layout.group,
    layout.nsswitch,
    layout.hosts,
    layout.resolv_conf,
    layout.alternatives,
    layout.ssl_certs,
    layout.pki_certs,
    layout.ca_certificates,
  ];
  for (const source of expectedSystem) {
    if (source !== null) assert.equal(byTarget.has(source), true, `missing system projection for ${source}`);
  }

  for (const source of [layout.user_local_bin, layout.user_local_lib, layout.user_pnpm_bin]) {
    if (source === null) continue;
    const name = source.endsWith("/.local/bin")
      ? "/home/nawabari/.local/bin"
      : source.endsWith("/.local/lib")
        ? "/home/nawabari/.local/lib"
        : "/home/nawabari/.local/share/pnpm";
    assert.equal(byTarget.has(name), true, `missing user-tool projection for ${source}`);
  }
});

test("compatibility builder canonicalizes, deduplicates, and rejects unsafe legacy inputs", (t) => {
  if (process.platform !== "linux") {
    t.skip("compatibility projection is Linux-only");
    return;
  }
  const inputs = legacyInputs();
  const first = buildExplicitCompatibilityRuntimeProjection(inputs);
  const second = buildExplicitCompatibilityRuntimeProjection({
    ...inputs,
    runtime_paths: [...inputs.runtime_paths].reverse(),
    system_paths: [...inputs.system_paths].reverse(),
    user_tool_paths: [...inputs.user_tool_paths].reverse(),
  });
  assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
  assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, second.value);

  const duplicate = buildExplicitCompatibilityRuntimeProjection({
    runtime_paths: [],
    system_paths: ["/usr", "/usr"],
    user_tool_paths: [],
  });
  assert.equal(duplicate.ok, true, duplicate.ok ? "" : JSON.stringify(duplicate.error));
  if (duplicate.ok) assert.equal(duplicate.value.filesystem.length, 1);

  const unsafe = buildExplicitCompatibilityRuntimeProjection({
    runtime_paths: [],
    system_paths: [fs.realpathSync.native(process.cwd())],
    user_tool_paths: [],
  });
  assert.equal(unsafe.ok, false);
  if (!unsafe.ok) assert.equal(unsafe.error.code, "RUNTIME_PROJECTION_INVALID");
});
