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
