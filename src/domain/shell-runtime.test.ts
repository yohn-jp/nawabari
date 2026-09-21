import assert from "node:assert/strict";
import test from "node:test";

import { resolveProfileShell } from "./shell-runtime.js";

const profile = {
  contract_id: "nawabari.runtime-profile.v1" as const,
  schema_version: 1 as const,
  profile: { id: "bash", version: "1" },
  selected_profiles: [{ id: "bash", version: "1" }],
  requirements: [{ id: "bash-runtime", kind: "runtime" as const, name: "bash", version: ">=5" }],
};

test("projects explicitly selected Bash with hermetic startup arguments", () => {
  const result = resolveProfileShell(profile, {
    executables: [
      {
        name: "bash",
        target: "/nawabari/bin/bash",
        provider: { id: "fhs-bash-runtime-provider", requirement_id: "bash-runtime" },
        provenance: "runtime-profile",
      },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.executable, "/nawabari/bin/bash");
  assert.deepEqual(result.value.args, ["--noprofile", "--norc"]);
  assert.deepEqual(result.value.environment, { HOME: "/nawabari/home", PATH: "/nawabari/bin" });
});

test("unselected Bash is not supplied by the shell resolver", () => {
  const result = resolveProfileShell({ ...profile, requirements: [] }, { executables: [] });
  assert.equal(result.ok, false);
});

test("rejects Bash material from a non-canonical provider", () => {
  const result = resolveProfileShell(profile, {
    executables: [
      {
        name: "bash",
        target: "/nawabari/bin/bash",
        provider: { id: "fhs-bash-provider", requirement_id: "bash-runtime" },
        provenance: "runtime-profile",
      },
    ],
  });
  assert.equal(result.ok, false);
});
