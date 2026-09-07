/**
 * Transport-neutral Nawabari Product State Manifest projection.
 *
 * The manifest is an output of the existing public state and machine-contract
 * projections. It is not a lifecycle authority: it does not create a machine,
 * accept an event, observe a repository, or execute a command. In particular,
 * internal XState event names, state-node ids, context, and snapshots are not
 * part of this module's public shape.
 */

import { createRequire } from "node:module";

import {
  MACHINE_CONTRACT_ID,
  MACHINE_CONTRACT_SCHEMA_VERSION,
  NAWABARI_CONTRACT_API_SCHEMA_VERSION,
  nawabariMachineContract,
} from "./public-contract.js";
import {
  NAWABARI_LIFECYCLE_STATES,
  NAWABARI_STATE_API_SCHEMA_VERSION,
  NAWABARI_TRANSITION_TABLE,
} from "./public-state.js";
import type {
  NawabariCommand,
  NawabariLifecycleState,
  NawabariTransitionDecision,
  NawabariTransitionDecisionProjection,
} from "./public-state.js";
import { SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION } from "./session-lifecycle-classification.js";

const installedPackageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };

export const NAWABARI_PRODUCT_STATE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const NAWABARI_PRODUCT_STATE_MANIFEST_ID = "nawabari.product-state-manifest.v1" as const;
export const NAWABARI_PRODUCT_ID = "nawabari" as const;
export const NAWABARI_SESSION_ACTOR_ID = "nawabari.session" as const;
export const NAWABARI_SESSION_LIFECYCLE_SCHEMA_ID = "nawabari.session-lifecycle.v1" as const;
export const NAWABARI_SESSION_COMMAND_SCHEMA_ID = "nawabari.session-command.v1" as const;

export type NawabariManifestVersionedIdentity = {
  readonly id: string;
  readonly version: number;
};

type NawabariManifestReason = NawabariTransitionDecision["reason"];

export type NawabariManifestAuthoritySource = {
  readonly id: string;
  readonly kind: "executable" | "public-projection" | "contract-projection";
  readonly module: string;
};

export type NawabariManifestParticipant = {
  readonly product_id: string;
  readonly actor_id: string;
  readonly role: "producer" | "consumer";
  /** Null means the independent caller has not supplied a contract identity. */
  readonly contract: NawabariManifestVersionedIdentity | null;
};

export type NawabariManifestCorrelation = {
  readonly mode: "session-scoped" | "not-applicable";
  readonly field: "session_id" | null;
  readonly required: boolean;
  readonly authority: string;
};

export type NawabariManifestIdempotency = {
  readonly mode: "not-declared" | "not-applicable";
  readonly key: string | null;
  readonly required: boolean;
  readonly authority: string;
};

export type NawabariManifestUnconditionalTransition = {
  readonly source_state: NawabariLifecycleState;
  readonly command: NawabariCommand;
  readonly guarded: false;
  readonly allowed: boolean;
  readonly target: NawabariLifecycleState | null;
  readonly requires_explicit_intent: boolean;
  readonly authority: NawabariTransitionDecisionProjection["authority"];
  readonly reason: NawabariManifestReason;
};

export type NawabariManifestGuardedTransition = {
  readonly source_state: NawabariLifecycleState;
  readonly command: NawabariCommand;
  readonly guarded: true;
  readonly requires_explicit_intent: boolean;
  readonly authority: NawabariTransitionDecisionProjection["authority"];
  readonly when_guard_accepts: {
    readonly allowed: true;
    readonly target: NawabariLifecycleState;
    readonly reason: NawabariManifestReason;
  };
  readonly when_guard_rejects: {
    readonly allowed: false;
    readonly target: null;
    readonly reason: NawabariManifestReason;
  };
};

export type NawabariManifestTransition = NawabariManifestUnconditionalTransition | NawabariManifestGuardedTransition;

export type NawabariManifestAcceptedCommand = {
  readonly id: NawabariCommand;
  /** Public-state vocabulary; deliberately not a raw XState event name. */
  readonly public_name: NawabariCommand;
  readonly kind: "command";
  readonly schema: NawabariManifestVersionedIdentity;
  readonly producers: readonly NawabariManifestParticipant[];
  readonly consumers: readonly NawabariManifestParticipant[];
  readonly correlation: NawabariManifestCorrelation;
  readonly idempotency: NawabariManifestIdempotency;
};

export type NawabariManifestEmittedEvent = {
  readonly id: string;
  readonly schema: NawabariManifestVersionedIdentity;
  readonly producers: readonly NawabariManifestParticipant[];
  readonly consumers: readonly NawabariManifestParticipant[];
  readonly correlation: NawabariManifestCorrelation;
  readonly idempotency: NawabariManifestIdempotency;
};

export type NawabariManifestEmittedEvents = {
  /** No emitted cross-product event is currently exposed by Nawabari. */
  readonly status: "not-exposed";
  readonly schema: NawabariManifestVersionedIdentity | null;
  readonly events: readonly NawabariManifestEmittedEvent[];
  readonly producers: readonly NawabariManifestParticipant[];
  readonly consumers: readonly NawabariManifestParticipant[];
};

export type NawabariManifestActor = {
  readonly id: typeof NAWABARI_SESSION_ACTOR_ID;
  readonly product_id: typeof NAWABARI_PRODUCT_ID;
  readonly kind: "session";
  readonly state: {
    readonly schema: NawabariManifestVersionedIdentity;
    readonly states: readonly NawabariLifecycleState[];
    readonly transitions: readonly NawabariManifestTransition[];
    readonly authority: "public-state-projection";
  };
  readonly accepted_commands: readonly NawabariManifestAcceptedCommand[];
  readonly emitted_events: NawabariManifestEmittedEvents;
};

export interface NawabariProductStateManifest {
  readonly manifest_id: typeof NAWABARI_PRODUCT_STATE_MANIFEST_ID;
  readonly schema_version: typeof NAWABARI_PRODUCT_STATE_MANIFEST_SCHEMA_VERSION;
  readonly product: {
    readonly id: typeof NAWABARI_PRODUCT_ID;
    readonly name: "Nawabari";
    readonly package_name: "nawabari";
    readonly package_version: string;
  };
  readonly public_contract: {
    readonly contract_id: typeof MACHINE_CONTRACT_ID;
    readonly schema_version: typeof MACHINE_CONTRACT_SCHEMA_VERSION;
    readonly api_schema_version: typeof NAWABARI_CONTRACT_API_SCHEMA_VERSION;
  };
  readonly authority: {
    readonly model: "projection";
    readonly source_of_truth: readonly NawabariManifestAuthoritySource[];
    readonly output_role: "generated-artifact";
  };
  readonly composition: {
    readonly participant_schema: NawabariManifestVersionedIdentity;
    readonly connection_model: "independent-product-actors";
    readonly transport: "adapter-owned";
  };
  readonly actors: readonly NawabariManifestActor[];
}

type JsonRecord = Record<string, unknown>;

const SOURCE_OF_TRUTH = Object.freeze([
  Object.freeze({
    id: "session-lifecycle-machine",
    kind: "executable",
    module: "src/state/session/machine.ts",
  }),
  Object.freeze({
    id: "public-state-lifecycle-projection",
    kind: "public-projection",
    module: "src/public-state.ts",
  }),
  Object.freeze({
    id: "machine-contract-projection",
    kind: "contract-projection",
    module: "src/contract.ts",
  }),
  Object.freeze({
    id: "public-contract-package-boundary",
    kind: "public-projection",
    module: "src/public-contract.ts",
  }),
] as const);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lifecycleCapability(contract: JsonRecord): JsonRecord {
  if (!Array.isArray(contract.capabilities)) {
    throw new Error("Nawabari machine contract has no capability inventory");
  }
  const capability = contract.capabilities.find(
    (candidate) => isRecord(candidate) && candidate.id === "session-diagnostics",
  );
  if (!isRecord(capability) || !isRecord(capability.lifecycle)) {
    throw new Error("Nawabari machine contract has no session lifecycle projection");
  }
  return capability.lifecycle;
}

function assertContractProjectionParity(contract: JsonRecord): void {
  const lifecycle = lifecycleCapability(contract);
  const publicStates = [...NAWABARI_LIFECYCLE_STATES];
  const publicTransitions = NAWABARI_TRANSITION_TABLE;
  if (JSON.stringify(lifecycle.states) !== JSON.stringify(publicStates)) {
    throw new Error("Nawabari Product State Manifest source projections disagree on lifecycle states");
  }
  if (JSON.stringify(lifecycle.transition_table) !== JSON.stringify(publicTransitions)) {
    throw new Error("Nawabari Product State Manifest source projections disagree on lifecycle transitions");
  }
}

function projectTransition(
  sourceState: NawabariLifecycleState,
  transition: NawabariTransitionDecisionProjection,
): NawabariManifestTransition {
  if (transition.guarded) {
    return Object.freeze({
      source_state: sourceState,
      command: transition.operation,
      guarded: true,
      requires_explicit_intent: transition.requiresExplicitIntent,
      authority: transition.authority,
      when_guard_accepts: Object.freeze({
        allowed: true,
        target: transition.whenGuardAccepts.target,
        reason: transition.whenGuardAccepts.reason,
      }),
      when_guard_rejects: Object.freeze({
        allowed: false,
        target: null,
        reason: transition.whenGuardRejects.reason,
      }),
    });
  }
  return Object.freeze({
    source_state: sourceState,
    command: transition.operation,
    guarded: false,
    allowed: transition.allowed,
    target: transition.target,
    requires_explicit_intent: transition.requiresExplicitIntent,
    authority: transition.authority,
    reason: transition.reason,
  });
}

function projectTransitions(): readonly NawabariManifestTransition[] {
  return Object.freeze(
    NAWABARI_LIFECYCLE_STATES.flatMap((state) =>
      NAWABARI_TRANSITION_TABLE[state].map((transition) => projectTransition(state, transition)),
    ),
  );
}

function uniqueCommands(transitions: readonly NawabariManifestTransition[]): readonly NawabariCommand[] {
  const commands: NawabariCommand[] = [];
  for (const transition of transitions) {
    if (!commands.includes(transition.command)) commands.push(transition.command);
  }
  return Object.freeze(commands);
}

function participant(
  productId: string,
  actorId: string,
  role: NawabariManifestParticipant["role"],
  contract: NawabariManifestVersionedIdentity | null,
): NawabariManifestParticipant {
  return Object.freeze({
    product_id: productId,
    actor_id: actorId,
    role,
    contract: contract === null ? null : Object.freeze({ ...contract }),
  });
}

function acceptedCommand(command: NawabariCommand): NawabariManifestAcceptedCommand {
  return Object.freeze({
    id: command,
    public_name: command,
    kind: "command",
    schema: Object.freeze({ id: NAWABARI_SESSION_COMMAND_SCHEMA_ID, version: NAWABARI_STATE_API_SCHEMA_VERSION }),
    producers: Object.freeze([participant("external", "caller", "producer", null)]),
    consumers: Object.freeze([
      participant("nawabari", NAWABARI_SESSION_ACTOR_ID, "consumer", {
        id: MACHINE_CONTRACT_ID,
        version: MACHINE_CONTRACT_SCHEMA_VERSION,
      }),
    ]),
    correlation: Object.freeze({
      mode: "session-scoped",
      field: "session_id",
      required: false,
      authority: "public-state observation boundary",
    }),
    idempotency: Object.freeze({
      mode: "not-declared",
      key: null,
      required: false,
      authority: "existing command/runtime contract",
    }),
  });
}

function emittedEvents(): NawabariManifestEmittedEvents {
  return Object.freeze({
    status: "not-exposed",
    schema: null,
    events: Object.freeze([] as const),
    producers: Object.freeze([] as const),
    consumers: Object.freeze([] as const),
  });
}

/** Generate the deterministic public manifest for the installed package version. */
export function generateNawabariProductStateManifest(
  packageVersion: string = installedPackageMetadata.version,
): NawabariProductStateManifest {
  const contract = nawabariMachineContract(packageVersion);
  assertContractProjectionParity(contract);

  const transitions = projectTransitions();
  const commands = uniqueCommands(transitions);
  const actor: NawabariManifestActor = Object.freeze({
    id: NAWABARI_SESSION_ACTOR_ID,
    product_id: NAWABARI_PRODUCT_ID,
    kind: "session" as const,
    state: Object.freeze({
      schema: Object.freeze({
        id: NAWABARI_SESSION_LIFECYCLE_SCHEMA_ID,
        version: SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION,
      }),
      states: Object.freeze([...NAWABARI_LIFECYCLE_STATES]),
      transitions,
      authority: "public-state-projection" as const,
    }),
    accepted_commands: Object.freeze(commands.map(acceptedCommand)),
    emitted_events: emittedEvents(),
  });

  return Object.freeze({
    manifest_id: NAWABARI_PRODUCT_STATE_MANIFEST_ID,
    schema_version: NAWABARI_PRODUCT_STATE_MANIFEST_SCHEMA_VERSION,
    product: Object.freeze({
      id: NAWABARI_PRODUCT_ID,
      name: "Nawabari",
      package_name: "nawabari",
      package_version: packageVersion,
    }),
    public_contract: Object.freeze({
      contract_id: MACHINE_CONTRACT_ID,
      schema_version: MACHINE_CONTRACT_SCHEMA_VERSION,
      api_schema_version: NAWABARI_CONTRACT_API_SCHEMA_VERSION,
    }),
    authority: Object.freeze({
      model: "projection",
      source_of_truth: SOURCE_OF_TRUTH,
      output_role: "generated-artifact",
    }),
    composition: Object.freeze({
      participant_schema: Object.freeze({ id: "nawabari.product-participant.v1", version: 1 }),
      connection_model: "independent-product-actors",
      transport: "adapter-owned",
    }),
    actors: Object.freeze([actor]),
  });
}

/** Naming parallel to `nawabariMachineContract`; both return the same projection. */
export const nawabariProductStateManifest = generateNawabariProductStateManifest;

/** Stable byte representation for checked-in/generated artifacts. */
export function serializeNawabariProductStateManifest(
  manifest: NawabariProductStateManifest = generateNawabariProductStateManifest(),
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function diagramStateId(state: NawabariLifecycleState): string {
  return state.replace(/[^A-Za-z0-9_]/gu, "_");
}

function diagramTransitionLines(transition: NawabariManifestTransition): string[] {
  const source = diagramStateId(transition.source_state);
  if (transition.guarded) {
    return [
      `  ${source} --> ${diagramStateId(transition.when_guard_accepts.target)} : ${transition.command} [guard accepts]`,
      `  %% ${transition.source_state} -- ${transition.command} [guard rejects] --> no public transition (${transition.when_guard_rejects.reason})`,
    ];
  }
  if (!transition.allowed || transition.target === null) {
    return [`  %% ${transition.source_state} -- ${transition.command} --> no public transition (${transition.reason})`];
  }
  return [`  ${source} --> ${diagramStateId(transition.target)} : ${transition.command}`];
}

/**
 * Render a deterministic Mermaid state diagram from manifest data. The
 * manifest is the input boundary; this renderer contains no lifecycle graph.
 */
export function renderNawabariSessionLifecycleDiagram(
  manifest: NawabariProductStateManifest = generateNawabariProductStateManifest(),
): string {
  const actor = manifest.actors.find((candidate) => candidate.id === NAWABARI_SESSION_ACTOR_ID);
  if (actor === undefined) throw new Error(`Manifest is missing actor ${NAWABARI_SESSION_ACTOR_ID}`);

  const lines = ["%% Generated from Nawabari Product State Manifest; do not edit.", "stateDiagram-v2"];
  for (const state of actor.state.states) {
    lines.push(`  state "${state}" as ${diagramStateId(state)}`);
  }
  for (const transition of actor.state.transitions) lines.push(...diagramTransitionLines(transition));
  return `${lines.join("\n")}\n`;
}
