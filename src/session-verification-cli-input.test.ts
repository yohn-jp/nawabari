import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { readSessionVerificationRequestFile } from "./session-verification-cli-input.js";

test("verification CLI request reader is bounded and refuses nonregular or ambiguous bytes", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-verifier-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "request.json");
  fs.writeFileSync(file, '{"profile":"実検証"}\n');
  assert.deepEqual(readSessionVerificationRequestFile(file), { ok: true, value: '{"profile":"実検証"}\n' });
  const symlink = path.join(root, "request-link.json");
  fs.symlinkSync(file, symlink);
  assert.equal(readSessionVerificationRequestFile(symlink).ok, false);
  assert.equal(readSessionVerificationRequestFile(root).ok, false);
  assert.equal(readSessionVerificationRequestFile(path.join(root, "absent")).ok, false);
  fs.writeFileSync(file, Buffer.from([0xff]));
  assert.equal(readSessionVerificationRequestFile(file).ok, false);
  fs.writeFileSync(file, Buffer.alloc(1_048_577, 32));
  assert.equal(readSessionVerificationRequestFile(file).ok, false);
});
