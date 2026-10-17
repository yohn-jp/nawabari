import assert from "node:assert/strict";
import { test } from "node:test";

import { procfsPolicyFromMountInfo } from "./sandbox-procfs.js";

const proc = "40 37 0:34 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw";

test("unmasked parent proc selects a new private procfs", () => {
  assert.deepEqual(procfsPolicyFromMountInfo(proc), { mode: "private", reason: null });
});

test("masked parent proc selects a denied view without exposing parent processes", () => {
  for (const child of ["/proc/sys", "/proc/kcore", "/proc/acpi", "/proc/escaped\\040path"]) {
    assert.deepEqual(procfsPolicyFromMountInfo(`${proc}\n41 40 0:35 / ${child} ro - tmpfs tmpfs ro`), {
      mode: "denied",
      reason: "parent-procfs-has-overmounts",
    });
  }
});

test("ordinary host procfs submounts preserve the existing private /proc contract", () => {
  const hostUidMap = "         0          0 4294967295\\n";
  for (const child of ["/proc/bus", "/proc/irq", "/proc/sys", "/proc/kcore"]) {
    const mountInfo = `${proc}\\n41 40 0:35 / ${child} ro - tmpfs tmpfs ro`;
    assert.deepEqual(procfsPolicyFromMountInfo(mountInfo, hostUidMap), {
      mode: "private",
      reason: null,
    });
  }
});

test("rootless OCI procfs overmounts remain denied instead of exposing parent processes", () => {
  const rootlessUidMap = "         0       1000          1\\n         1     100000      65536\\n";
  const masked = `${proc}\\n41 40 0:35 / /proc/sys ro - tmpfs tmpfs ro`;
  assert.deepEqual(procfsPolicyFromMountInfo(masked, rootlessUidMap), {
    mode: "denied",
    reason: "parent-procfs-has-overmounts",
  });
  assert.deepEqual(procfsPolicyFromMountInfo(masked, ""), {
    mode: "denied",
    reason: "parent-procfs-has-overmounts",
  });
});

test("unobservable proc never authorizes a private procfs", () => {
  for (const input of ["", "malformed", "40 37 0:34 / /proc rw - tmpfs tmpfs rw"]) {
    assert.deepEqual(procfsPolicyFromMountInfo(input), { mode: "denied", reason: "parent-procfs-unobservable" });
  }
});

test("unrelated and prefix-similar mounts do not change proc policy", () => {
  assert.deepEqual(procfsPolicyFromMountInfo(`${proc}\n41 37 0:35 / /proc-other/sys ro - tmpfs tmpfs ro`), {
    mode: "private",
    reason: null,
  });
});
