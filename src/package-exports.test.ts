import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as { readonly exports?: Record<string, unknown> };

test("package.json#exports exposes exactly the documented stable state/contract entry points", () => {
  const exportsField = packageJson.exports;
  assert.notEqual(exportsField, undefined);
  assert.deepEqual(Object.keys(exportsField as object).sort(), ["./contract", "./package.json", "./state"]);

  const state = (exportsField as Record<string, { types: string; default: string }>)["./state"];
  assert.equal(state.types, "./dist/public-state.d.ts");
  assert.equal(state.default, "./dist/public-state.js");

  const contract = (exportsField as Record<string, { types: string; default: string }>)["./contract"];
  assert.equal(contract.types, "./dist/public-contract.d.ts");
  assert.equal(contract.default, "./dist/public-contract.js");

  // Neither entry point resolves into the internal `src/state/` boundary
  // (state-node ids, actor refs, private machine context).
  for (const entry of [state, contract]) {
    assert.doesNotMatch(entry.default, /dist\/state\//u);
    assert.doesNotMatch(entry.types, /dist\/state\//u);
  }
});

test("package.json has no wildcard/root export that would reopen deep internal imports", () => {
  const exportsField = packageJson.exports as Record<string, unknown>;
  for (const key of Object.keys(exportsField)) {
    assert.doesNotMatch(key, /\*/u, `subpath "${key}" must not be a wildcard`);
  }
  assert.equal("." in exportsField, false, "no root export is declared");
});
