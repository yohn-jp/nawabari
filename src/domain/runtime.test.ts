import assert from "node:assert/strict";
import test from "node:test";
import { NODE_RUNTIME_POLICY, supportsRuntime } from "./runtime.js";

test("runtime policy is derived from the package engine", () => {
  assert.equal(NODE_RUNTIME_POLICY.engine, ">=24");
  assert.deepEqual(NODE_RUNTIME_POLICY.minimum, { major: 24, minor: 0, patch: 0 });
});

test("runtime support rejects versions below the package baseline", () => {
  assert.equal(supportsRuntime("22.13.0"), false);
  assert.equal(supportsRuntime("23.99.99"), false);
});

test("runtime support accepts Node 24 and later major versions", () => {
  assert.equal(supportsRuntime("24.0.0"), true);
  assert.equal(supportsRuntime("26.1.0"), true);
});
