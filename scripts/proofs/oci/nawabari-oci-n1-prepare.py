#!/usr/bin/env python3
"""Prepare one fresh bounded target and retain a live sibling for N1 proof.

This performs no sandbox payload execution. It creates a narrowly scoped
repository profile/fixture commit, then provisions a distinct target through
`nawabari session create` with versioned scope/working-set artifacts and
atomic initial claims. The sibling is supplied by its existing public session
ID and must already be active in a distinct worktree. Run only against the
disposable g4 OCI.
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import uuid

PROFILE_ID = "oci-n1-physical-v2"
OWNED_FILE = "nawabari-n1-owned-proof-v2.txt"
STALE_TRIGGER_FILE = "nawabari-n1-stale-trigger-v2.txt"
BASE_SENTINEL = "OCI_NAWABARI_N1_OWNED_WRITE_BASE_V2\n"
STALE_SENTINEL = "OCI_NAWABARI_N1_STALE_TRIGGER_BASE_V2\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--podman-wrapper", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--nawabari", default="/opt/nawabari/node_modules/.bin/nawabari")
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--package-tar", required=True)
    parser.add_argument("--installed-proof", required=True)
    parser.add_argument("--package-sha256", required=True)
    parser.add_argument("--sibling-session", required=True, help="Existing active sibling to preserve during target proof")
    parser.add_argument(
        "--governed-body",
        default="/home/sophia/src/mottainai-next/docs/planning/oci-recovery/nawabari-producer-repair.md",
    )
    args = parser.parse_args()

    if not (len(args.package_sha256) == 64 and all(char in "0123456789abcdef" for char in args.package_sha256)):
        parser.error("--package-sha256 must be lowercase SHA-256 hex")
    package_tar = pathlib.Path(args.package_tar)
    digest = hashlib.sha256(package_tar.read_bytes()).hexdigest()
    if digest != args.package_sha256:
        parser.error(f"package tarball digest differs: expected {args.package_sha256}, got {digest}")
    installed_proof = json.loads(pathlib.Path(args.installed_proof).read_text())
    proof_digest = installed_proof.get("sha256", installed_proof.get("tar_sha256"))
    proof_result = installed_proof.get("result")
    if proof_digest != digest or (proof_result is not None and proof_result != "passed"):
        parser.error("installed package integrity proof does not match the exact local tarball")
    governed = pathlib.Path(args.governed_body).read_bytes()
    governed_digest = hashlib.sha256(governed).hexdigest()

    evidence = pathlib.Path(args.evidence)
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    env = [
        "env",
        "-i",
        "HOME=/root",
        "PATH=/opt/node-v24.17.0/bin:/usr/bin:/bin",
        "NAWABARI_FHS_NODE_EXECUTABLE=/opt/node-v24.17.0/bin/node",
        "NAWABARI_FHS_GIT_EXECUTABLE=/usr/bin/git",
        "NAWABARI_FHS_LS_EXECUTABLE=/usr/bin/ls",
    ]
    prefix = [args.podman_wrapper, "exec", "--workdir", args.repository, args.container_id, *env]
    failures: list[str] = []

    def save(name: str, data: bytes) -> None:
        (evidence / name).write_bytes(data)

    def container(name: str, *argv: str, input_bytes: bytes | None = None, timeout: int = 30) -> subprocess.CompletedProcess[bytes]:
        command = (
            [args.podman_wrapper, "exec", "-i", "--workdir", args.repository, args.container_id, *env, *argv]
            if input_bytes is not None
            else [*prefix, *argv]
        )
        result = subprocess.run(command, input=input_bytes, capture_output=True, timeout=timeout, check=False)
        save(f"{name}.stdout", result.stdout)
        save(f"{name}.stderr", result.stderr)
        save(f"{name}.argv.json", json.dumps(command).encode() + b"\n")
        return result

    def cli(name: str, *argv: str, timeout: int = 45) -> tuple[subprocess.CompletedProcess[bytes], dict | None]:
        result = container(name, args.nawabari, "--json", *argv, timeout=timeout)
        try:
            document = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            document = None
        return result, document

    def cli_ok(name: str, *argv: str, timeout: int = 45) -> dict:
        result, document = cli(name, *argv, timeout=timeout)
        if result.returncode != 0 or not isinstance(document, dict) or document.get("ok") is not True:
            raise RuntimeError(
                f"{name} failed: exit={result.returncode}, code={document.get('code') if isinstance(document, dict) else 'unparseable'}"
            )
        return document

    def find(value: object, key: str) -> object | None:
        if isinstance(value, dict):
            if key in value:
                return value[key]
            for child in value.values():
                found = find(child, key)
                if found is not None:
                    return found
        elif isinstance(value, list):
            for child in value:
                found = find(child, key)
                if found is not None:
                    return found
        return None

    try:
        running = subprocess.run(
            [args.podman_wrapper, "inspect", "--format", "{{.State.Running}}", args.container_id],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("container-running-before.stdout", running.stdout)
        save("container-running-before.stderr", running.stderr)
        if running.returncode != 0 or running.stdout.strip() != b"true":
            raise RuntimeError("selected repository OCI container is not observed running")

        status = container("repository-status-before", "git", "status", "--porcelain=v1", "--branch")
        if status.returncode != 0 or status.stdout.splitlines()[0] != b"## main":
            raise RuntimeError("test repository must be clean on branch main before bounded setup")
        if any(line and not line.startswith(b"## ") for line in status.stdout.splitlines()[1:]):
            raise RuntimeError("test repository has unrelated changes; refusing to commit over them")
        base_head_result = container("repository-head-before", "git", "rev-parse", "HEAD")
        if base_head_result.returncode != 0:
            raise RuntimeError("could not resolve repository base HEAD")
        base_head = base_head_result.stdout.decode().strip()

        minimal = cli_ok("builtin-minimal-profile", "profile", "show", "--profile", "builtin:minimal").get("profile")
        if not isinstance(minimal, dict):
            raise RuntimeError("builtin:minimal did not return a runtime profile")
        profile = json.loads(json.dumps(minimal))
        profile["id"] = PROFILE_ID
        profile["version"] = "1"
        profile["extends"] = []
        profile["filesystem"] = {
            "readOnly": ["README.md", STALE_TRIGGER_FILE],
            "write": [OWNED_FILE],
            "create": [],
            "delete": [],
            "deny": [".git/**"],
            "immutable": [".git/**"],
        }

        profile_result = container("repository-profile-json", "git", "show", "HEAD:nawabari.profiles.json")
        if profile_result.returncode != 0:
            raise RuntimeError("repository profile file is not present at HEAD")
        profiles_doc = json.loads(profile_result.stdout)
        profiles = profiles_doc.get("profiles") if isinstance(profiles_doc, dict) else None
        if not isinstance(profiles, list):
            raise RuntimeError("repository profile file does not contain a profiles array")
        profiles_doc["profiles"] = [entry for entry in profiles if not (isinstance(entry, dict) and entry.get("id") == PROFILE_ID)] + [profile]

        for fixture_path, expected in ((OWNED_FILE, BASE_SENTINEL), (STALE_TRIGGER_FILE, STALE_SENTINEL)):
            fixture_result = container(
                f"repository-fixture-before-{fixture_path}", "git", "show", f"HEAD:{fixture_path}"
            )
            if fixture_result.returncode == 0:
                if fixture_result.stdout != expected.encode():
                    raise RuntimeError(f"{fixture_path} already exists with unexpected content")
                raise RuntimeError(f"{fixture_path} already exists at HEAD; refusing to reuse a prior proof fixture")
            if b"does not exist" not in fixture_result.stderr and b"exists on disk" not in fixture_result.stderr:
                raise RuntimeError(f"could not determine whether the bounded fixture {fixture_path} exists")
            worktree_result = container(
                f"repository-worktree-fixture-before-{fixture_path}",
                "node",
                "-e",
                "const fs=require('node:fs');process.exit(fs.existsSync(process.argv[1])?1:0)",
                fixture_path,
            )
            if worktree_result.returncode != 0:
                raise RuntimeError(f"{fixture_path} already exists in the repository worktree")

        setup_input = json.dumps(
            {"profiles": profiles_doc, "fixtures": {OWNED_FILE: BASE_SENTINEL, STALE_TRIGGER_FILE: STALE_SENTINEL}},
            separators=(",", ":"),
        ).encode()
        writer_script = (
            "const fs=require('node:fs');const v=JSON.parse(fs.readFileSync(0,'utf8'));"
            "fs.writeFileSync('nawabari.profiles.json',JSON.stringify(v.profiles)+'\\n',{mode:0o600});"
            "for(const [name,content] of Object.entries(v.fixtures))fs.writeFileSync(name,content,{mode:0o600});"
        )
        writer = container("repository-profile-and-fixture-write", "node", "-e", writer_script, input_bytes=setup_input)
        if writer.returncode != 0:
            raise RuntimeError("could not install bounded profile and write fixture")
        added = container(
            "repository-profile-and-fixture-add", "git", "add", "nawabari.profiles.json", OWNED_FILE, STALE_TRIGGER_FILE
        )
        if added.returncode != 0:
            raise RuntimeError("could not stage bounded profile and write fixture")
        staged = container("repository-profile-and-fixture-diff", "git", "diff", "--cached", "--quiet")
        if staged.returncode == 1:
            commit = container(
                "repository-profile-and-fixture-commit",
                "git",
                "-c",
                "user.name=OCI N1 Proof",
                "-c",
                "user.email=oci-n1-proof@example.invalid",
                "commit",
                "-m",
                "prepare bounded Nawabari N1 physical proof profile",
            )
            if commit.returncode != 0:
                raise RuntimeError("could not commit the bounded physical proof profile")
        elif staged.returncode != 0:
            raise RuntimeError("could not inspect staged bounded profile changes")
        current_head_result = container("repository-head-after-setup", "git", "rev-parse", "HEAD")
        if current_head_result.returncode != 0:
            raise RuntimeError("could not resolve prepared repository base HEAD")
        revision = current_head_result.stdout.decode().strip()
        branch_result = container("repository-branch-after-setup", "git", "branch", "--show-current")
        if branch_result.returncode != 0 or branch_result.stdout.strip() != b"main":
            raise RuntimeError("bounded profile setup unexpectedly changed the repository branch")

        profile_status = cli_ok("prepared-profile-show", "profile", "show", "--profile", f"repository:{PROFILE_ID}")
        repository_identity = {"repositoryHost": "local", "repositoryId": f"{args.repository}/.git"}
        authorization = {
            "version": 1,
            "kind": "implementation-authorization",
            "contractVersion": 1,
            "implementation": {**repository_identity, "number": 6},
            "governedBodyDigest": governed_digest,
        }
        common_scope = {
            "version": 1,
            "kind": "implementation-execution-scope",
            "authorization": authorization,
            "repository": repository_identity,
            "base": {"branch": "main", "revision": revision},
        }
        def candidate_working_set(suffix: str, entries: list[dict]) -> dict:
            return {
                "kind": "candidate-working-set",
                "schemaVersion": 1,
                "workingSetId": f"oci-n1-physical-{suffix}-{uuid.uuid4()}",
                "repository": {**repository_identity, "repository": "local/oci-recovery-disposable"},
                "revision": revision,
                "entries": entries,
            }

        proof_evidence = [{"artifact": "approved-nawabari-producer-repair-plan", "reference": governed_digest}]
        def entry(locator: str, summary: str, state: str = "required") -> dict:
            return {
                "state": state,
                "target": {"kind": "file", "locator": locator},
                "reason": {"id": "oci-recovery:n1-physical-proof", "summary": summary},
                "evidence": proof_evidence,
            }

        def write_artifact(name: str, value: dict) -> str:
            remote = f"/tmp/nawabari-n1-{uuid.uuid4()}.json"
            payload = json.dumps(value, separators=(",", ":")).encode()
            save(f"{name}.json", json.dumps(value, indent=2).encode() + b"\n")
            write = container(
                f"{name}-container-write",
                "node",
                "-e",
                "const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readFileSync(0),{mode:0o600})",
                remote,
                input_bytes=payload,
            )
            if write.returncode != 0:
                raise RuntimeError(f"could not write {name} request artifact")
            return remote

        def create_target_session() -> dict:
            scope = {
                **common_scope,
                "scope": {
                    "readOnly": ["README.md", STALE_TRIGGER_FILE],
                    "write": [OWNED_FILE],
                    "create": [],
                    "delete": [],
                    "deny": [],
                },
            }
            entries = [entry("README.md", "Required bounded read for strict Git and repository proof")]
            entries.append(
                entry(STALE_TRIGGER_FILE, "Bounded path used to advance the session claim generation", state="supporting")
            )
            entries.append(entry(OWNED_FILE, "Owner-claimed session-local strict write proof", state="supporting"))
            working_set = candidate_working_set("target", entries)
            scope_path = write_artifact("target-execution-scope", scope)
            working_path = write_artifact("target-candidate-working-set", working_set)
            argv = [
                "session",
                "create",
                "--base",
                "main",
                "--profile",
                f"repository:{PROFILE_ID}",
                "--execution-scope-file",
                scope_path,
                "--candidate-working-set-file",
                working_path,
            ]
            argv.extend(["--resource", "README.md", "--mode", "read", "--resource", OWNED_FILE, "--mode", "write"])
            argv.append("--enforce-claims")
            document = cli_ok("target-session-create", *argv, timeout=120)
            session = find(document, "session")
            if not isinstance(session, dict) and isinstance(document.get("session_id"), str):
                session = document
            if not isinstance(session, dict) or not isinstance(session.get("session_id"), str):
                raise RuntimeError("target session creation omitted canonical session identity")
            show = cli_ok("target-session-show", "session", "show", "--session", session["session_id"])
            record = find(show, "session")
            if not isinstance(record, dict) and isinstance(show.get("session_id"), str):
                record = show
            if not isinstance(record, dict):
                raise RuntimeError("target session show omitted its owner record")
            snapshot_doc = cli_ok("target-initial-verification-snapshot", "verification", "snapshot", "--session", session["session_id"])
            snapshot = snapshot_doc.get("snapshot")
            if not isinstance(snapshot, dict):
                raise RuntimeError("target snapshot omitted its currentness token")
            return {"create": document, "session": record, "snapshot": snapshot, "scope": scope, "working_set": working_set}

        def create_drain_probe_session() -> dict:
            scope = {
                **common_scope,
                "scope": {"readOnly": ["README.md"], "write": [], "create": [], "delete": [], "deny": []},
            }
            working_set = candidate_working_set(
                "drain-probe", [entry("README.md", "Atomic read claim for physical empty-session drain proof")]
            )
            scope_path = write_artifact("drain-probe-execution-scope", scope)
            working_path = write_artifact("drain-probe-candidate-working-set", working_set)
            document = cli_ok(
                "drain-probe-session-create",
                "session",
                "create",
                "--base",
                "main",
                "--profile",
                "builtin:minimal",
                "--execution-scope-file",
                scope_path,
                "--candidate-working-set-file",
                working_path,
                "--resource",
                "README.md",
                "--mode",
                "read",
                "--enforce-claims",
                timeout=120,
            )
            session = find(document, "session")
            if not isinstance(session, dict) and isinstance(document.get("session_id"), str):
                session = document
            if not isinstance(session, dict) or not isinstance(session.get("session_id"), str):
                raise RuntimeError("drain probe session creation omitted canonical session identity")
            show = cli_ok("drain-probe-session-show", "session", "show", "--session", session["session_id"])
            record = find(show, "session")
            if not isinstance(record, dict) and isinstance(show.get("session_id"), str):
                record = show
            if not isinstance(record, dict):
                raise RuntimeError("drain probe show omitted its owner record")
            snapshot_doc = cli_ok(
                "drain-probe-initial-verification-snapshot", "verification", "snapshot", "--session", session["session_id"]
            )
            snapshot = snapshot_doc.get("snapshot")
            if not isinstance(snapshot, dict):
                raise RuntimeError("drain probe snapshot omitted its currentness token")
            return {"create": document, "session": record, "snapshot": snapshot, "scope": scope, "working_set": working_set}

        target = create_target_session()
        drain_probe = create_drain_probe_session()
        sibling_show = cli_ok("preserved-sibling-session-show", "session", "show", "--session", args.sibling_session)
        sibling_session = find(sibling_show, "session")
        if not isinstance(sibling_session, dict) and isinstance(sibling_show.get("session_id"), str):
            sibling_session = sibling_show
        if not isinstance(sibling_session, dict) or sibling_session.get("state") != "active":
            raise RuntimeError("the explicitly supplied sibling is not observed active")
        if sibling_session.get("repository") != f"{args.repository}/.git":
            raise RuntimeError("the explicitly supplied sibling belongs to another repository")
        sibling_snapshot_doc = cli_ok(
            "preserved-sibling-verification-snapshot", "verification", "snapshot", "--session", args.sibling_session
        )
        sibling_snapshot = sibling_snapshot_doc.get("snapshot")
        if not isinstance(sibling_snapshot, dict):
            raise RuntimeError("the preserved sibling snapshot omitted its currentness token")
        sibling = {"session": sibling_session, "snapshot": sibling_snapshot}
        target_session = target["session"]
        drain_probe_session = drain_probe["session"]
        sibling_session = sibling["session"]
        session_ids = {target_session.get("session_id"), drain_probe_session.get("session_id"), sibling_session.get("session_id")}
        worktrees = {target_session.get("worktree"), drain_probe_session.get("worktree"), sibling_session.get("worktree")}
        if len(session_ids) != 3 or None in session_ids:
            raise RuntimeError("public session owners did not return three distinct session IDs")
        if len(worktrees) != 3 or None in worktrees:
            raise RuntimeError("public session owners did not return three distinct worktree paths")
        manifest = {
            "schema_version": 1,
            "prepared_at_unix": time.time(),
            "container_id": args.container_id,
            "repository": args.repository,
            "repository_branch_before": "main",
            "repository_head_before": base_head,
            "repository_branch_after": "main",
            "repository_head_after": revision,
            "governed_body_digest": governed_digest,
            "profile_id": f"repository:{PROFILE_ID}",
            "profile": profile,
            "package_sha256": digest,
            "installed_proof": installed_proof,
            "owned_file": OWNED_FILE,
            "stale_trigger_file": STALE_TRIGGER_FILE,
            "sibling_reused": True,
            "target": target,
            "drain_probe": drain_probe,
            "sibling": sibling,
        }
        (evidence / "session-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        (evidence / "result.json").write_text(json.dumps({"result": "prepared", "failures": failures}, indent=2) + "\n")
        print(json.dumps({
            "result": "prepared",
            "package_sha256": digest,
            "target_session_id": target_session["session_id"],
            "target_worktree": target_session.get("worktree"),
            "drain_probe_session_id": drain_probe_session["session_id"],
            "drain_probe_worktree": drain_probe_session.get("worktree"),
            "sibling_session_id": sibling_session["session_id"],
            "sibling_worktree": sibling_session.get("worktree"),
            "base_revision": revision,
        }, indent=2))
        return 0
    except Exception as error:
        (evidence / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
        print(f"bounded session preparation blocked: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
