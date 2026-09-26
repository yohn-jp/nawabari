import { createHash } from "node:crypto";

import { claimsOverlap, type ResourceClaim } from "./resource-claims.js";

/** Version of the transport-neutral resource coordination read model. */
export const RESOURCE_COORDINATION_SCHEMA_VERSION = 1 as const;
export const RESOURCE_INTENT_SCHEMA_VERSION = 1 as const;
export const RESOURCE_COORDINATION_SERIALIZATION_KEY = "coordination" as const;

/** Intent is a declaration of planned work, not an access grant. */
export const RESOURCE_INTENT_MODES = ["READONLY", "WRITE", "CREATE", "DELETE"] as const;
export type ResourceIntentMode = (typeof RESOURCE_INTENT_MODES)[number];
export type ResourceIntentKind = ResourceIntentMode;
export type ResourceIntentOperation = ResourceIntentMode;

export const RESOURCE_SELECTOR_KINDS = ["exact", "glob", "namespace"] as const;
export type ResourceSelectorKind = (typeof RESOURCE_SELECTOR_KINDS)[number];

export interface ResourceSelector {
  readonly kind: ResourceSelectorKind;
  /** Canonical repository-relative spelling. A missing target is retained. */
  readonly resource: string;
}

export interface ResourceIntent {
  readonly schemaVersion: typeof RESOURCE_INTENT_SCHEMA_VERSION;
  readonly intentId: string;
  readonly sessionId: string;
  readonly repositoryId?: string;
  readonly claimId?: string;
  readonly mode: ResourceIntentMode;
  readonly selector: ResourceSelector;
}

/** Input accepts the vocabulary used by callers while emitting one canonical model. */
export interface ResourceIntentInput {
  readonly sessionId: string;
  readonly repositoryId?: string;
  readonly claimId?: string;
  readonly mode?: ResourceIntentMode;
  readonly operation?: ResourceIntentOperation;
  readonly kind?: ResourceIntentKind;
  readonly resource?: string;
  readonly selector?: ResourceSelector | string;
  readonly selectorKind?: ResourceSelectorKind;
  readonly namespace?: string;
}

export interface ResourceOverlapBounds {
  readonly maxSessions?: number;
  readonly maxPairs?: number;
  readonly maxSelectors?: number;
  /** Long-form names are accepted for transport callers. */
  readonly maxSessionCount?: number;
  readonly maxPairCount?: number;
  readonly maxSelectorCount?: number;
}

export interface ResourceOverlapNode {
  readonly nodeId: string;
  readonly sessionId: string;
  readonly repositoryId?: string;
  readonly claim?: ResourceClaim;
  readonly intents: readonly ResourceIntent[];
  readonly selectors: readonly ResourceSelector[];
}

export interface ResourceOverlapFacts {
  /** At least one pair has the same canonical resource spelling. */
  readonly exactResourceMatch: boolean;
  /** At least one pair intersects through a glob or namespace selector. */
  readonly selectorIntersection: boolean;
  /** At least one pair is a parent/child relationship. */
  readonly parentChildOverlap: boolean;
  /** Two CREATE plans select an overlapping resource. */
  readonly createCreateCollision: boolean;
  /** True whenever at least one of the preceding overlap facts is true. */
  readonly overlapping: boolean;
}

export const RESOURCE_OVERLAP_KINDS = [
  "exact-resource",
  "selector-intersection",
  "parent-child",
  "create-create",
  "multiple",
] as const;
export type ResourceOverlapKind = (typeof RESOURCE_OVERLAP_KINDS)[number];

export interface ResourceOverlapClassification extends ResourceOverlapFacts {
  readonly kind: ResourceOverlapKind;
  readonly kinds: readonly ResourceOverlapKind[];
}

export interface ResourceOverlapEdge {
  readonly schemaVersion: typeof RESOURCE_COORDINATION_SCHEMA_VERSION;
  /** Stable pair identity; tuple members are ordered by Unicode code point. */
  readonly pairKey: string;
  readonly edgeId: string;
  readonly left: ResourceOverlapNode;
  readonly right: ResourceOverlapNode;
  readonly facts: ResourceOverlapFacts;
  readonly classification: ResourceOverlapClassification;
}

export interface ResourceOverlapGraph {
  readonly schemaVersion: typeof RESOURCE_COORDINATION_SCHEMA_VERSION;
  readonly serializationKey: typeof RESOURCE_COORDINATION_SERIALIZATION_KEY;
  readonly edges: readonly ResourceOverlapEdge[];
  readonly complete: boolean;
  readonly clean: boolean;
  /** Candidates that could not be evaluated because maxPairs was reached. */
  readonly unevaluatedPairs: number;
  /** Selectors omitted because maxSelectors or maxSessions was reached. */
  readonly unevaluatedSelectors: number;
  /** Aggregate count of bounded input units that were not evaluated. */
  readonly unevaluatedCount: number;
  readonly omittedSessions: number;
  readonly bounds: Required<Pick<ResourceOverlapBounds, "maxSessions" | "maxPairs" | "maxSelectors">>;
}

export class ResourceCoordinationError extends Error {
  readonly code: "INVALID_INTENT" | "INVALID_SELECTOR" | "INVALID_BOUNDS";

  constructor(code: ResourceCoordinationError["code"], message: string) {
    super(message);
    this.name = "ResourceCoordinationError";
    this.code = code;
  }
}

const DEFAULT_BOUNDS = Object.freeze({ maxSessions: 128, maxPairs: 4096, maxSelectors: 4096 });
const WILDCARD = /[*?]/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_RELATIVE_PATH = /^[A-Za-z]:/u;
const UNSUPPORTED_SELECTOR_SYNTAX = /[\[\]{}()]/u;

/**
 * Create one immutable intent. This function only validates and canonicalizes
 * selector syntax; it never reads or changes a worktree and never creates a
 * ResourceClaim.
 */
export function createResourceIntent(input: ResourceIntentInput): ResourceIntent {
  if (!isRecord(input) || typeof input.sessionId !== "string" || input.sessionId.length === 0) {
    throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent sessionId must be non-empty");
  }
  const mode = readIntentMode(input);
  const selector = normalizeSelectorInput(input);
  const repositoryId = input.repositoryId;
  if (repositoryId !== undefined && (typeof repositoryId !== "string" || repositoryId.length === 0)) {
    throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent repositoryId must be non-empty");
  }
  if (input.claimId !== undefined && (typeof input.claimId !== "string" || input.claimId.length === 0)) {
    throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent claimId must be non-empty");
  }
  const intentId = canonicalResourceIntentId(input.sessionId, mode, selector, input.claimId);
  return Object.freeze({
    schemaVersion: RESOURCE_INTENT_SCHEMA_VERSION,
    intentId,
    sessionId: input.sessionId,
    ...(repositoryId === undefined ? {} : { repositoryId }),
    ...(input.claimId === undefined ? {} : { claimId: input.claimId }),
    mode,
    selector: Object.freeze(selector),
  });
}

/** Stable identity independent of input order or object property order. */
export function canonicalResourceIntentId(
  sessionId: string,
  mode: ResourceIntentMode,
  selector: ResourceSelector,
  claimId?: string,
): string;
export function canonicalResourceIntentId(
  input: Pick<ResourceIntent, "sessionId" | "mode" | "selector"> & { claimId?: string },
): string;
export function canonicalResourceIntentId(
  sessionOrInput: string | (Pick<ResourceIntent, "sessionId" | "mode" | "selector"> & { claimId?: string }),
  mode?: ResourceIntentMode,
  selector?: ResourceSelector,
  claimId?: string,
): string {
  const input =
    typeof sessionOrInput === "string"
      ? { sessionId: sessionOrInput, mode: mode as ResourceIntentMode, selector: selector as ResourceSelector, claimId }
      : sessionOrInput;
  if (!RESOURCE_INTENT_MODES.includes(input.mode)) {
    throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent mode is unsupported");
  }
  const normalized = normalizeSelector(input.selector);
  const digest = createHash("sha256")
    .update(input.sessionId)
    .update("\u0000")
    .update(input.mode)
    .update("\u0000")
    .update(normalized.kind)
    .update("\u0000")
    .update(normalized.resource)
    .update(input.claimId === undefined ? "" : `\u0000${input.claimId}`)
    .digest("hex");
  return `intent-${digest}`;
}

/** Short alias used by transport adapters. */
export const canonicalIntentId = canonicalResourceIntentId;

/** Determine whether two canonical selectors can name at least one path. */
export function resourceSelectorsOverlap(left: ResourceSelector, right: ResourceSelector): boolean {
  const a = normalizeSelector(left);
  const b = normalizeSelector(right);
  if (a.kind === "namespace" || b.kind === "namespace") {
    return namespaceSelectorOverlap(a, b);
  }
  if (a.kind === "exact" && b.kind === "exact") return a.resource === b.resource;
  return globPatternsOverlap(a.resource, b.resource);
}

/** Build a bounded, deterministic graph without mutating claims, intents, or worktrees. */
export function buildResourceOverlapGraph(
  claims: readonly ResourceClaim[],
  intents: readonly ResourceIntent[],
  bounds: ResourceOverlapBounds = {},
): ResourceOverlapGraph {
  const normalizedBounds = normalizeBounds(bounds);
  const nodes = buildNodes(claims, intents);
  const sessionIds = [...new Set(nodes.map((node) => node.sessionId))].sort(compareCodePointStrings);
  const selectedSessions = new Set(sessionIds.slice(0, normalizedBounds.maxSessions));
  const omittedSessions = Math.max(0, sessionIds.length - selectedSessions.size);
  const sessionNodes = nodes.filter((node) => selectedSessions.has(node.sessionId));
  const sessionOmittedSelectors = nodes
    .filter((node) => !selectedSessions.has(node.sessionId))
    .reduce((count, node) => count + node.selectors.length, 0);
  const selectorLimited = limitSelectors(sessionNodes, normalizedBounds.maxSelectors);
  const selectedNodes = selectorLimited.nodes;
  const candidates: Array<[ResourceOverlapNode, ResourceOverlapNode]> = [];
  for (let leftIndex = 0; leftIndex < selectedNodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < selectedNodes.length; rightIndex += 1) {
      const left = selectedNodes[leftIndex] as ResourceOverlapNode;
      const right = selectedNodes[rightIndex] as ResourceOverlapNode;
      if (left.sessionId === right.sessionId) continue;
      if (
        left.repositoryId !== undefined &&
        right.repositoryId !== undefined &&
        left.repositoryId !== right.repositoryId
      )
        continue;
      candidates.push([left, right]);
    }
  }

  const edges: ResourceOverlapEdge[] = [];
  const evaluated = Math.min(candidates.length, normalizedBounds.maxPairs);
  for (let index = 0; index < evaluated; index += 1) {
    const pair = candidates[index] as [ResourceOverlapNode, ResourceOverlapNode];
    const [left, right] = orderNodes(pair[0], pair[1]);
    const facts = overlapFacts(left, right);
    if (!facts.overlapping) continue;
    const pairKey = makePairKey(left, right);
    const classification = classifyFacts(facts);
    edges.push({
      schemaVersion: RESOURCE_COORDINATION_SCHEMA_VERSION,
      pairKey,
      edgeId: `overlap-${sha256(pairKey)}`,
      left,
      right,
      facts,
      classification,
    });
  }
  edges.sort((left, right) => compareCodePointStrings(left.pairKey, right.pairKey));
  const unevaluatedPairs = Math.max(0, candidates.length - evaluated);
  const unevaluatedSelectors = selectorLimited.omitted + sessionOmittedSelectors;
  const complete = unevaluatedPairs === 0 && unevaluatedSelectors === 0;
  return Object.freeze({
    schemaVersion: RESOURCE_COORDINATION_SCHEMA_VERSION,
    serializationKey: RESOURCE_COORDINATION_SERIALIZATION_KEY,
    edges: Object.freeze(edges),
    complete,
    clean: complete && edges.length === 0,
    unevaluatedPairs,
    unevaluatedSelectors,
    unevaluatedCount: unevaluatedPairs + unevaluatedSelectors,
    omittedSessions,
    bounds: normalizedBounds,
  });
}

/** Classify independently observable facts; no authorization decision is made. */
export function classifyResourceOverlap(edge: ResourceOverlapEdge): ResourceOverlapClassification {
  return classifyFacts(edge.facts);
}

/** Deterministic JSON projection for the `coordination` serialization key. */
export function serializeResourceOverlapGraph(graph: ResourceOverlapGraph): string {
  return JSON.stringify(graph);
}

export const serializeResourceCoordination = serializeResourceOverlapGraph;

function buildNodes(claims: readonly ResourceClaim[], intents: readonly ResourceIntent[]): ResourceOverlapNode[] {
  const sortedClaims = [...claims].sort((left, right) => compareCodePointStrings(left.claimId, right.claimId));
  const sortedIntents = intents
    .map(normalizeIntent)
    .sort((left, right) => compareCodePointStrings(left.intentId, right.intentId));
  const claimed = new Set<string>();
  const nodes: ResourceOverlapNode[] = [];
  for (const claim of sortedClaims) {
    const attached = sortedIntents.filter(
      (intent) => intent.claimId === claim.claimId && intent.sessionId === claim.sessionId,
    );
    attached.forEach((intent) => claimed.add(intent.intentId));
    const selectors: ResourceSelector[] = [claimSelector(claim), ...attached.map((intent) => intent.selector)];
    nodes.push(
      Object.freeze({
        nodeId: claim.claimId,
        sessionId: claim.sessionId,
        repositoryId: claim.repositoryId,
        claim,
        intents: Object.freeze(attached),
        selectors: Object.freeze(uniqueSelectors(selectors)),
      }),
    );
  }
  for (const intent of sortedIntents) {
    if (claimed.has(intent.intentId)) continue;
    nodes.push(
      Object.freeze({
        nodeId: intent.intentId,
        sessionId: intent.sessionId,
        ...(intent.repositoryId === undefined ? {} : { repositoryId: intent.repositoryId }),
        intents: Object.freeze([intent]),
        selectors: Object.freeze([intent.selector]),
      }),
    );
  }
  return nodes.sort((left, right) => compareCodePointStrings(nodeSortKey(left), nodeSortKey(right)));
}

function normalizeIntent(intent: ResourceIntent): ResourceIntent {
  if (!isRecord(intent)) throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent must be an object");
  const result = createResourceIntent({
    sessionId: intent.sessionId,
    repositoryId: intent.repositoryId,
    claimId: intent.claimId,
    mode: intent.mode,
    selector: intent.selector,
  });
  return result;
}

function claimSelector(claim: ResourceClaim): ResourceSelector {
  return Object.freeze({ kind: WILDCARD.test(claim.resource) ? "glob" : "exact", resource: claim.resource });
}

function sameSelector(left: ResourceSelector, right: ResourceSelector | undefined): boolean {
  return right !== undefined && left.kind === right.kind && left.resource === right.resource;
}

function overlapFacts(left: ResourceOverlapNode, right: ResourceOverlapNode): ResourceOverlapFacts {
  let exactResourceMatch = false;
  let selectorIntersection = false;
  let parentChildOverlap = false;
  let createCreateCollision = false;
  const leftSelectors = left.selectors;
  const rightSelectors = right.selectors;
  const leftClaimSelector = left.claim === undefined ? undefined : claimSelector(left.claim);
  const rightClaimSelector = right.claim === undefined ? undefined : claimSelector(right.claim);
  const claimsPairOverlap =
    left.claim !== undefined && right.claim !== undefined ? claimsOverlap(left.claim, right.claim) : undefined;
  for (const leftSelector of leftSelectors) {
    for (const rightSelector of rightSelectors) {
      const primaryClaimPair =
        sameSelector(leftSelector, leftClaimSelector) && sameSelector(rightSelector, rightClaimSelector);
      // Claim overlap is evidence for the primary claim selectors only. Intent
      // selectors remain independently observable and must not be hidden by
      // disjoint or otherwise non-overlapping claims.
      const overlaps =
        resourceSelectorsOverlap(leftSelector, rightSelector) && (!primaryClaimPair || claimsPairOverlap === true);
      if (!overlaps) continue;
      if (
        leftSelector.kind === "exact" &&
        rightSelector.kind === "exact" &&
        leftSelector.resource === rightSelector.resource
      )
        exactResourceMatch = true;
      if (leftSelector.kind !== "exact" || rightSelector.kind !== "exact") selectorIntersection = true;
      if (isParentChildSelectorPair(leftSelector, rightSelector)) parentChildOverlap = true;
    }
  }
  for (const leftIntent of left.intents) {
    if (leftIntent.mode !== "CREATE") continue;
    for (const rightIntent of right.intents) {
      if (rightIntent.mode === "CREATE" && resourceSelectorsOverlap(leftIntent.selector, rightIntent.selector)) {
        createCreateCollision = true;
      }
    }
  }
  return Object.freeze({
    exactResourceMatch,
    selectorIntersection,
    parentChildOverlap,
    createCreateCollision,
    overlapping: exactResourceMatch || selectorIntersection || parentChildOverlap || createCreateCollision,
  });
}

function isParentChildSelectorPair(left: ResourceSelector, right: ResourceSelector): boolean {
  if (left.kind !== "namespace" && right.kind !== "namespace") return false;
  const namespace = left.kind === "namespace" ? left.resource : right.resource;
  const other = left.kind === "namespace" ? right : left;
  if (other.kind === "namespace") return namespace !== other.resource && pathPrefix(namespace, other.resource);
  if (other.kind === "exact") return namespace !== other.resource && pathPrefix(namespace, other.resource);
  // Require one segment below the namespace. A glob such as `new*` also
  // matches the namespace root, but it does not select a descendant.
  return globPatternsOverlap(`${namespace}/**/*`, other.resource);
}

function classifyFacts(facts: ResourceOverlapFacts): ResourceOverlapClassification {
  const kinds: ResourceOverlapKind[] = [];
  if (facts.exactResourceMatch) kinds.push("exact-resource");
  if (facts.selectorIntersection) kinds.push("selector-intersection");
  if (facts.parentChildOverlap) kinds.push("parent-child");
  if (facts.createCreateCollision) kinds.push("create-create");
  const kind = kinds.length === 1 ? (kinds[0] as ResourceOverlapKind) : "multiple";
  return Object.freeze({ ...facts, kind, kinds: Object.freeze(kinds) });
}

function namespaceSelectorOverlap(left: ResourceSelector, right: ResourceSelector): boolean {
  if (left.kind === "namespace" && right.kind === "namespace") {
    return pathPrefix(left.resource, right.resource) || pathPrefix(right.resource, left.resource);
  }
  const namespace = left.kind === "namespace" ? left.resource : right.resource;
  const other = left.kind === "namespace" ? right : left;
  if (other.kind === "exact") return pathPrefix(namespace, other.resource);
  return globPatternsOverlap(`${namespace}/**`, other.resource) || globPatternsOverlap(namespace, other.resource);
}

function pathPrefix(parent: string, child: string): boolean {
  return parent === child || child.startsWith(`${parent}/`);
}

function normalizeSelectorInput(input: ResourceIntentInput): ResourceSelector {
  if (input.namespace !== undefined) {
    if (input.resource !== undefined || input.selector !== undefined || input.selectorKind !== undefined)
      throw new ResourceCoordinationError("INVALID_SELECTOR", "Namespace cannot be combined with another selector");
    return normalizeSelector({ kind: "namespace", resource: input.namespace });
  }
  if (input.selector !== undefined) {
    if (input.resource !== undefined || input.selectorKind !== undefined)
      throw new ResourceCoordinationError("INVALID_SELECTOR", "Selector cannot be combined with resource fields");
    return normalizeSelector(input.selector);
  }
  if (input.resource === undefined)
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Resource selector is required");
  return normalizeSelector({ kind: input.selectorKind ?? inferSelectorKind(input.resource), resource: input.resource });
}

function normalizeSelector(selector: ResourceSelector | string): ResourceSelector {
  const value = typeof selector === "string" ? { kind: inferSelectorKind(selector), resource: selector } : selector;
  if (!isRecord(value) || !RESOURCE_SELECTOR_KINDS.includes(value.kind as ResourceSelectorKind))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Resource selector kind is unsupported");
  if (typeof value.resource !== "string" || value.resource.length === 0)
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Resource selector resource must be non-empty");
  const resource = canonicalSelectorSyntax(value.resource);
  if (value.kind === "exact" && WILDCARD.test(resource))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Exact selector cannot contain glob syntax");
  if (value.kind === "namespace" && WILDCARD.test(resource))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Namespace selector cannot contain glob syntax");
  return Object.freeze({ kind: value.kind, resource });
}

function canonicalSelectorSyntax(resource: string): string {
  if (
    resource.includes("\u0000") ||
    resource.includes("\\") ||
    resource.startsWith("/") ||
    WINDOWS_ABSOLUTE_PATH.test(resource) ||
    WINDOWS_DRIVE_RELATIVE_PATH.test(resource)
  )
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Selector must be repository-relative");
  if (resource !== resource.normalize("NFC"))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Selector must be Unicode-normalized");
  const segments = resource.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".."))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Selector contains an ambiguous path segment");
  if (segments.some((segment) => UNSUPPORTED_SELECTOR_SYNTAX.test(segment)))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Selector uses unsupported glob syntax");
  if (segments.some((segment) => segment.includes("**") && segment !== "**"))
    throw new ResourceCoordinationError("INVALID_SELECTOR", "Double-star must occupy a complete path segment");
  return segments.join("/");
}

function inferSelectorKind(resource: string): ResourceSelectorKind {
  return WILDCARD.test(resource) ? "glob" : "exact";
}

function readIntentMode(input: ResourceIntentInput): ResourceIntentMode {
  const values = [input.mode, input.operation, input.kind].filter(
    (value): value is ResourceIntentMode => value !== undefined,
  );
  if (values.length === 0 || values.some((value) => !RESOURCE_INTENT_MODES.includes(value)))
    throw new ResourceCoordinationError("INVALID_INTENT", "Resource intent mode is unsupported");
  if (new Set(values).size !== 1) throw new ResourceCoordinationError("INVALID_INTENT", "Intent mode fields disagree");
  return values[0] as ResourceIntentMode;
}

function normalizeBounds(
  bounds: ResourceOverlapBounds,
): Required<Pick<ResourceOverlapBounds, "maxSessions" | "maxPairs" | "maxSelectors">> {
  const result = {
    maxSessions: bounds.maxSessions ?? bounds.maxSessionCount ?? DEFAULT_BOUNDS.maxSessions,
    maxPairs: bounds.maxPairs ?? bounds.maxPairCount ?? DEFAULT_BOUNDS.maxPairs,
    maxSelectors: bounds.maxSelectors ?? bounds.maxSelectorCount ?? DEFAULT_BOUNDS.maxSelectors,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new ResourceCoordinationError("INVALID_BOUNDS", `${name} must be a non-negative integer`);
  }
  return result;
}

function limitSelectors(
  nodes: readonly ResourceOverlapNode[],
  maximum: number,
): { nodes: ResourceOverlapNode[]; omitted: number } {
  let used = 0;
  let omitted = 0;
  const selected: ResourceOverlapNode[] = [];
  for (const node of nodes) {
    const count = node.selectors.length;
    if (used + count <= maximum) {
      selected.push(node);
      used += count;
    } else {
      omitted += count;
    }
  }
  return { nodes: selected, omitted };
}

function uniqueSelectors(selectors: readonly ResourceSelector[]): ResourceSelector[] {
  const unique = new Map<string, ResourceSelector>();
  for (const selector of selectors) unique.set(`${selector.kind}\u0000${selector.resource}`, selector);
  return [...unique.values()].sort((left, right) =>
    compareCodePointStrings(selectorSortKey(left), selectorSortKey(right)),
  );
}

function orderNodes(left: ResourceOverlapNode, right: ResourceOverlapNode): [ResourceOverlapNode, ResourceOverlapNode] {
  return compareCodePointStrings(nodeSortKey(left), nodeSortKey(right)) <= 0 ? [left, right] : [right, left];
}

function makePairKey(left: ResourceOverlapNode, right: ResourceOverlapNode): string {
  const [first, second] = orderNodes(left, right);
  return `${first.sessionId}\u0000${first.nodeId}\u0000${second.sessionId}\u0000${second.nodeId}`;
}

function nodeSortKey(node: ResourceOverlapNode): string {
  return `${node.sessionId}\u0000${node.nodeId}`;
}

function selectorSortKey(selector: ResourceSelector): string {
  return `${selector.kind}\u0000${selector.resource}`;
}

function compareCodePointStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function globPatternsOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const queue: Array<[number, number]> = [[0, 0]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift() as [number, number];
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) return true;
    const leftStar = leftSegments[leftIndex] === "**";
    const rightStar = rightSegments[rightIndex] === "**";
    if (leftStar) {
      queue.push([leftIndex + 1, rightIndex]);
      if (rightIndex < rightSegments.length) queue.push([leftIndex, rightIndex + 1]);
    }
    if (rightStar) {
      queue.push([leftIndex, rightIndex + 1]);
      if (leftIndex < leftSegments.length) queue.push([leftIndex + 1, rightIndex]);
    }
    if (leftIndex >= leftSegments.length || rightIndex >= rightSegments.length) continue;
    if (leftStar || rightStar) continue;
    if (segmentPatternsOverlap(leftSegments[leftIndex] as string, rightSegments[rightIndex] as string))
      queue.push([leftIndex + 1, rightIndex + 1]);
  }
  return false;
}

function segmentPatternsOverlap(left: string, right: string): boolean {
  const queue: Array<[number, number]> = [[0, 0]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.shift() as [number, number];
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) return true;
    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];
    if (leftChar === "*") {
      queue.push([leftIndex + 1, rightIndex]);
      if (rightIndex < right.length) queue.push([leftIndex, rightIndex + 1]);
    }
    if (rightChar === "*") {
      queue.push([leftIndex, rightIndex + 1]);
      if (leftIndex < left.length) queue.push([leftIndex + 1, rightIndex]);
    }
    if (leftIndex >= left.length || rightIndex >= right.length || leftChar === "*" || rightChar === "*") continue;
    if (leftChar === "?" || rightChar === "?" || leftChar === rightChar) queue.push([leftIndex + 1, rightIndex + 1]);
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
