import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { repositoryKey, registerRepositoryLocator } from "./control-repositories.js";
import { CONTROL_TOKEN_HEADER, startControlServer } from "./control-server.js";
import { LocalSessionBackend } from "./domain/session-backend.js";
import { SessionRegistry } from "./session-registry.js";

test("HTTP discard confirmation rejects a changed effect at the final registry mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-control-discard-approval-"));
  const repositoryPath = path.join(root, "repository");
  const worktreePath = path.join(root, "worktree");
  const catalogPath = path.join(root, "state", "control-repositories.json");
  const branchName = "feature/http-discard-approval";
  fs.mkdirSync(repositoryPath);
  const git = (args: readonly string[]) =>
    String(
      execFileSync("git", args, {
        cwd: repositoryPath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
      }),
    ).trim();
  let closeServer: (() => Promise<void>) | undefined;
  try {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Nawabari Tests"]);
    git(["config", "user.email", "nawabari-tests@example.invalid"]);
    git(["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
    git(["add", "README.md"]);
    git(["commit", "-m", "initial"]);

    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName });
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "write" }],
    });
    fs.writeFileSync(path.join(worktreePath, "approved.txt"), "approved work\n");
    const registered = registerRepositoryLocator(catalogPath, repositoryPath);
    assert.equal(registered.ok, true);

    class ChangedAfterApplicationCheckBackend extends LocalSessionBackend {
      override discardSession(context: { readonly cwd: string }, sessionId: string, approvalWitness: string) {
        fs.writeFileSync(path.join(worktreePath, "late.txt"), "arrived after application check\n");
        return super.discardSession(context, sessionId, approvalWitness);
      }
    }

    const started = await startControlServer({
      port: 0,
      backend: new ChangedAfterApplicationCheckBackend(),
      catalogPath,
    });
    assert.equal(started.ok, true);
    if (!started.ok) return;
    closeServer = () => started.value.close();
    const token = fs.readFileSync(started.value.credentialFile, "utf8").trim();
    const key = repositoryKey(session.repositoryId);
    const sessionUrl = new URL(
      `/api/v1/repositories/${key}/sessions/${session.sessionId}`,
      started.value.url,
    ).toString();
    const sessionRead = await fetch(sessionUrl, { headers: { [CONTROL_TOKEN_HEADER]: token } });
    assert.equal(sessionRead.status, 200);
    const sessionBody = (await sessionRead.json()) as {
      action_snapshot: { token: unknown; diagnostic: { next_actions: readonly { action_id: string }[] } };
    };
    assert.ok(
      sessionBody.action_snapshot.diagnostic.next_actions.some((action) => action.action_id === "discard-session"),
    );
    const actionToken = sessionBody.action_snapshot.token;
    const actionsUrl = `${sessionUrl}/actions`;
    const postAction = (body: unknown) =>
      fetch(actionsUrl, {
        method: "POST",
        headers: {
          [CONTROL_TOKEN_HEADER]: token,
          origin: new URL(started.value.url).origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const previewResponse = await postAction({
      action_id: "discard-session",
      token: actionToken,
      confirmation: { confirmed: false },
    });
    assert.equal(previewResponse.status, 200);
    const previewBody = (await previewResponse.json()) as {
      result: { status: string; token: unknown; preview: unknown };
    };
    assert.equal(previewBody.result.status, "confirmation-required");

    const rejectedResponse = await postAction({
      action_id: "discard-session",
      token: previewBody.result.token,
      confirmation: { confirmed: true, operation_id: "changed-http-discard", preview: previewBody.result.preview },
    });
    assert.equal(rejectedResponse.status, 409);
    const rejectedBody = (await rejectedResponse.json()) as { error: { code: string } };
    assert.equal(rejectedBody.error.code, "STALE_REGISTRY");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(registry.listClaims(session.sessionId).length, 1);
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(fs.existsSync(path.join(worktreePath, "approved.txt")), true);
    assert.equal(fs.existsSync(path.join(worktreePath, "late.txt")), true);
    assert.equal(git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]), "");
  } finally {
    await closeServer?.();
    try {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repositoryPath,
        stdio: "ignore",
      });
    } catch {
      // The directory cleanup below is sufficient when Git cannot remove it.
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
