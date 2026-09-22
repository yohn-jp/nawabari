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

import { enterSessionConsole, type SessionConsoleEnterOptions } from "./session-console.js";
import type { SessionBackend, SessionContext } from "./session.js";

/** Protected launch composition consumed by the session-enter integration. */
export async function enterProtectedSession(
  context: SessionContext,
  backend: SessionBackend,
  options: SessionConsoleEnterOptions,
) {
  if (backend.persistSessionExecution === undefined) {
    throw new Error("Protected session launch requires durable execution persistence");
  }
  return enterSessionConsole(context, backend, {
    ...options,
    persist_execution: options.persist_execution ?? (async (record) => {
      const result = await backend.persistSessionExecution!(context, record);
      if (!result.ok) throw result.error;
    }),
  });
}
