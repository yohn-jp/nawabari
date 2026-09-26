import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { machineContract } from "./contract.js";
import { success } from "./domain/errors.js";
import { getBuiltinWorktreeProfile } from "./domain/worktree-profile-builtins.js";
import type { SessionBackend, SessionCreateOptions, SessionRecord } from "./domain/session.js";
import { runCli } from "./cli.js";

function session(): SessionRecord {
  return {
    schema_version: 1,
    session_id: "integration-session",
    repository: "integration-repository",
    worktree: "/tmp/integration-worktree",
    branch: "feature/integration",
    state: "active",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function capture(): {
  readonly io: { stdout(value: string): void; stderr(value: string): void };
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }, stdout, stderr };
}

function git(cwd: string, args: readonly string[]): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}

function createRepository(catalog: unknown): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-profile-integration-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Nawabari Integration"]);
  git(root, ["config", "user.email", "nawabari-integration@example.invalid"]);
  fs.writeFileSync(path.join(root, "README.md"), "integration\n");
  if (catalog !== undefined) fs.writeFileSync(path.join(root, "nawabari.profiles.json"), JSON.stringify(catalog));
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "integration fixture"]);
  return {
    root,
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function repositoryProfile(id: string): Record<string, unknown> {
  const builtin = getBuiltinWorktreeProfile("minimal");
  if (!builtin.ok) throw builtin.error;
  return { ...builtin.value, id, extends: [] };
}

test("contract exposes profile commands, namespaces, serialization, and producer authorities", () => {
  const capabilities = machineContract("integration").capabilities as unknown as readonly Record<string, unknown>[];
  const lifecycle = capabilities.find((capability) => capability.id === "session-lifecycle");
  assert.ok(lifecycle);
  const profile = lifecycle.worktree_profile as Record<string, unknown>;
  assert.deepEqual(profile.commands, ["session create", "profile list", "profile show"]);
  assert.deepEqual(profile.namespaces, ["builtin", "repository"]);
  assert.equal((profile.cli as Record<string, unknown>).contract_id, "nawabari.worktree-profile-cli.v1");
  assert.deepEqual((profile.cli as Record<string, unknown>).serialization_keys, ["cli", "contract"]);
  assert.equal((profile.runtime as Record<string, unknown>).contract_id, "nawabari.worktree-profile-runtime.v1");
  assert.equal((profile.inspection as Record<string, unknown>).projection, "public-state");
});

test("builtin list/show/create and omitted profile bootstrap use explicit namespace references", async () => {
  const repository = createRepository(undefined);
  try {
    let observed: SessionCreateOptions | null = null;
    const backend = {
      createSession: async (_context: unknown, options: SessionCreateOptions) => {
        observed = options;
        return success(session());
      },
    };
    const list = capture();
    assert.equal(await runCli(["--json", "profile", "list"], { cwd: repository.root, io: list.io }), 0);
    const listed = JSON.parse(list.stdout[0] ?? "") as { profiles: readonly { reference: string }[] };
    assert.deepEqual(
      listed.profiles.map((profile) => profile.reference),
      ["builtin:minimal", "builtin:standard-shell"],
    );

    const show = capture();
    assert.equal(
      await runCli(["--json", "profile", "show", "--profile", "builtin:minimal"], {
        cwd: repository.root,
        io: show.io,
      }),
      0,
    );
    assert.equal(
      (JSON.parse(show.stdout[0] ?? "") as { source: { reference: string } }).source.reference,
      "builtin:minimal",
    );

    const created = capture();
    assert.equal(
      await runCli(["--json", "session", "create", "--profile", "builtin:minimal"], {
        cwd: repository.root,
        backend: backend as unknown as SessionBackend,
        io: created.io,
      }),
      0,
    );
    assert.equal((observed as SessionCreateOptions | null)?.profile?.selection.profile, "builtin:minimal");

    observed = null;
    const omitted = capture();
    assert.equal(
      await runCli(["--json", "session", "create"], {
        cwd: repository.root,
        backend: backend as unknown as SessionBackend,
        io: omitted.io,
      }),
      0,
    );
    assert.equal((observed as SessionCreateOptions | null)?.profile, undefined);
  } finally {
    repository.cleanup();
  }
});

test("omitted profile create bypasses a malformed catalog and preserves backend base validation", async () => {
  const repository = createRepository(undefined);
  try {
    fs.writeFileSync(path.join(repository.root, "nawabari.profiles.json"), "{invalid");
    git(repository.root, ["add", "nawabari.profiles.json"]);
    git(repository.root, ["commit", "-m", "malformed catalog"]);

    let observed: SessionCreateOptions | null = null;
    const backend = {
      createSession: async (_context: unknown, options: SessionCreateOptions) => {
        observed = options;
        return success(session());
      },
    };
    const output = capture();
    assert.equal(
      await runCli(["--json", "session", "create", "--base", "invalid-base"], {
        cwd: repository.root,
        backend: backend as unknown as SessionBackend,
        io: output.io,
      }),
      0,
    );
    assert.equal((observed as SessionCreateOptions | null)?.base, "invalid-base");
    assert.equal((observed as SessionCreateOptions | null)?.profile, undefined);
  } finally {
    repository.cleanup();
  }
});

test("repository list/show preserves source identity and create fails closed before backend", async () => {
  const profile = repositoryProfile("repository-profile");
  const repository = createRepository({ profiles: [profile] });
  try {
    let observed: SessionCreateOptions | null = null;
    const backend = {
      createSession: async (_context: unknown, options: SessionCreateOptions) => {
        observed = options;
        return success(session());
      },
    };
    const list = capture();
    assert.equal(await runCli(["--json", "profile", "list"], { cwd: repository.root, io: list.io }), 0);
    const listed = JSON.parse(list.stdout[0] ?? "") as { profiles: readonly { reference: string }[] };
    assert.ok(listed.profiles.some((candidate) => candidate.reference === "repository:repository-profile"));

    const show = capture();
    assert.equal(
      await runCli(["--json", "profile", "show", "--profile", "repository:repository-profile"], {
        cwd: repository.root,
        io: show.io,
      }),
      0,
    );
    assert.equal(
      (JSON.parse(show.stdout[0] ?? "") as { source: { reference: string } }).source.reference,
      "repository:repository-profile",
    );

    const create = capture();
    assert.equal(
      await runCli(["--json", "session", "create", "--profile", "repository:repository-profile"], {
        cwd: repository.root,
        backend: backend as unknown as SessionBackend,
        io: create.io,
      }),
      4,
    );
    assert.equal(observed, null);
    assert.equal(JSON.parse(create.stdout[0] ?? "").code, "RUNTIME_MATERIALIZATION_MISSING");

    const collision = createRepository({ profiles: [repositoryProfile("minimal")] });
    try {
      const output = capture();
      assert.equal(
        await runCli(["--json", "profile", "show", "--profile", "minimal"], { cwd: collision.root, io: output.io }),
        3,
      );
      assert.equal(JSON.parse(output.stdout[0] ?? "").code, "RUNTIME_PROFILE_AMBIGUOUS");
    } finally {
      collision.cleanup();
    }

    const invalid = createRepository(undefined);
    try {
      fs.writeFileSync(path.join(invalid.root, "nawabari.profiles.json"), "{invalid");
      git(invalid.root, ["add", "nawabari.profiles.json"]);
      git(invalid.root, ["commit", "-m", "invalid catalog"]);
      const output = capture();
      assert.equal(await runCli(["--json", "profile", "list"], { cwd: invalid.root, io: output.io }), 3);
      assert.equal(JSON.parse(output.stdout[0] ?? "").code, "RUNTIME_PROFILE_INVALID");
    } finally {
      invalid.cleanup();
    }
  } finally {
    repository.cleanup();
  }
});

test("known missing built-in material fails before backend create", async () => {
  const repository = createRepository(undefined);
  try {
    let invoked = false;
    const output = capture();
    const exitCode = await runCli(["--json", "session", "create", "--profile", "builtin:standard-shell"], {
      cwd: repository.root,
      backend: {
        createSession: async () => {
          invoked = true;
          return success(session());
        },
      } as unknown as SessionBackend,
      io: output.io,
    });
    assert.equal(exitCode, 4);
    assert.equal(invoked, false);
    assert.equal(JSON.parse(output.stdout[0] ?? "").code, "RUNTIME_MATERIALIZATION_MISSING");
  } finally {
    repository.cleanup();
  }
});

test("catalog read failure is not treated as catalog absence", async () => {
  const repository = createRepository({ profiles: [repositoryProfile("repository-profile")] });
  try {
    const blob = git(repository.root, ["rev-parse", "HEAD:nawabari.profiles.json"]);
    const object = path.join(repository.root, ".git", "objects", blob.slice(0, 2), blob.slice(2));
    fs.rmSync(object, { force: true });

    const output = capture();
    assert.equal(await runCli(["--json", "profile", "list"], { cwd: repository.root, io: output.io }), 3);
    const error = JSON.parse(output.stdout[0] ?? "") as { code: string; details?: { reason?: string } };
    assert.equal(error.code, "RUNTIME_PROFILE_INVALID");
    assert.equal((error.details?.reason?.length ?? 0) <= 200, true);
  } finally {
    repository.cleanup();
  }
});
