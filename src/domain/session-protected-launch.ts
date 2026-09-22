/**
 * Canonical protected-launch composition for the session console.  The
 * launcher and sandbox request resolver remain the sole implementation
 * authorities; this module only exposes the integration seam.
 */
export {
  resolveSandboxExecutionRequest,
  type SandboxExecutionRequest,
  type SandboxProbe,
  type SandboxRuntimeLayout,
} from "./sandbox.js";
export {
  runInteractiveSandboxedCommand,
  type SandboxLauncherOptions,
} from "./sandbox-launcher.js";
export {
  enterSessionConsole,
  listSessionProcesses,
  type SessionConsoleEnterOptions,
  type SessionConsoleProcessesOptions,
  type SessionConsoleRunner,
} from "./session-console.js";
