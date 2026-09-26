import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCoordinatedSharingGroup,
  parseCoordinationPreviewArguments,
  parseResourceHandoffArguments,
} from "./resource-coordination-cli.js";

test("handoff parser keeps --from and --to as session identities", () => {
  const parsed = parseResourceHandoffArguments([
    "--from",
    "source-session",
    "--to",
    "destination-session",
    "--resource",
    "src/file.ts",
    "--mode",
    "write",
    "--if-generation",
    "7",
    "--operation-id",
    "handoff-7",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, {
    from_session_id: "source-session",
    to_session_id: "destination-session",
    resource: "src/file.ts",
    mode: "write",
    if_generation: 7,
    operation_id: "handoff-7",
  });
});

test("preview parser is metadata-only unless bounded read authority is explicit", () => {
  const metadata = parseCoordinationPreviewArguments([
    "--left",
    "left-session",
    "--right",
    "right-session",
    "--path",
    "README.md",
  ]);
  assert.equal(metadata.ok, true);
  if (!metadata.ok) return;
  assert.equal(metadata.value.include_patch, false);
  const rejected = parseCoordinationPreviewArguments([
    "--left",
    "left-session",
    "--right",
    "right-session",
    "--path",
    "README.md",
    "--patch",
  ]);
  assert.equal(rejected.ok, false);
  const authorized = parseCoordinationPreviewArguments([
    "--left",
    "left-session",
    "--right",
    "right-session",
    "--path",
    "README.md",
    "--patch",
    "--allow-read-path",
    "README.md",
  ]);
  assert.equal(authorized.ok, true);
});

test("preview parser accepts zero observation retries", () => {
  const parsed = parseCoordinationPreviewArguments([
    "--left",
    "left-session",
    "--right",
    "right-session",
    "--path",
    "README.md",
    "--max-retries",
    "0",
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.max_retries, 0);
});

test("sharing-group parser emits the canonical producer binding", () => {
  assert.deepEqual(parseCoordinatedSharingGroup(["--mode", "write", "--sharing-group", "group-1"]), {
    ok: true,
    value: { kind: "isolated-worktree", groupId: "group-1" },
  });
});
