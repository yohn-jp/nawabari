import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { machineContract, MACHINE_CONTRACT_ID, MACHINE_CONTRACT_SCHEMA_VERSION } from "./contract.js";
import {
  generateNawabariProductStateManifest,
  NAWABARI_PRODUCT_STATE_MANIFEST_ID,
  NAWABARI_PRODUCT_STATE_MANIFEST_SCHEMA_VERSION,
  nawabariProductStateManifest,
  renderNawabariSessionLifecycleDiagram,
  serializeNawabariProductStateManifest,
  type NawabariProductStateManifest,
} from "./product-state-manifest.js";
import {
  NAWABARI_LIFECYCLE_STATES,
  NAWABARI_TRANSITION_TABLE,
  NAWABARI_STATE_API_SCHEMA_VERSION,
} from "./public-state.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diagramPath = path.join(repositoryRoot, "docs/architecture/generated/session-lifecycle.mmd");

function sessionActor(manifest: NawabariProductStateManifest) {
  const actor = manifest.actors.find((candidate) => candidate.id === "nawabari.session");
  assert.ok(actor, "manifest must expose the Session actor");
  return actor;
}

test("Product State Manifest has explicit product, manifest, and public-contract versions", () => {
  const manifest = generateNawabariProductStateManifest("test-package-version");
  assert.equal(manifest.manifest_id, NAWABARI_PRODUCT_STATE_MANIFEST_ID);
  assert.equal(manifest.schema_version, NAWABARI_PRODUCT_STATE_MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(manifest.product, {
    id: "nawabari",
    name: "Nawabari",
    package_name: "nawabari",
    package_version: "test-package-version",
  });
  assert.deepEqual(manifest.public_contract, {
    contract_id: MACHINE_CONTRACT_ID,
    schema_version: MACHINE_CONTRACT_SCHEMA_VERSION,
    api_schema_version: 1,
  });
  assert.deepEqual(manifest.composition.participant_schema, {
    id: "nawabari.product-participant.v1",
    version: 1,
  });
});

test("manifest generation is deterministic for identical input", () => {
  const first = generateNawabariProductStateManifest("deterministic-version");
  const second = generateNawabariProductStateManifest("deterministic-version");
  assert.deepEqual(first, second);
  assert.equal(serializeNawabariProductStateManifest(first), serializeNawabariProductStateManifest(second));
  assert.equal(nawabariProductStateManifest("deterministic-version").manifest_id, first.manifest_id);
});

test("Session state and transitions are projected from the existing public authorities", () => {
  const manifest = generateNawabariProductStateManifest("authority-test");
  const actor = sessionActor(manifest);
  assert.deepEqual(actor.state.states, [...NAWABARI_LIFECYCLE_STATES]);

  const expectedTransitionCount = NAWABARI_LIFECYCLE_STATES.reduce(
    (count, state) => count + NAWABARI_TRANSITION_TABLE[state].length,
    0,
  );
  assert.equal(actor.state.transitions.length, expectedTransitionCount);

  const expectedCommands = [
    ...new Set(
      NAWABARI_LIFECYCLE_STATES.flatMap((state) => NAWABARI_TRANSITION_TABLE[state].map(({ operation }) => operation)),
    ),
  ];
  assert.deepEqual(
    actor.accepted_commands.map((command) => command.id),
    expectedCommands,
  );

  const diagnosticsLifecycle = (machineContract("authority-test").capabilities as Array<Record<string, unknown>>).find(
    (capability) => capability.id === "session-diagnostics",
  )?.lifecycle as Record<string, unknown>;
  assert.deepEqual(diagnosticsLifecycle.states, [...NAWABARI_LIFECYCLE_STATES]);
  assert.deepEqual(diagnosticsLifecycle.transition_table, NAWABARI_TRANSITION_TABLE);
});

test("guard-dependent GC semantics retain both public branches", () => {
  const actor = sessionActor(generateNawabariProductStateManifest("guard-test"));
  const gc = actor.state.transitions.find(
    (transition) => transition.source_state === "close-ready" && transition.command === "gc",
  );
  assert.ok(gc);
  assert.equal(gc.guarded, true);
  if (!gc.guarded) return;
  assert.deepEqual(gc.when_guard_accepts, {
    allowed: true,
    target: "closed",
    reason: "close-authorized",
  });
  assert.deepEqual(gc.when_guard_rejects, {
    allowed: false,
    target: null,
    reason: "age-is-not-destructive-authority",
  });
});

test("accepted command metadata is versionable and emitted events are explicitly absent", () => {
  const actor = sessionActor(generateNawabariProductStateManifest("metadata-test"));
  assert.equal(actor.accepted_commands.length > 0, true);
  for (const command of actor.accepted_commands) {
    assert.equal(command.kind, "command");
    assert.deepEqual(command.schema, {
      id: "nawabari.session-command.v1",
      version: NAWABARI_STATE_API_SCHEMA_VERSION,
    });
    assert.equal(command.producers.length, 1);
    assert.equal(command.consumers.length, 1);
    assert.equal(command.producers[0]?.role, "producer");
    assert.equal(command.consumers[0]?.role, "consumer");
    assert.equal(command.consumers[0]?.contract?.id, MACHINE_CONTRACT_ID);
    assert.equal(Number.isSafeInteger(command.consumers[0]?.contract?.version), true);
    assert.deepEqual(command.correlation, {
      mode: "session-scoped",
      field: "session_id",
      required: false,
      authority: "public-state observation boundary",
    });
    assert.deepEqual(command.idempotency, {
      mode: "not-declared",
      key: null,
      required: false,
      authority: "existing command/runtime contract",
    });
  }

  assert.deepEqual(actor.emitted_events, {
    status: "not-exposed",
    schema: null,
    events: [],
    producers: [],
    consumers: [],
  });
});

test("manifest output contains only public projection data", () => {
  const manifest = generateNawabariProductStateManifest("surface-test");
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /SESSION\./u);
  assert.doesNotMatch(serialized, /stateNode|state-node|createActor|createMachine|ActorRef|Snapshot|context/u);

  const source = fs.readFileSync(path.join(repositoryRoot, "src/product-state-manifest.ts"), "utf8");
  assert.match(source, /NAWABARI_LIFECYCLE_STATES/u);
  assert.match(source, /NAWABARI_TRANSITION_TABLE/u);
  assert.match(source, /nawabariMachineContract/u);
  assert.doesNotMatch(source, /from ["'][^"']*\/state\/session\/|from ["']xstate["']/u);
  assert.doesNotMatch(source, /SESSION\.[A-Z]/u);
  assert.doesNotMatch(
    source,
    /["'](?:active|close-ready|blocked-recoverable|discarded|stale-inconsistent|closed)["']/u,
  );
});

test("Session diagram is generated from manifest transitions and has no separate graph authority", () => {
  const manifest = generateNawabariProductStateManifest("diagram-test");
  const diagram = renderNawabariSessionLifecycleDiagram(manifest);
  assert.equal(diagram, fs.readFileSync(diagramPath, "utf8"));
  assert.match(diagram, /close_ready --> closed : gc \[guard accepts\]/u);
  assert.match(diagram, /guard rejects.*no public transition/u);

  const source = fs.readFileSync(path.join(repositoryRoot, "src/product-state-manifest.ts"), "utf8");
  const renderer = source.slice(source.indexOf("export function renderNawabariSessionLifecycleDiagram"));
  assert.doesNotMatch(renderer, /NAWABARI_TRANSITION_TABLE/u);
  assert.doesNotMatch(renderer, /SESSION\.[A-Z]/u);
});
