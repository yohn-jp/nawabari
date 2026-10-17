import { readFileSync } from "node:fs";

export type SandboxProcfsPolicy = Readonly<{
  mode: "private" | "denied";
  reason: string | null;
}>;

/** Decode the mountinfo path escapes, without interpreting arbitrary escapes. */
function mountPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * A fresh procfs can be refused by Linux's mount-too-revealing check when the
 * parent procfs has masked children. Never unmask it or bind the parent's proc
 * into the payload: that would expose processes outside the private PID scope.
 * Instead select an empty read-only directory before launch. This is a narrower
 * view, not a retry after a selected runtime fails.
 */
export function procfsPolicyFromMountInfo(mountInfo: string, uidMap?: string): SandboxProcfsPolicy {
  const records = mountInfo
    .trim()
    .split("\n")
    .map((line) => line.split(" "));
  const procRoot = records.find((fields) => {
    const separator = fields.indexOf("-");
    return (
      fields.length >= 10 && separator >= 6 && mountPath(fields[4]) === "/proc" && fields[separator + 1] === "proc"
    );
  });
  if (procRoot === undefined) return { mode: "denied", reason: "parent-procfs-unobservable" };
  if (records.some((fields) => fields.length >= 10 && mountPath(fields[4]).startsWith("/proc/"))) {
    // Procfs submounts are also present on ordinary Linux hosts. In that
    // topology a fresh private procfs remains supported; denying it breaks
    // the existing Node/Git and /proc security contract. A rootless OCI user
    // namespace does not have the full initial-userns UID mapping and keeps
    // the narrower denied view when the parent procfs has overmounts.
    if (uidMap !== undefined && /^\s*0\s+0\s+4294967295\s*$/u.test(uidMap)) {
      return { mode: "private", reason: null };
    }
    return { mode: "denied", reason: "parent-procfs-has-overmounts" };
  }
  return { mode: "private", reason: null };
}

export function observeSandboxProcfsPolicy(): SandboxProcfsPolicy {
  try {
    return procfsPolicyFromMountInfo(
      readFileSync("/proc/self/mountinfo", "utf8"),
      readFileSync("/proc/self/uid_map", "utf8"),
    );
  } catch {
    return { mode: "denied", reason: "parent-procfs-unobservable" };
  }
}
