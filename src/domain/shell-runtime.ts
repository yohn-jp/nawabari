import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS } from "./fhs-development-runtime.js";
import type { ResolvedRuntimeProfile } from "./runtime-profile.js";
import type { ProjectedExecutableEntrypoint, SessionRuntimeProjection } from "./runtime-projection.js";

/** The only logical requirement accepted as the protected Bash entrypoint. */
export const BASH_REQUIREMENT = Object.freeze({
  id: "bash-runtime",
  kind: "runtime",
  name: "bash",
  version: ">=5",
} as const);

export const BASH_STARTUP_ARGS = Object.freeze(["--noprofile", "--norc"] as const);

export type ResolvedShellRuntime = Readonly<{
  readonly executable: string;
  readonly entrypoint: ProjectedExecutableEntrypoint;
  readonly args: readonly string[];
  readonly environment: Readonly<{ readonly HOME: string; readonly PATH: "/nawabari/bin" }>;
}>;

function missing(reason: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_MATERIALIZATION_MISSING", `Bash runtime is unavailable: ${reason}.`, {
      requirement_id: BASH_REQUIREMENT.id,
    }),
  );
}

/** Resolve an explicitly selected Bash requirement from the existing projection. */
export function resolveProfileShell(
  profile: ResolvedRuntimeProfile,
  materialized: Pick<SessionRuntimeProjection, "executables">,
): DomainResult<ResolvedShellRuntime> {
  const selected = profile.requirements.find((requirement) => requirement.id === BASH_REQUIREMENT.id);
  if (selected === undefined) return missing("the profile did not select Bash");
  if (
    selected.kind !== BASH_REQUIREMENT.kind ||
    selected.name !== BASH_REQUIREMENT.name ||
    selected.version !== BASH_REQUIREMENT.version
  ) {
    return missing("the Bash requirement is inconsistent");
  }
  const entrypoint = materialized.executables.find(
    (candidate) =>
      candidate.name === BASH_REQUIREMENT.name &&
      candidate.provider.id === FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS[BASH_REQUIREMENT.id] &&
      candidate.provider.requirement_id === BASH_REQUIREMENT.id,
  );
  if (entrypoint === undefined) return missing("selected Bash material was not projected");
  return success(
    Object.freeze({
      executable: entrypoint.target,
      entrypoint,
      args: BASH_STARTUP_ARGS,
      environment: Object.freeze({ HOME: "/nawabari/home", PATH: "/nawabari/bin" as const }),
    }),
  );
}
