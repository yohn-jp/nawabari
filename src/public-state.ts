/**
 * Stable, transport-neutral package boundary for Nawabari state/contract
 * integration (#257; see docs/architecture/xstate-state-architecture.md,
 * "Public library boundary").
 *
 * This module is the supported way for a cross-product caller (a future
 * Mottainai/Inari adapter, or any other Node consumer) to obtain a public
 * lifecycle observation/snapshot and transition-decision data without
 * spawning the CLI and parsing its output, and without reaching into XState
 * machine/actor internals. Every exported type and function here is a
 * projection of the existing Core/#256 lifecycle authority
 * (`session-lifecycle-classification.ts` and `SessionRegistry`); this module
 * introduces no independent state or transition authority.
 *
 * Raw XState machine definitions, actor refs, internal state-node ids, and
 * private machine context are never exported here. Mutating a session
 * (close/discard/claim/commit/push/...) still requires the existing
 * `SessionRegistry` Git/filesystem/registry authority; nothing in this
 * module lets a caller manufacture or bypass that authorization by
 * constructing an observation or transition decision by hand.
 */

import { SessionRegistry } from "./session-registry.js";
import {
  availableLifecycleOperations,
  classifySessionLifecycle,
  lifecycleTransition,
  SESSION_LIFECYCLE_STATES,
  SESSION_LIFECYCLE_TRANSITION_TABLE,
} from "./session-lifecycle-classification.js";
import type {
  SessionLifecycleBlocker,
  SessionLifecycleClassification,
  SessionLifecycleCloseReadiness,
  SessionLifecycleGuardedTransition,
  SessionLifecycleObservation,
  SessionLifecycleOperation,
  SessionLifecyclePhase,
  SessionLifecycleState,
  SessionLifecycleTransition,
  SessionLifecycleTransitionProjection,
  SessionLifecycleUnconditionalTransition,
} from "./session-lifecycle-classification.js";

/** Schema generation for this public state-API module itself. */
export const NAWABARI_STATE_API_SCHEMA_VERSION = 1 as const;

/** Public lifecycle command/event vocabulary. Never a raw XState event type. */
export type NawabariCommand = SessionLifecycleOperation;

/** Caller-supplied observation input. Structural, not tied to a live session. */
export type NawabariObservation = SessionLifecycleObservation;
export type NawabariObservationBlocker = SessionLifecycleBlocker;
export type NawabariObservationPhase = SessionLifecyclePhase;
export type NawabariCloseReadiness = SessionLifecycleCloseReadiness;

/** Public lifecycle state name. Never an internal XState state-node id. */
export type NawabariLifecycleState = SessionLifecycleState;
export const NAWABARI_LIFECYCLE_STATES: readonly NawabariLifecycleState[] = SESSION_LIFECYCLE_STATES;

/**
 * Public projection of one classified session: its lifecycle state plus
 * every per-command transition decision. This is a public projection, not a
 * raw XState snapshot.
 */
export type NawabariStateSnapshot = SessionLifecycleClassification;

/** One command's transition decision: whether/where it would move the state, and why. */
export type NawabariTransitionDecision = SessionLifecycleTransition;
export type NawabariUnconditionalTransitionDecision = SessionLifecycleUnconditionalTransition;
export type NawabariGuardedTransitionDecision = SessionLifecycleGuardedTransition;
export type NawabariTransitionDecisionProjection = SessionLifecycleTransitionProjection;

/** The complete static state/command transition-decision table, for discovery. */
export const NAWABARI_TRANSITION_TABLE: Readonly<
  Record<NawabariLifecycleState, readonly NawabariTransitionDecisionProjection[]>
> = SESSION_LIFECYCLE_TRANSITION_TABLE;

/**
 * Classify an already-observed session into its public state snapshot and
 * per-command transition decisions. Pure and transport-neutral: it performs
 * no Git/filesystem/registry observation of its own.
 */
export function classifyNawabariState(observation: NawabariObservation): NawabariStateSnapshot {
  return classifySessionLifecycle(observation);
}

/** Return one command's transition decision from an already-classified snapshot. */
export function nawabariTransitionDecision(
  snapshot: NawabariStateSnapshot,
  command: NawabariCommand,
): NawabariTransitionDecision {
  return lifecycleTransition(snapshot, command);
}

/** Commands the canonical machine currently admits for an already-classified snapshot. */
export function availableNawabariCommands(snapshot: NawabariStateSnapshot): readonly NawabariCommand[] {
  return availableLifecycleOperations(snapshot);
}

export interface NawabariSessionSnapshotOptions {
  /** Repository/worktree to resolve the session registry from. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Defaults to the session owning `cwd` when omitted. */
  readonly sessionId?: string;
  /** Caller-supplied integration revision, independently re-verified before it affects close readiness. */
  readonly integratedRevision?: string;
  /** `current` reports ownership as it exists; `termination` projects close readiness. Defaults to `current`. */
  readonly phase?: NawabariObservationPhase;
}

/**
 * Observe one real, already-provisioned Nawabari session and return its
 * public state snapshot. This reuses the existing `SessionRegistry`
 * Git/filesystem/session-registry authority — the same authority `session
 * inspect` uses — without spawning or parsing CLI output. It never mutates a
 * session, claim, branch, or worktree.
 */
export function getNawabariSessionStateSnapshot(options: NawabariSessionSnapshotOptions = {}): NawabariStateSnapshot {
  const registry = new SessionRegistry(options.cwd === undefined ? undefined : { cwd: options.cwd });
  return registry.classifyLifecycle({
    sessionId: options.sessionId ?? null,
    integratedRevision: options.integratedRevision ?? null,
    phase: options.phase,
  });
}
