import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RepositoryStateBoundary } from "./repository-state-boundary.js";
import type { PersistedRegistryV2 } from "../session-registry.js";
import type { RegistryState } from "./repository-state-boundary.js";

test("the repository boundary validates a complete document before atomic replacement", async () => {
  const commonGitDirectory = await mkdtemp(join(tmpdir(), "nawabari-state-boundary-"));
  try {
    const parseState = (value: unknown): RegistryState => {
      if (typeof value !== "object" || value === null || !("valid" in value) || value.valid !== true) {
        throw new Error("Invalid complete registry document");
      }
      return {} as RegistryState;
    };
    const boundary = new RepositoryStateBoundary({
      commonGitDirectory,
      lockTimeoutMs: 100,
      lockStaleAfterMs: 1_000,
      lockMetadataGraceMs: 100,
      emptyState: () => ({}) as RegistryState,
      parseState: (value) => parseState(value),
      validateCommit: (document) => {
        parseState(document);
      },
    });

    assert.throws(
      () => boundary.commit({ valid: false } as unknown as PersistedRegistryV2),
      /Invalid complete registry document/,
    );
    await assert.rejects(access(boundary.paths.registry), { code: "ENOENT" });
  } finally {
    await rm(commonGitDirectory, { recursive: true, force: true });
  }
});
