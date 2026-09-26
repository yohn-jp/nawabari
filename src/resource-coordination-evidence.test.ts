import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultGit, type GitCommandRunner } from "./git.js";
import { SessionRegistry } from "./session-registry.js";
import {
  observeCoordinationInputs,
  readCoordinationBlobState,
  type CoordinationObservationToken,
} from "./resource-coordination-evidence.js";

test("keeps revision and dirty worktree content as separate bounded origins", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "working\n");
    const blob = readCoordinationBlobState(defaultGit, fixture.root, fixture.head, "tracked.txt", {
      includeContent: true,
      operatorAuthorized: true,
    });

    assert.equal(blob.revisionBlob.state, "regular");
    assert.equal(blob.worktree.state, "regular");
    assert.notEqual(blob.revisionBlob.contentHash, blob.worktree.contentHash);
    assert.equal(blob.revisionBlob.content?.origin, "revision-blob");
    assert.equal(blob.worktree.content?.origin, "worktree-file");
    assert.equal(blob.equal, false);
  } finally {
    fixture.cleanup();
  }
});

test("derives regular worktree mode and bytes from one opened descriptor", () => {
  const fixture = createFixture();
  const candidate = path.join(fixture.root, "tracked.txt");
  const originalOpen = fs.openSync;
  const originalFstat = fs.fstatSync;
  const originalRead = fs.readSync;
  const originalClose = fs.closeSync;
  let openedFd: number | undefined;
  const statFds: number[] = [];
  const readFds: number[] = [];
  const closedFds: number[] = [];
  try {
    fs.chmodSync(candidate, 0o644);
    fs.openSync = ((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      if (file === candidate) {
        openedFd = fd;
        assert.notEqual((flags as number) & fs.constants.O_NOFOLLOW, 0);
        assert.notEqual((flags as number) & fs.constants.O_NONBLOCK, 0);
      }
      return fd;
    }) as typeof fs.openSync;
    fs.fstatSync = ((fd) => {
      statFds.push(fd);
      return originalFstat(fd);
    }) as typeof fs.fstatSync;
    fs.readSync = ((fd, buffer, offset, length, position) => {
      readFds.push(fd);
      return originalRead(fd, buffer, offset, length, position);
    }) as typeof fs.readSync;
    fs.closeSync = (fd) => {
      closedFds.push(fd);
      originalClose(fd);
    };

    const blob = readCoordinationBlobState(defaultGit, fixture.root, fixture.head, "tracked.txt", {
      includeContent: true,
      operatorAuthorized: true,
    });
    assert.equal(blob.worktree.state, "regular");
    assert.equal(blob.worktree.mode, "100644");
    assert.equal(Buffer.from(blob.worktree.content?.bytes ?? "", "base64").toString(), "base\n");
    const closedFd = openedFd;
    assert.ok(closedFd !== undefined);
    assert.deepEqual(statFds, [closedFd, closedFd]);
    assert.deepEqual(readFds, [closedFd]);
    assert.deepEqual(closedFds, [closedFd]);
    assert.throws(() => originalFstat(closedFd), { code: "EBADF" });
  } finally {
    fs.openSync = originalOpen;
    fs.fstatSync = originalFstat;
    fs.readSync = originalRead;
    fs.closeSync = originalClose;
    fixture.cleanup();
  }
});

test("classifies a symlink introduced before opening without following it", () => {
  const fixture = createFixture();
  const candidate = path.join(fixture.root, "tracked.txt");
  const secret = path.join(fixture.root, "secret.txt");
  try {
    fs.writeFileSync(secret, "secret\n");
    const git: GitCommandRunner = {
      ...defaultGit,
      runRaw(args, cwd) {
        const output = (defaultGit.runRaw ?? defaultGit.run)(args, cwd);
        if (args[0] === "ls-tree") {
          fs.rmSync(candidate);
          fs.symlinkSync(secret, candidate);
        }
        return output;
      },
    };
    const blob = readCoordinationBlobState(git, fixture.root, fixture.head, "tracked.txt", {
      includeContent: true,
      operatorAuthorized: true,
    });
    assert.equal(blob.worktree.state, "symlink");
    assert.equal(blob.worktree.mode, "120000");
    assert.equal(blob.worktree.type, "symlink");
    assert.equal(blob.worktree.content, null);
    assert.equal(JSON.stringify(blob).includes("secret"), false);
  } finally {
    fixture.cleanup();
  }
});

test("keeps missing, denied, directory, special, and too-large dispositions", () => {
  const fixture = createFixture();
  const candidate = path.join(fixture.root, "tracked.txt");
  const originalOpen = fs.openSync;
  try {
    fs.rmSync(candidate);
    assert.equal(readAuthorizedWorktree(fixture, "tracked.txt").state, "missing");

    fs.mkdirSync(candidate);
    const directory = readAuthorizedWorktree(fixture, "tracked.txt");
    assert.equal(directory.state, "directory");
    assert.equal(directory.mode, "040000");
    fs.rmdirSync(candidate);

    execFileSync("mkfifo", [candidate]);
    const special = readAuthorizedWorktree(fixture, "tracked.txt");
    assert.equal(special.state, "special");
    assert.equal(special.mode, "000000");
    fs.rmSync(candidate);

    fs.writeFileSync(candidate, "oversized\n");
    const tooLarge = readCoordinationBlobState(defaultGit, fixture.root, fixture.head, "tracked.txt", {
      maxContentBytes: 4,
      includeContent: true,
      operatorAuthorized: true,
    }).worktree;
    assert.equal(tooLarge.state, "too-large");
    assert.equal(tooLarge.byteLength, 10);
    assert.equal(tooLarge.content, null);

    fs.openSync = ((file, flags, mode) => {
      if (file === candidate) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return originalOpen(file, flags, mode);
    }) as typeof fs.openSync;
    assert.equal(readAuthorizedWorktree(fixture, "tracked.txt").state, "read-denied");
  } finally {
    fs.openSync = originalOpen;
    fixture.cleanup();
  }
});

test("rejects a file changed during descriptor reading as unavailable", () => {
  const fixture = createFixture();
  const candidate = path.join(fixture.root, "tracked.txt");
  const originalRead = fs.readSync;
  let mutated = false;
  try {
    fs.readSync = ((fd, buffer, offset, length, position) => {
      const count = originalRead(fd, buffer, offset, length, position);
      if (!mutated) {
        mutated = true;
        fs.appendFileSync(candidate, "changed\n");
      }
      return count;
    }) as typeof fs.readSync;

    const blob = readCoordinationBlobState(defaultGit, fixture.root, fixture.head, "tracked.txt", {
      includeContent: true,
      operatorAuthorized: true,
    });
    assert.equal(mutated, true);
    assert.equal(blob.worktree.state, "unavailable");
    assert.equal(blob.worktree.content, null);
    assert.equal(blob.complete, false);
  } finally {
    fs.readSync = originalRead;
    fixture.cleanup();
  }
});

test("closes the descriptor when reading fails", () => {
  const fixture = createFixture();
  const originalOpen = fs.openSync;
  const originalRead = fs.readSync;
  let openedFd: number | undefined;
  try {
    fs.openSync = ((file, flags, mode) => {
      const fd = originalOpen(file, flags, mode);
      if (file === path.join(fixture.root, "tracked.txt")) openedFd = fd;
      return fd;
    }) as typeof fs.openSync;
    fs.readSync = (() => {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    }) as typeof fs.readSync;

    const side = readAuthorizedWorktree(fixture, "tracked.txt");
    assert.equal(side.state, "unavailable");
    assert.equal(side.content, null);
    const closedFd = openedFd;
    assert.ok(closedFd !== undefined);
    assert.throws(() => fs.fstatSync(closedFd), { code: "EBADF" });
  } finally {
    fs.openSync = originalOpen;
    fs.readSync = originalRead;
    fixture.cleanup();
  }
});

test("distinguishes untracked and missing paths while observing uncommitted changes", () => {
  const fixture = createFixture(true);
  try {
    fs.writeFileSync(path.join(fixture.root, "new.txt"), "new\n");
    fs.rmSync(path.join(fixture.linked, "tracked.txt"));
    const token = observe(fixture.registry, fixture.first.sessionId, ["new.txt", "tracked.txt"]);
    const first = sessionPath(token, fixture.first.sessionId, "new.txt");
    const second = sessionPath(token, fixture.second.sessionId, "tracked.txt");

    assert.equal(first.untracked, true);
    assert.equal(first.missing, false);
    assert.equal(first.blob.worktree.state, "untracked");
    assert.equal(second.missing, true);
    assert.equal(second.untracked, false);
    assert.equal(second.blob.worktree.state, "missing");
  } finally {
    fixture.cleanup();
  }
});

test("reports one-sided changes from the worktree checkpoint, not only HEAD diffs", () => {
  const fixture = createFixture(true);
  try {
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "working\n");
    const token = observe(fixture.registry, fixture.first.sessionId, ["tracked.txt"]);
    assert.equal(token.complete, true);
    assert.equal(token.paths[0]?.status, "one-sided-change");
    assert.equal(sessionPath(token, fixture.first.sessionId, "tracked.txt").worktreeChanged, true);
    assert.equal(sessionPath(token, fixture.second.sessionId, "tracked.txt").worktreeChanged, false);
  } finally {
    fixture.cleanup();
  }
});

test("keeps a successful empty diff complete and classified as no change", () => {
  const fixture = createFixture();
  try {
    const token = observe(fixture.registry, fixture.first.sessionId, ["tracked.txt"]);
    const evidence = sessionPath(token, fixture.first.sessionId, "tracked.txt");

    assert.equal(evidence.diff?.statsAvailable, false);
    assert.equal(evidence.complete, true);
    assert.equal(token.complete, true);
    assert.equal(token.paths[0]?.status, "no-change");
  } finally {
    fixture.cleanup();
  }
});

test("redacts content and patch for paths outside the selected read authority", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "private\n");
    const token = observe(fixture.registry, fixture.first.sessionId, ["tracked.txt"]);
    const evidence = sessionPath(token, fixture.first.sessionId, "tracked.txt");

    assert.equal(evidence.blob.worktree.content, null);
    assert.equal(evidence.blob.revisionBlob.content, null);
    assert.equal(evidence.blob.worktree.redacted, true);
    assert.equal(evidence.diff?.patch, null);
    assert.equal(JSON.stringify(token).includes("private"), false);
  } finally {
    fixture.cleanup();
  }
});

test("does not expose either session's content without cross-session authority", () => {
  const fixture = createFixture(true);
  try {
    fixture.registry.claim({
      sessionId: fixture.first.sessionId,
      claims: [{ resource: "tracked.txt", mode: "read" }],
    });
    fixture.registry.claim({
      sessionId: fixture.second.sessionId,
      claims: [{ resource: "tracked.txt", mode: "read" }],
    });
    const token = observeCoordinationInputs(
      fixture.registry,
      [fixture.first.sessionId, fixture.second.sessionId],
      ["tracked.txt"],
      { includeContent: true, includePatch: true },
    );

    for (const session of token.sessions) {
      const evidence = session.paths[0];
      assert.ok(evidence);
      assert.equal(evidence.blob.revisionBlob.content, null);
      assert.equal(evidence.blob.worktree.content, null);
      assert.equal(evidence.diff?.patch, null);
    }
    assert.equal(JSON.stringify(token).includes("YmFzZQo="), false);
  } finally {
    fixture.cleanup();
  }
});

test("fails closed instead of UTF-8 decoding exact blob bytes", () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.root, "tracked.txt"), Buffer.from([0xff, 0x00, 0xfe]));
    runGit(fixture.root, ["add", "tracked.txt"]);
    runGit(fixture.root, ["commit", "-m", "binary"]);
    const revision = runGit(fixture.root, ["rev-parse", "HEAD"]).trim();
    const withoutBuffer: GitCommandRunner = {
      run: defaultGit.run,
      runRaw: defaultGit.runRaw,
    };
    const blob = readCoordinationBlobState(withoutBuffer, fixture.root, revision, "tracked.txt", {
      includeContent: true,
      operatorAuthorized: true,
    });

    assert.equal(blob.revisionBlob.state, "unavailable");
    assert.equal(blob.revisionBlob.content, null);
    assert.equal(blob.complete, false);
  } finally {
    fixture.cleanup();
  }
});

test("marks the observation incomplete when bounded diff evidence is unavailable", () => {
  const fixture = createFixture();
  try {
    const git: GitCommandRunner = {
      ...defaultGit,
      runRaw(args, cwd) {
        if (args[0] === "diff") throw new Error("diff unavailable");
        return (defaultGit.runRaw ?? defaultGit.run)(args, cwd);
      },
    };
    const token = observeCoordinationInputs(fixture.registry, [fixture.first.sessionId], ["tracked.txt"], { git });
    const evidence = sessionPath(token, fixture.first.sessionId, "tracked.txt");

    assert.equal(evidence.diff, null);
    assert.equal(evidence.complete, false);
    assert.equal(token.complete, false);
    assert.equal(token.paths[0]?.status, "unavailable");
  } finally {
    fixture.cleanup();
  }
});

test("contains ls-tree failures as unavailable bounded evidence", () => {
  const fixture = createFixture();
  try {
    const git: GitCommandRunner = {
      ...defaultGit,
      runRaw(args, cwd) {
        if (args[0] === "ls-tree") throw new Error("tree unavailable");
        return (defaultGit.runRaw ?? defaultGit.run)(args, cwd);
      },
    };
    const token = observeCoordinationInputs(fixture.registry, [fixture.first.sessionId], ["tracked.txt"], { git });
    const evidence = sessionPath(token, fixture.first.sessionId, "tracked.txt");

    assert.equal(token.status, "unavailable");
    assert.equal(token.complete, false);
    assert.equal(token.paths[0]?.status, "unavailable");
    assert.equal(evidence.unavailable, true);
    assert.equal(evidence.blob.complete, false);
  } finally {
    fixture.cleanup();
  }
});

test("retries once when selected file identity changes during observation", () => {
  const fixture = createFixture();
  try {
    let statusCalls = 0;
    const git: GitCommandRunner = {
      ...defaultGit,
      runRaw(args, cwd) {
        const result = (defaultGit.runRaw ?? defaultGit.run)(args, cwd);
        if (args[0] === "status" && ++statusCalls === 1) {
          fs.writeFileSync(path.join(fixture.root, "tracked.txt"), "changed while observing\n");
        }
        return result;
      },
    };
    const token = observeCoordinationInputs(fixture.registry, [fixture.first.sessionId], ["tracked.txt"], {
      git,
      maxRetries: 1,
    });

    assert.equal(token.status, "stable");
    assert.equal(token.attempts, 2);
    assert.equal(token.complete, true);
  } finally {
    fixture.cleanup();
  }
});

interface Fixture {
  readonly root: string;
  readonly linked: string;
  readonly head: string;
  readonly registry: SessionRegistry;
  readonly first: { readonly sessionId: string };
  readonly second: { readonly sessionId: string };
  cleanup(): void;
}

function readAuthorizedWorktree(fixture: Fixture, resource: string) {
  return readCoordinationBlobState(defaultGit, fixture.root, fixture.head, resource, {
    includeContent: true,
    operatorAuthorized: true,
  }).worktree;
}

function createFixture(withLinked = false): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-coordination-"));
  const linked = `${root}-linked`;
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.email", "nawabari-tests@example.invalid"]);
  runGit(root, ["config", "user.name", "Nawabari Tests"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
  runGit(root, ["add", "tracked.txt"]);
  runGit(root, ["commit", "-m", "initial"]);
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  if (withLinked) runGit(root, ["worktree", "add", "-b", "linked", linked, head]);
  const registry = new SessionRegistry({ cwd: root });
  const first = registry.create();
  const second = withLinked ? registry.create({ worktreePath: linked, branchName: "linked" }) : first;
  return {
    root,
    linked,
    head,
    registry,
    first,
    second,
    cleanup(): void {
      if (withLinked) {
        try {
          runGit(root, ["worktree", "remove", "--force", linked]);
        } catch {
          // Directory cleanup below remains safe if Git already removed it.
        }
      }
      fs.rmSync(linked, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function observe(registry: SessionRegistry, sessionId: string, paths: readonly string[]): CoordinationObservationToken {
  return observeCoordinationInputs(
    registry,
    registry.read().map((record) => record.sessionId),
    paths,
    { operatorAuthorized: false, includeContent: true, includePatch: true },
  );
}

function sessionPath(token: CoordinationObservationToken, sessionId: string, resource: string) {
  const session = token.sessions.find((candidate) => candidate.sessionId === sessionId);
  assert.ok(session);
  const evidence = session.paths.find((candidate) => candidate.path === resource);
  assert.ok(evidence);
  return evidence;
}

function runGit(cwd: string, args: readonly string[]): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }),
  );
}
