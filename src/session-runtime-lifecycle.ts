import {
  beginExecutionDrain,
  finalizeExecutionDrain,
  observeDrainCompletion,
  type RuntimeEpoch,
  type SessionDrainExecution,
  type SessionDrainFence,
  type SessionDrainFinalization,
  type SessionDrainIntent,
  type SessionDrainNextAction,
  type SessionDrainObservation,
  type SessionDrainOperation,
  type SessionDrainPolicy,
} from "./domain/session-execution-control.js";
import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";

/** One authoritative snapshot supplied by the registry/process adapters. */
export type SessionRuntimeLifecycleSnapshot = Readonly<{
  readonly session_id: string;
  readonly runtime_epoch: RuntimeEpoch;
  readonly executions: readonly SessionDrainExecution[];
  readonly kernel_empty: boolean;
}>;

export type SessionRuntimeLifecycleMutation = Readonly<{
  readonly operation: SessionDrainOperation;
  readonly session_id: string;
  readonly fence: SessionDrainFinalization;
}>;

export type SessionRuntimeLifecycleAdapter<T> = Readonly<{
  /** Read authoritative state without retaining the registry lock. */
  readonly observe: (sessionId: string) => SessionRuntimeLifecycleSnapshot | Promise<SessionRuntimeLifecycleSnapshot>;
  /** Canonical SessionRegistry.close/discard/releaseClaims mutation. */
  readonly mutate: (mutation: SessionRuntimeLifecycleMutation) => T | Promise<T>;
  /** Explicit owned-process termination, if the caller selected terminate. */
  readonly terminate?: (
    sessionId: string,
    fence: SessionDrainFence,
  ) => SessionDrainObservation | Promise<SessionDrainObservation>;
}>;

export type SessionRuntimeLifecycleResult<T> = Readonly<{
  readonly status: "completed" | "waiting" | "blocked";
  readonly session_id: string;
  readonly operation: SessionDrainOperation;
  readonly value?: T;
  readonly fence: SessionDrainFence;
  readonly next_action: SessionDrainNextAction;
  readonly active_execution_ids: readonly string[];
  readonly unknown_execution_ids: readonly string[];
}>;

export type SessionRuntimeLifecycleOptions = Readonly<{
  readonly expected_epoch: RuntimeEpoch;
  readonly operation: SessionDrainOperation;
  readonly policy: SessionDrainPolicy;
  readonly idempotency_key?: string;
}>;

function rejected(message: string, details: Record<string, string | number | string[]> = {}): DomainResult<never> {
  return failure(new DomainError("OPERATION_REJECTED", message, details));
}

function snapshotToObservation(snapshot: SessionRuntimeLifecycleSnapshot): SessionDrainObservation {
  return {
    observed_epoch: snapshot.runtime_epoch,
    executions: snapshot.executions,
    kernel_empty: snapshot.kernel_empty,
  };
}

function validateSnapshot(
  snapshot: SessionRuntimeLifecycleSnapshot,
  sessionId: string,
): DomainResult<SessionRuntimeLifecycleSnapshot> {
  if (snapshot.session_id !== sessionId) {
    return rejected("The runtime snapshot belongs to a different session.", {
      session_id: sessionId,
      observed_session_id: snapshot.session_id,
    });
  }
  return success(snapshot);
}

async function runMutation<T>(
  adapter: SessionRuntimeLifecycleAdapter<T>,
  sessionId: string,
  options: SessionRuntimeLifecycleOptions,
): Promise<DomainResult<SessionRuntimeLifecycleResult<T>>> {
  const initial = await adapter.observe(sessionId);
  const checkedInitial = validateSnapshot(initial, sessionId);
  if (!checkedInitial.ok) return checkedInitial;
  const firstFence = beginExecutionDrain(sessionId, options.expected_epoch, {
    operation: options.operation,
    policy: options.policy,
    observed_epoch: checkedInitial.value.runtime_epoch,
    executions: checkedInitial.value.executions,
    kernel_empty: checkedInitial.value.kernel_empty,
    ...(options.idempotency_key === undefined ? {} : { idempotency_key: options.idempotency_key }),
  } satisfies SessionDrainIntent);
  if (!firstFence.ok) return firstFence;

  let completion = observeDrainCompletion(firstFence.value, snapshotToObservation(checkedInitial.value));
  if (!completion.ok) return completion;
  let fence = completion.value.fence;

  if (!completion.value.safe_to_finalize && options.policy === "terminate" && adapter.terminate !== undefined) {
    // The terminate callback is an explicit operation owned by the caller;
    // this boundary never discovers or signals a PID itself.
    const termination = await adapter.terminate(sessionId, fence);
    completion = observeDrainCompletion(fence, termination);
    if (!completion.ok) return completion;
    fence = completion.value.fence;
  }

  if (!completion.value.safe_to_finalize) {
    return success({
      status: completion.value.unknown_execution_ids.length > 0 ? "blocked" : "waiting",
      session_id: sessionId,
      operation: options.operation,
      fence,
      next_action: completion.value.next_action,
      active_execution_ids: completion.value.active_execution_ids,
      unknown_execution_ids: completion.value.unknown_execution_ids,
    });
  }

  // Re-observe immediately before calling the canonical mutation. This keeps
  // waiting outside the registry lock and prevents a stale fence from
  // releasing claims or removing a worktree.
  const beforeMutation = await adapter.observe(sessionId);
  const checkedBeforeMutation = validateSnapshot(beforeMutation, sessionId);
  if (!checkedBeforeMutation.ok) return checkedBeforeMutation;
  const finalObservation = observeDrainCompletion(fence, snapshotToObservation(checkedBeforeMutation.value));
  if (!finalObservation.ok) return finalObservation;
  fence = finalObservation.value.fence;
  const finalization = finalizeExecutionDrain(fence);
  if (!finalization.ok) return finalization;
  const value = await adapter.mutate({
    operation: options.operation,
    session_id: sessionId,
    fence: finalization.value,
  });
  return success({
    status: "completed",
    session_id: sessionId,
    operation: options.operation,
    value,
    fence,
    next_action: "finalize-lifecycle",
    active_execution_ids: [],
    unknown_execution_ids: [],
  });
}

/** Run one lifecycle mutation with admission closed during the drain. */
export async function runSessionRuntimeLifecycle<T>(
  adapter: SessionRuntimeLifecycleAdapter<T>,
  sessionId: string,
  options: SessionRuntimeLifecycleOptions,
): Promise<DomainResult<SessionRuntimeLifecycleResult<T>>> {
  try {
    return await runMutation(adapter, sessionId, options);
  } catch (error: unknown) {
    return failure(
      new DomainError("OPERATION_REJECTED", "The runtime lifecycle mutation could not complete safely.", {
        operation: options.operation,
        session_id: sessionId,
        reason: error instanceof Error ? error.message.slice(0, 240) : "unknown",
      }),
    );
  }
}

export function closeSessionWithRuntimeDrain<T>(
  adapter: SessionRuntimeLifecycleAdapter<T>,
  sessionId: string,
  expectedEpoch: RuntimeEpoch,
  policy: SessionDrainPolicy = "wait",
): Promise<DomainResult<SessionRuntimeLifecycleResult<T>>> {
  return runSessionRuntimeLifecycle(adapter, sessionId, {
    operation: "close",
    expected_epoch: expectedEpoch,
    policy,
  });
}

export function discardSessionWithRuntimeDrain<T>(
  adapter: SessionRuntimeLifecycleAdapter<T>,
  sessionId: string,
  expectedEpoch: RuntimeEpoch,
  policy: SessionDrainPolicy = "wait",
): Promise<DomainResult<SessionRuntimeLifecycleResult<T>>> {
  return runSessionRuntimeLifecycle(adapter, sessionId, {
    operation: "discard",
    expected_epoch: expectedEpoch,
    policy,
  });
}

export function releaseSessionClaimsWithRuntimeDrain<T>(
  adapter: SessionRuntimeLifecycleAdapter<T>,
  sessionId: string,
  expectedEpoch: RuntimeEpoch,
  policy: SessionDrainPolicy = "wait",
): Promise<DomainResult<SessionRuntimeLifecycleResult<T>>> {
  return runSessionRuntimeLifecycle(adapter, sessionId, {
    operation: "release-claims",
    expected_epoch: expectedEpoch,
    policy,
  });
}

/** Explicit class-shaped adapter for integration surfaces that prefer methods. */
export class SessionRuntimeLifecycle<T> {
  constructor(private readonly adapter: SessionRuntimeLifecycleAdapter<T>) {}

  close(sessionId: string, expectedEpoch: RuntimeEpoch, policy: SessionDrainPolicy = "wait") {
    return closeSessionWithRuntimeDrain(this.adapter, sessionId, expectedEpoch, policy);
  }

  discard(sessionId: string, expectedEpoch: RuntimeEpoch, policy: SessionDrainPolicy = "wait") {
    return discardSessionWithRuntimeDrain(this.adapter, sessionId, expectedEpoch, policy);
  }

  releaseClaims(sessionId: string, expectedEpoch: RuntimeEpoch, policy: SessionDrainPolicy = "wait") {
    return releaseSessionClaimsWithRuntimeDrain(this.adapter, sessionId, expectedEpoch, policy);
  }
}
