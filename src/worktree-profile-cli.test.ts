import assert from "node:assert/strict";
import test from "node:test";

import { STRICT_RUNTIME_POLICY } from "./domain/runtime-projection.js";
import {
  listWorktreeProfiles,
  parseWorktreeProfileCliArguments,
  parseWorktreeProfileOptions,
  requireWorktreeProfileReady,
  resolveWorktreeProfileCliRequest,
  resolveWorktreeProfileSessionCreate,
  serializeWorktreeProfileCli,
  serializeWorktreeProfileContract,
  showWorktreeProfile,
  WORKTREE_PROFILE_CLI_SERIALIZATION_KEY,
  WORKTREE_PROFILE_CONTRACT_SERIALIZATION_KEY,
} from "./worktree-profile-cli.js";

function repositoryProfile(id = "repository-profile") {
  return {
    profiles: [
      {
        id,
        version: "1",
        extends: [],
        materialSelection: { profiles: ["development"], operations: [] },
        filesystem: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [], immutable: [] },
        tools: [{ entrypoint: "node", provider: { id: "fhs-node-runtime-provider", requirement_id: "node-runtime" } }],
        shell: { entrypoint: "node" },
        environment: {
          home: "session",
          xdg: { config: "session", cache: "session", data: "session", state: "session" },
          tmp: "execution",
        },
        git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
        execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "required" },
      },
    ],
  };
}

test("profile-owned parsing preserves omitted session bootstrap and typed JSON parameters", () => {
  assert.deepEqual(parseWorktreeProfileCliArguments(["session", "create"]), {
    ok: true,
    value: { command: "session create", profile: null, parameters: null },
  });
  const parsed = parseWorktreeProfileCliArguments([
    "session",
    "create",
    "--profile",
    "builtin:minimal",
    "--profile-parameter",
    '{"shell.entrypoint":"node"}',
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.command, "session create");
    assert.equal(parsed.value.profile, "builtin:minimal");
    assert.deepEqual(parsed.value.parameters, { "shell.entrypoint": "node" });
  }
  const unrelated = parseWorktreeProfileOptions(["--profile", "minimal"]);
  assert.deepEqual(unrelated, { ok: true, value: { profile: "minimal", parameters: null } });
});

test("profile option usage errors are bounded and deterministic", () => {
  const malformedJson = parseWorktreeProfileCliArguments(["session", "create", "--profile-parameter", "[]"]);
  assert.equal(malformedJson.ok, false);
  if (!malformedJson.ok) {
    assert.equal(malformedJson.error.code, "INVALID_ARGUMENT");
    assert.match(malformedJson.error.message, /JSON object/u);
  }
  const missingShow = parseWorktreeProfileCliArguments(["profile", "show"]);
  assert.equal(missingShow.ok, false);
  if (!missingShow.ok) assert.equal(missingShow.error.code, "MISSING_ARGUMENT");
  const badOption = parseWorktreeProfileCliArguments(["profile", "list", "--profile", "minimal"]);
  assert.equal(badOption.ok, false);
  if (!badOption.ok) assert.equal(badOption.error.code, "INVALID_ARGUMENT");
});

test("list and show expose explicit namespaces and preserve collisions", () => {
  const listed = listWorktreeProfiles({ repository: repositoryProfile("minimal") });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  assert.deepEqual(
    listed.value.profiles.map((profile) => profile.reference),
    ["builtin:minimal", "builtin:standard-shell", "repository:minimal"],
  );
  assert.ok(listed.value.profiles.every((profile) => profile.collision === (profile.id === "minimal")));

  const ambiguous = showWorktreeProfile("minimal", { repository: repositoryProfile("minimal") });
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.error.code, "RUNTIME_PROFILE_AMBIGUOUS");
  const builtin = showWorktreeProfile("builtin:minimal", { repository: repositoryProfile("minimal") });
  assert.equal(builtin.ok, true);
  if (builtin.ok) {
    assert.equal(builtin.value.source.reference, "builtin:minimal");
    assert.equal(builtin.value.ready, true);
  }
  const shell = showWorktreeProfile("builtin:standard-shell");
  assert.equal(shell.ok, true);
  if (shell.ok) {
    assert.equal(shell.value.ready, false);
    assert.deepEqual(shell.value.missing, ["bash-runtime"]);
    assert.equal(requireWorktreeProfileReady(shell.value).ok, false);
  }
});

test("profile readiness keeps material, sandbox, and managed bootstrap separate", () => {
  const inspection = { sandboxReadiness: () => true, managedExecutionReadiness: () => ({ ready: false }) };
  const minimal = showWorktreeProfile("builtin:minimal", inspection);
  assert.equal(minimal.ok, true);
  if (!minimal.ok) return;
  assert.equal(minimal.value.ready, true);
  assert.deepEqual(minimal.value.readiness.definition, { ready: true });
  assert.equal(minimal.value.readiness.material.ready, true);
  assert.equal(minimal.value.readiness.sandbox.ready, true);
  assert.deepEqual(minimal.value.readiness.managed_execution, { process_tracking: "required", ready: false });
  assert.deepEqual(minimal.value.readiness.bootstrap, {
    ready: false,
    blocker_code: "SANDBOX_CAPABILITY_UNAVAILABLE",
  });

  const listed = listWorktreeProfiles(inspection);
  assert.equal(listed.ok, true);
  if (listed.ok) {
    assert.deepEqual(listed.value.profiles[0]?.readiness.bootstrap, minimal.value.readiness.bootstrap);
    const shell = listed.value.profiles.find((profile) => profile.id === "standard-shell");
    assert.equal(shell?.readiness.material.ready, false);
    assert.deepEqual(shell?.readiness.material.missing, ["bash-runtime"]);
    assert.equal(shell?.readiness.bootstrap.blocker_code, "RUNTIME_MATERIALIZATION_MISSING");
  }
  const omitted = resolveWorktreeProfileSessionCreate({ command: "session create", profile: null, parameters: null });
  assert.equal(omitted.ok, true);
  if (omitted.ok) assert.equal(omitted.value.profile, null);

  const repository = showWorktreeProfile("repository:repository-profile", {
    ...inspection,
    repository: repositoryProfile(),
  });
  assert.equal(repository.ok, true);
  if (repository.ok) {
    assert.equal(repository.value.readiness.material.availability, "unknown");
    assert.deepEqual(repository.value.readiness.bootstrap, {
      ready: false,
      blocker_code: "SANDBOX_CAPABILITY_UNAVAILABLE",
    });
  }
  const repositoryManagedReady = showWorktreeProfile("repository:repository-profile", {
    repository: repositoryProfile(),
    sandboxReadiness: () => true,
    managedExecutionReadiness: () => ({ ready: true }),
  });
  assert.equal(repositoryManagedReady.ok, true);
  if (repositoryManagedReady.ok) {
    assert.deepEqual(repositoryManagedReady.value.readiness.bootstrap, { ready: null, blocker_code: null });
  }
});

test("profile list retains unresolved declarations and reports their resolution blocker", () => {
  const repository = { profiles: [{ ...repositoryProfile().profiles[0], extends: ["missing-parent"] }] };
  const listed = listWorktreeProfiles({
    repository,
    sandboxReadiness: () => true,
    managedExecutionReadiness: () => ({ ready: false }),
  });
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const profile = listed.value.profiles.find((candidate) => candidate.reference === "repository:repository-profile");
  assert.equal(profile?.readiness.definition.ready, true);
  assert.deepEqual(profile?.readiness.resolution, { ready: false, blocker_code: "RUNTIME_PROFILE_MISSING" });
  assert.equal(profile?.readiness.bootstrap.blocker_code, "RUNTIME_PROFILE_MISSING");
});

test("unknown profile and parameter failures use the same backend resolver", () => {
  const unknown = resolveWorktreeProfileSessionCreate(
    { command: "session create", profile: "builtin:missing", parameters: null },
    {},
  );
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "RUNTIME_PROFILE_MISSING");
  const parameter = resolveWorktreeProfileSessionCreate(
    { command: "session create", profile: "builtin:minimal", parameters: { "not-allowed": true } },
    {},
  );
  assert.equal(parameter.ok, false);
  if (!parameter.ok) assert.equal(parameter.error.code, "RUNTIME_PROFILE_INVALID");
  const unknownMaterial = resolveWorktreeProfileSessionCreate(
    {
      command: "session create",
      profile: "builtin:minimal",
      parameters: { "materialSelection.profiles": ["missing-runtime-profile"] },
    },
    {},
  );
  assert.equal(unknownMaterial.ok, false);
  if (!unknownMaterial.ok) assert.equal(unknownMaterial.error.code, "RUNTIME_PROFILE_MISSING");
  const shared = resolveWorktreeProfileCliRequest(
    { command: "session create", profile: "builtin:minimal", parameters: { "not-allowed": true } },
    {},
  );
  assert.equal(shared.ok, false);
  if (!shared.ok) assert.equal(shared.error.code, "RUNTIME_PROFILE_INVALID");
  const omitted = resolveWorktreeProfileSessionCreate({ command: "session create", profile: null, parameters: null });
  assert.equal(omitted.ok, true);
  if (omitted.ok) {
    assert.equal(omitted.value.profile, null);
    assert.equal(requireWorktreeProfileReady(omitted.value).ok, true);
  }
});

test("builtin readiness fails closed when selected material omits a declared executable", () => {
  const resolution = resolveWorktreeProfileSessionCreate(
    {
      command: "session create",
      profile: "builtin:minimal",
      parameters: { "materialSelection.profiles": ["base"] },
    },
    {},
  );
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.notEqual(resolution.value.profile, null);
  if (resolution.value.profile === null) return;
  assert.equal(resolution.value.profile.availability, "missing");
  assert.equal(resolution.value.profile.ready, false);
  assert.deepEqual(resolution.value.profile.missing, ["git-package", "ls-runtime"]);
  const readiness = requireWorktreeProfileReady(resolution.value);
  assert.equal(readiness.ok, false);
  if (!readiness.ok) assert.equal(readiness.error.code, "RUNTIME_MATERIALIZATION_MISSING");
});

test("repository readiness remains fail-closed while materialization is unknown", () => {
  const resolution = resolveWorktreeProfileSessionCreate(
    { command: "session create", profile: "repository:repository-profile", parameters: null },
    { repository: repositoryProfile() },
  );
  assert.equal(resolution.ok, true);
  if (!resolution.ok) return;
  assert.notEqual(resolution.value.profile, null);
  if (resolution.value.profile === null) return;
  assert.equal(resolution.value.profile.availability, "unknown");
  assert.equal(resolution.value.profile.ready, false);
  const readiness = requireWorktreeProfileReady(resolution.value);
  assert.equal(readiness.ok, false);
  if (!readiness.ok) assert.equal(readiness.error.code, "RUNTIME_MATERIALIZATION_MISSING");

  const shown = showWorktreeProfile("repository:repository-profile", { repository: repositoryProfile() });
  assert.equal(shown.ok, true);
  if (shown.ok) {
    assert.equal(shown.value.availability, "unknown");
    assert.equal(shown.value.ready, false);
    const showReadiness = requireWorktreeProfileReady(shown.value);
    assert.equal(showReadiness.ok, false);
    if (!showReadiness.ok) assert.equal(showReadiness.error.code, "RUNTIME_MATERIALIZATION_MISSING");
  }
});

test("CLI and profile contract serializers use separate stable keys", () => {
  const response = listWorktreeProfiles();
  assert.equal(response.ok, true);
  if (!response.ok) return;
  const cli = serializeWorktreeProfileCli(response.value);
  assert.equal(cli.ok, true);
  if (cli.ok) assert.deepEqual(Object.keys(JSON.parse(cli.value)), [WORKTREE_PROFILE_CLI_SERIALIZATION_KEY]);
  const shown = showWorktreeProfile("minimal");
  assert.equal(shown.ok, true);
  if (!shown.ok) return;
  const contract = serializeWorktreeProfileContract(shown.value.profile);
  assert.equal(contract.ok, true);
  if (contract.ok) {
    assert.deepEqual(Object.keys(JSON.parse(contract.value)), [WORKTREE_PROFILE_CONTRACT_SERIALIZATION_KEY]);
  }
});
