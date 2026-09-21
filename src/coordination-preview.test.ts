import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionRegistry } from "./session-registry.js";
import {
  previewCoordination,
  serializeCoordinationPreview,
  type CoordinationPreviewOptions,
} from "./coordination-preview.js";

test("requires an explicit distinct session pair, path, and path authority", () => {
  const fixture = createFixture();
  try {
    const base: CoordinationPreviewOptions = { path: "tracked.txt" };
    assert.throws(() => previewCoordination(fixture.registry, base), /explicit left session/u);
    assert.throws(
      () => previewCoordination(fixture.registry, { ...base, left: fixture.left.sessionId }),
      /explicit right session/u,
    );
    assert.throws(
      () =>
        previewCoordination(fixture.registry, {
          ...base,
          left: fixture.left.sessionId,
          right: fixture.left.sessionId,
        }),
      /two distinct sessions/u,
    );
    assert.throws(
      () =>
        previewCoordination(fixture.registry, {
          ...base,
          left: fixture.left.sessionId,
          right: fixture.right.sessionId,
        }),
      /outside session authority/u,
    );
    assert.throws(
      () =>
        previewCoordination(fixture.registry, {
          ...base,
          left: fixture.left.sessionId,
          right: fixture.right.sessionId,
          include_patch: true,
          read_authorized: true,
          git_executable: findGit(),
        }),
      /outside session authority/u,
    );
  } finally {
    fixture.cleanup();
  }
});

test("metadata preview is deterministic and carries generation, heads, and token evidence", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
    });

    assert.equal(result.operation, "coordination-preview");
    assert.equal(result.outcome, "clean");
    assert.equal(result.unknown, false);
    assert.equal(result.stale, false);
    assert.equal(result.complete, true);
    assert.equal(result.path, "tracked.txt");
    assert.equal(result.baseRevision, fixture.head);
    assert.equal(result.heads.left, fixture.head);
    assert.equal(result.heads.right, fixture.head);
    assert.equal(result.generation, 2);
    assert.match(result.previewToken, /^[0-9a-f]{64}$/u);
    assert.match(result.evidenceHash, /^[0-9a-f]{64}$/u);
    assert.equal(result.patch, null);
    assert.equal(result.merge, null);

    const serialized = serializeCoordinationPreview(result);
    assert.equal(serialized, serializeCoordinationPreview(result));
    assert.equal(serialized.includes("base\\n"), false);
  } finally {
    fixture.cleanup();
  }
});

test("classifies a one-sided modification as clean instead of a conflict", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "left-only\n");

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
    });

    assert.equal(result.outcome, "clean");
    assert.equal(result.decision?.kind, "left-only");
    assert.equal(result.unknown, false);
  } finally {
    fixture.cleanup();
  }
});

test("classifies a one-sided deletion as clean instead of delete/modify", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.rmSync(path.join(fixture.root, "tracked.txt"));

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
    });

    assert.equal(result.outcome, "clean");
    assert.equal(result.decision?.kind, "left-only");
    assert.equal(result.unknown, false);
  } finally {
    fixture.cleanup();
  }
});

test("patch preview keeps a one-sided modification clean", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "left-only\n");

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
      include_patch: true,
      operator_authorized: true,
      git_executable: findGit(),
    });

    assert.equal(result.outcome, "clean");
    assert.equal(result.decision?.kind, "left-only");
    assert.equal(result.unknown, false);
    assert.equal(result.patch, null);
  } finally {
    fixture.cleanup();
  }
});

test("patch preview keeps a one-sided deletion clean", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.rmSync(path.join(fixture.root, "tracked.txt"));

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
      include_patch: true,
      operator_authorized: true,
      git_executable: findGit(),
    });

    assert.equal(result.outcome, "clean");
    assert.equal(result.decision?.kind, "left-only");
    assert.equal(result.unknown, false);
    assert.equal(result.patch, null);
  } finally {
    fixture.cleanup();
  }
});

test("explicit read authority exposes only the bounded merge preview", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "left\n");
    fs.writeFileSync(path.join(fixture.linked, "tracked.txt"), "right\n");

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
      include_patch: true,
      operator_authorized: true,
      git_executable: findGit(),
    });

    assert.equal(result.outcome, "conflict");
    assert.equal(result.unknown, false);
    assert.equal(result.merge?.outcome, "conflict");
    assert.match(result.patch ?? "", /<<<<<<< left/u);
    assert.deepEqual(result.conflictRanges.length, 1);
    assert.ok((result.budget.patchBytes ?? 0) > 0);
  } finally {
    fixture.cleanup();
  }
});

test("a divergent text path stays unknown in metadata mode and patch requires authority", () => {
  const fixture = createFixture();
  try {
    claimBoth(fixture);
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "left\n");
    fs.writeFileSync(path.join(fixture.linked, "tracked.txt"), "right\n");

    const result = previewCoordination(fixture.registry, {
      left: fixture.left.sessionId,
      right: fixture.right.sessionId,
      path: "tracked.txt",
    });
    assert.equal(result.outcome, "unknown");
    assert.equal(result.unknown, true);
    assert.equal(result.unknownReason, "read-authority-required");
    assert.equal(result.patch, null);
    assert.throws(
      () =>
        previewCoordination(fixture.registry, {
          left: fixture.left.sessionId,
          right: fixture.right.sessionId,
          path: "tracked.txt",
          include_patch: true,
          git_executable: findGit(),
        }),
      /explicit read authority/u,
    );
  } finally {
    fixture.cleanup();
  }
});

interface Fixture {
  readonly root: string;
  readonly linked: string;
  readonly head: string;
  readonly registry: SessionRegistry;
  readonly left: { readonly sessionId: string };
  readonly right: { readonly sessionId: string };
  cleanup(): void;
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-coordination-preview-"));
  const linked = `${root}-linked`;
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "nawabari-tests@example.invalid"]);
  runGit(root, ["config", "user.name", "Nawabari Tests"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, ["commit", "-m", "initial"]);
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["worktree", "add", "-b", "linked", linked, head]);
  const registry = new SessionRegistry({ cwd: root });
  const left = registry.create();
  const right = registry.create({ worktreePath: linked, branchName: "linked" });
  return {
    root,
    linked,
    head,
    registry,
    left,
    right,
    cleanup(): void {
      try {
        runGit(root, ["worktree", "remove", "--force", linked]);
      } catch {
        // Directory cleanup below remains safe if Git already removed it.
      }
      fs.rmSync(linked, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function claimBoth(fixture: Fixture): void {
  fixture.registry.claim({
    sessionId: fixture.left.sessionId,
    claims: [{ resource: "tracked.txt", mode: "read" }],
  });
  fixture.registry.claim({
    sessionId: fixture.right.sessionId,
    claims: [{ resource: "tracked.txt", mode: "read" }],
  });
}

function findGit(): string {
  return execFileSync("which", ["git"], { encoding: "utf8" }).trim();
}

function runGit(cwd: string, args: readonly string[]): string {
  return String(execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
