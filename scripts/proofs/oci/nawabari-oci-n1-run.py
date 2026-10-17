#!/usr/bin/env python3
"""Bounded public-CLI N1 proof for strict OCI execution and owned cancellation.

This script is intentionally not run until the matching immutable Nawabari
artifact is installed in the selected disposable OCI container. It consumes
the fresh target and existing live sibling created/selected by
`nawabari-oci-n1-prepare.py` through Nawabari's public CLI. It never uses host
process signalling or stops/restarts the repository container, and it leaves
the supplied sibling session active.
"""

import argparse
import base64
import hashlib
import json
import pathlib
import subprocess
import sys
import time
import uuid


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--podman-wrapper", required=True)
    parser.add_argument("--container-id", required=True)
    parser.add_argument("--repository", required=True, help="Repository path inside the container")
    parser.add_argument("--sessions-manifest", required=True, help="Public-CLI bounded session preparation manifest")
    parser.add_argument("--evidence", required=True)
    parser.add_argument("--nawabari", default="/opt/nawabari/node_modules/.bin/nawabari")
    parser.add_argument("--package-tar", required=True, help="Exact local Nawabari tarball installed in this consumer")
    parser.add_argument("--installed-proof", required=True, help="Installer-produced exact artifact integrity proof")
    parser.add_argument("--package-sha256", required=True, help="SHA-256 of the exact installed package tarball")
    parser.add_argument("--timeout-seconds", type=int, default=20)
    args = parser.parse_args()

    if not (len(args.package_sha256) == 64 and all(char in "0123456789abcdef" for char in args.package_sha256)):
        parser.error("--package-sha256 must be lowercase SHA-256 hex")
    actual_digest = hashlib.sha256(pathlib.Path(args.package_tar).read_bytes()).hexdigest()
    if actual_digest != args.package_sha256:
        parser.error(f"package tarball digest differs: expected {args.package_sha256}, got {actual_digest}")
    installed_proof = json.loads(pathlib.Path(args.installed_proof).read_text())
    proof_digest = installed_proof.get("sha256", installed_proof.get("tar_sha256"))
    proof_result = installed_proof.get("result")
    if proof_digest != actual_digest or (proof_result is not None and proof_result != "passed"):
        parser.error("installed package integrity proof does not match the exact local tarball")
    manifest_path = pathlib.Path(args.sessions_manifest)
    session_manifest = json.loads(manifest_path.read_text())
    if (
        session_manifest.get("package_sha256") != actual_digest
        or session_manifest.get("container_id") != args.container_id
        or session_manifest.get("repository") != args.repository
    ):
        parser.error("bounded session manifest does not match the exact package/container/repository candidate")
    target_record = session_manifest.get("target", {}).get("session")
    drain_probe_record = session_manifest.get("drain_probe", {}).get("session")
    sibling_record = session_manifest.get("sibling", {}).get("session")
    owned_file = session_manifest.get("owned_file")
    stale_trigger_file = session_manifest.get("stale_trigger_file")
    if owned_file != "nawabari-n1-owned-proof-v3.txt" or stale_trigger_file != "nawabari-n1-stale-trigger-v3.txt":
        parser.error("bounded session manifest does not contain the reviewed v3 proof fixture paths")
    args.session = target_record.get("session_id") if isinstance(target_record, dict) else None
    args.drain_probe_session = drain_probe_record.get("session_id") if isinstance(drain_probe_record, dict) else None
    args.sibling_session = sibling_record.get("session_id") if isinstance(sibling_record, dict) else None
    target_worktree = target_record.get("worktree") if isinstance(target_record, dict) else None
    drain_probe_worktree = drain_probe_record.get("worktree") if isinstance(drain_probe_record, dict) else None
    sibling_worktree = sibling_record.get("worktree") if isinstance(sibling_record, dict) else None
    if (
        not isinstance(args.session, str)
        or not isinstance(args.drain_probe_session, str)
        or not isinstance(args.sibling_session, str)
        or len({args.session, args.drain_probe_session, args.sibling_session}) != 3
        or not isinstance(target_worktree, str)
        or not isinstance(drain_probe_worktree, str)
        or not isinstance(sibling_worktree, str)
        or len({target_worktree, drain_probe_worktree, sibling_worktree}) != 3
    ):
        parser.error("bounded session manifest omits distinct target/drain-probe/sibling identities")

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

    def invoke(name: str, argv: list[str], timeout: int = 30) -> tuple[subprocess.CompletedProcess[bytes], dict | None]:
        command = [*prefix, args.nawabari, "--json", *argv]
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        save(f"{name}.stdout", result.stdout)
        save(f"{name}.stderr", result.stderr)
        save(f"{name}.argv.json", json.dumps(command).encode() + b"\n")
        try:
            document = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            document = None
        return result, document

    def invoke_ok(name: str, argv: list[str], timeout: int = 30) -> dict:
        result, document = invoke(name, argv, timeout)
        if result.returncode != 0 or not isinstance(document, dict) or document.get("ok") is not True:
            raise RuntimeError(
                f"{name} failed: exit={result.returncode}, code={document.get('code') if isinstance(document, dict) else 'unparseable'}"
            )
        return document

    def recursively_find(value: object, key: str) -> object | None:
        if isinstance(value, dict):
            if key in value:
                return value[key]
            for child in value.values():
                found = recursively_find(child, key)
                if found is not None:
                    return found
        if isinstance(value, list):
            for child in value:
                found = recursively_find(child, key)
                if found is not None:
                    return found
        return None

    def command_line(argv: list[str]) -> list[str]:
        return [*prefix, args.nawabari, "--json", *argv]

    def launch_persistent(name: str, session_id: str) -> tuple[subprocess.Popen[bytes], pathlib.Path, pathlib.Path]:
        # A finite in-sandbox deadline is a safety bound if owner cancellation
        # is rejected; the host never signals the payload or its descendants.
        child = "setInterval(()=>{},1000)"
        payload = (
            "const {spawn}=require('node:child_process');"
            f"const child=spawn(process.execPath,['-e',{json.dumps(child)}],{{stdio:'ignore'}});"
            "process.stdout.write(JSON.stringify({parent:process.pid,child:child.pid})+'\\n');"
            f"setTimeout(()=>{{try{{child.kill()}}catch{{}};process.exit(0)}},{45000 if name.startswith('target') else 60000});"
            "setInterval(()=>{},1000);"
        )
        command = command_line(
            [
                "session",
                "run",
                "--session",
                session_id,
                "--runtime-policy",
                "strict",
                "--",
                "node",
                "-e",
                payload,
            ]
        )
        stdout_path = evidence / f"{name}.stdout"
        stderr_path = evidence / f"{name}.stderr"
        stdout_file = stdout_path.open("wb")
        stderr_file = stderr_path.open("wb")
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout_file, stderr=stderr_file)
        save(f"{name}.argv.json", json.dumps(command).encode() + b"\n")
        # Keep the file handles reachable until the caller has collected exit.
        setattr(process, "_evidence_files", (stdout_file, stderr_file))
        return process, stdout_path, stderr_path

    def collect_process(process: subprocess.Popen[bytes], name: str, timeout: int = 55) -> int:
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(f"{name} did not return within {timeout}s; no host-side signal was sent") from error
        for handle in getattr(process, "_evidence_files", ()):
            handle.close()
        save(f"{name}.exit.txt", f"{code}\n".encode())
        return code

    def process_snapshot(name: str, session_id: str) -> dict:
        return invoke_ok(name, ["session", "processes", "--session", session_id])

    def execution_ids(document: dict) -> list[str]:
        processes = document.get("processes")
        if not isinstance(processes, list):
            return []
        return sorted(
            item.get("execution", {}).get("execution_id")
            for item in processes
            if isinstance(item, dict) and isinstance(item.get("execution"), dict)
        )

    def complete_raw_streams(value: object) -> tuple[bytes, bytes] | None:
        if not isinstance(value, dict) or value.get("encoding") != "base64" or value.get("complete") is not True or value.get("truncated") is not False:
            return None
        try:
            stdout = base64.b64decode(value.get("stdout", ""), validate=True)
            stderr = base64.b64decode(value.get("stderr", ""), validate=True)
        except (ValueError, TypeError):
            return None
        if value.get("stdout_bytes") != len(stdout) or value.get("stderr_bytes") != len(stderr):
            return None
        if value.get("observed_stdout_bytes") != len(stdout) or value.get("observed_stderr_bytes") != len(stderr):
            return None
        return stdout, stderr

    def active_cgroup(document: dict) -> bool:
        processes = document.get("processes")
        return isinstance(processes, list) and any(
            isinstance(item, dict)
            and isinstance(item.get("cgroups"), dict)
            and item["cgroups"].get("state") == "active"
            and isinstance(item["cgroups"].get("cgroups"), dict)
            and isinstance(item["cgroups"]["cgroups"].get("population"), dict)
            and item["cgroups"]["cgroups"]["population"].get("state") == "populated"
            for item in processes
        )

    def populated_execution_count(document: dict) -> int:
        processes = document.get("processes")
        if not isinstance(processes, list):
            return 0
        return sum(
            1
            for item in processes
            if isinstance(item, dict)
            and isinstance(item.get("cgroups"), dict)
            and item["cgroups"].get("state") == "active"
            and isinstance(item["cgroups"].get("cgroups"), dict)
            and isinstance(item["cgroups"]["cgroups"].get("population"), dict)
            and item["cgroups"]["cgroups"]["population"].get("state") == "populated"
        )

    def wait_active(name: str, session_id: str, process: subprocess.Popen[bytes]) -> dict | None:
        deadline = time.monotonic() + args.timeout_seconds
        latest: dict | None = None
        attempt = 0
        while time.monotonic() < deadline and process.poll() is None:
            attempt += 1
            try:
                latest = process_snapshot(f"{name}-processes-{attempt:02d}", session_id)
                if active_cgroup(latest):
                    return latest
            except (RuntimeError, subprocess.SubprocessError) as error:
                failures.append(f"{name} process observation: {error}")
            time.sleep(0.5)
        return latest

    try:
        (evidence / "run-identity.json").write_text(
            json.dumps(
                {
                    "container_id": args.container_id,
                    "repository": args.repository,
                    "session_id": args.session,
                    "drain_probe_session_id": args.drain_probe_session,
                    "sibling_session_id": args.sibling_session,
                    "target_worktree": target_worktree,
                    "drain_probe_worktree": drain_probe_worktree,
                    "sibling_worktree": sibling_worktree,
                    "sessions_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                    "repository_base_revision": session_manifest.get("repository_head_after"),
                    "package_sha256": args.package_sha256,
                    "installed_proof": installed_proof,
                    "started_at_unix": time.time(),
                },
                indent=2,
            )
            + "\n"
        )
        container_state = subprocess.run(
            [args.podman_wrapper, "inspect", "--format", "{{.State.Running}}", args.container_id],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("container-running-before.stdout", container_state.stdout)
        save("container-running-before.stderr", container_state.stderr)
        if container_state.returncode != 0 or container_state.stdout.strip() != b"true":
            raise RuntimeError("selected repository OCI container is not observed running")

        target_show = invoke_ok("target-session-before-proof", ["session", "show", "--session", args.session])
        drain_probe_show = invoke_ok(
            "drain-probe-session-before-proof", ["session", "show", "--session", args.drain_probe_session]
        )
        sibling_show = invoke_ok("sibling-session-before-proof", ["session", "show", "--session", args.sibling_session])
        target_session = recursively_find(target_show, "session")
        drain_probe_session = recursively_find(drain_probe_show, "session")
        sibling_session = recursively_find(sibling_show, "session")
        if not isinstance(target_session, dict) and isinstance(target_show.get("session_id"), str):
            target_session = target_show
        if not isinstance(drain_probe_session, dict) and isinstance(drain_probe_show.get("session_id"), str):
            drain_probe_session = drain_probe_show
        if not isinstance(sibling_session, dict) and isinstance(sibling_show.get("session_id"), str):
            sibling_session = sibling_show
        if not isinstance(target_session, dict) or target_session.get("state") != "active":
            raise RuntimeError("target public session is not observed active")
        if not isinstance(drain_probe_session, dict) or drain_probe_session.get("state") != "active":
            raise RuntimeError("zero-execution drain probe session is not observed active before its close test")
        if not isinstance(sibling_session, dict) or sibling_session.get("state") != "active":
            raise RuntimeError("sibling public session is not observed active")
        if (
            target_session.get("worktree") != target_worktree
            or drain_probe_session.get("worktree") != drain_probe_worktree
            or sibling_session.get("worktree") != sibling_worktree
        ):
            raise RuntimeError("public session owner records differ from the preparation manifest")

        claims = invoke_ok("target-initial-claims", ["session", "claims", "--session", args.session]).get("claims")
        if not isinstance(claims, list):
            raise RuntimeError("target public session claims response omitted claims")
        normalized_claims = {
            (item.get("resource"), item.get("mode"))
            for item in claims
            if isinstance(item, dict)
        }
        if ("README.md", "read") not in normalized_claims or (owned_file, "write") not in normalized_claims:
            failures.append("target session did not retain its exact atomic initial read/write claims")
        save("target-initial-claims-normalized.json", json.dumps(sorted([list(item) for item in normalized_claims]), indent=2).encode() + b"\n")

        drain_claims = invoke_ok(
            "drain-probe-initial-claims", ["session", "claims", "--session", args.drain_probe_session]
        ).get("claims")
        if not isinstance(drain_claims, list) or not any(
            isinstance(item, dict) and item.get("resource") == "README.md" and item.get("mode") == "read"
            for item in drain_claims
        ):
            failures.append("zero-execution drain probe did not retain its atomic README read claim")
        save("drain-probe-initial-claims.json", json.dumps(drain_claims, indent=2).encode() + b"\n")

        sentinel_id = uuid.uuid4().hex
        boundary_paths = {
            "outer_oci_root": f"/root/nawabari-n1-outer-root-{sentinel_id}",
            "peer_worktree": f"{sibling_worktree}/nawabari-n1-peer-sentinel-{sentinel_id}",
            "control_store": f"{args.repository}/.git/nawabari/session-registry.json",
            "secret": f"/run/nawabari-n1-secret-{sentinel_id}",
        }
        boundary_setup = (
            "const fs=require('node:fs');const p=JSON.parse(process.argv[1]);"
            "fs.writeFileSync(p.outer_oci_root,'N1_OUTER_OCI_ROOT_SENTINEL\\n',{mode:0o600});"
            "fs.writeFileSync(p.peer_worktree,'N1_PEER_WORKTREE_SENTINEL\\n',{mode:0o600});"
            "fs.writeFileSync(p.secret,'N1_SECRET_SENTINEL\\n',{mode:0o600});"
            "const out={};for(const [name,path] of Object.entries(p)){const stat=fs.statSync(path);"
            "out[name]={path,size:stat.size,mode:stat.mode};}process.stdout.write(JSON.stringify(out)+'\\n');"
        )
        setup = subprocess.run(
            [*prefix, "node", "-e", boundary_setup, json.dumps(boundary_paths)],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("boundary-sentinel-setup.stdout", setup.stdout)
        save("boundary-sentinel-setup.stderr", setup.stderr)
        if setup.returncode != 0:
            raise RuntimeError("could not establish existing OCI/peer/control/secret sentinels for the strict boundary proof")
        try:
            sentinel_observation = json.loads(setup.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("sentinel setup did not return a parseable existence observation") from error
        if not isinstance(sentinel_observation, dict) or set(sentinel_observation) != set(boundary_paths):
            raise RuntimeError("sentinel setup did not observe every requested boundary path")
        (evidence / "boundary-sentinel-paths.json").write_text(json.dumps(sentinel_observation, indent=2) + "\n")

        # Preserve an actually running strict sibling while the target is
        # cancelled. Both payloads are finite if owner cancellation fails.
        sibling, _, _ = launch_persistent("sibling-strict-run", args.sibling_session)
        sibling_active = wait_active("sibling", args.sibling_session, sibling)
        if sibling_active is None or not active_cgroup(sibling_active):
            failures.append("sibling strict execution never exposed an active observed owned cgroup")

        drain_before = process_snapshot("drain-probe-processes-before-close", args.drain_probe_session)
        if execution_ids(drain_before):
            failures.append("zero-execution drain probe unexpectedly had a recorded payload before close")
        sibling_execution_ids_before_drain = execution_ids(sibling_active) if isinstance(sibling_active, dict) else []
        if len(sibling_execution_ids_before_drain) != 1 or not active_cgroup(sibling_active or {}):
            failures.append("could not bind zero-record close test to one observed populated sibling execution")
        drain_close, drain_close_doc = invoke(
            "drain-probe-close-wait",
            ["session", "close", "--session", args.drain_probe_session, "--drain-policy", "wait"],
            30,
        )
        if drain_close.returncode != 0 or not isinstance(drain_close_doc, dict) or drain_close_doc.get("ok") is not True:
            failures.append(
                f"zero-record session did not close against the observed live sibling scope (exit={drain_close.returncode}, code={drain_close_doc.get('code') if isinstance(drain_close_doc, dict) else 'unparseable'})"
            )
        else:
            drained_session = recursively_find(drain_close_doc, "session")
            if not isinstance(drained_session, dict) or drained_session.get("state") != "closed":
                failures.append("zero-record drain close returned success without observing the probe session closed")
        sibling_after_drain = process_snapshot("sibling-processes-after-zero-record-close", args.sibling_session)
        sibling_execution_ids_after_drain = execution_ids(sibling_after_drain)
        if not active_cgroup(sibling_after_drain) or sibling_execution_ids_after_drain != sibling_execution_ids_before_drain:
            failures.append("zero-record close did not preserve the exact populated sibling execution")
        save(
            "zero-record-close-sibling-preservation.json",
            json.dumps(
                {
                    "drain_probe_execution_ids_before": execution_ids(drain_before),
                    "sibling_execution_ids_before": sibling_execution_ids_before_drain,
                    "sibling_execution_ids_after": sibling_execution_ids_after_drain,
                    "sibling_active_before": active_cgroup(sibling_active or {}),
                    "sibling_active_after": active_cgroup(sibling_after_drain),
                    "drain_close_return_code": drain_close.returncode,
                    "drain_close_response": drain_close_doc,
                },
                indent=2,
            ).encode()
            + b"\n",
        )
        drain_final = invoke_ok(
            "drain-probe-show-closed", ["session", "show", "--session", args.drain_probe_session]
        )
        drain_final_record = recursively_find(drain_final, "session")
        if not isinstance(drain_final_record, dict) and isinstance(drain_final.get("session_id"), str):
            drain_final_record = drain_final
        if not isinstance(drain_final_record, dict) or drain_final_record.get("state") != "closed":
            failures.append("zero-record drain probe did not remain owner-observed closed after preserving the sibling")

        boundary_source = (
            "const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');"
            "const [owned,outerRoot,peer,control,secret]=process.argv.slice(1);"
            "assert.ok(fs.readFileSync('README.md','utf8').length>0,'bounded README read failed');"
            "const marker='OCI_NAWABARI_N1_OWNED_WRITE_'+process.pid+'\\n';"
            "fs.writeFileSync(owned,marker);"
            "const git=cp.spawnSync('git',['status','--porcelain=v1','--',owned],{encoding:'utf8'});"
            "assert.equal(git.status,0,git.stderr);assert.ok(git.stdout.includes(owned),'Git did not observe the claimed write');"
            "const probes={outer_oci_root:outerRoot,peer_worktree:peer,control_store:control,secret};"
            "const denials={};for(const [name,path] of Object.entries(probes)){let code=null;try{fs.readFileSync(path)}"
            "catch(error){code=error.code||error.name}assert.ok(code,`strict boundary exposed ${name}`);denials[name]={denied:true,code};}"
            "const report={read:'README.md',write:owned,git_status:git.stdout,denials};"
            "process.stdout.write(JSON.stringify(report)+'\\n');"
        )
        boundary_run, boundary_result = invoke(
            "target-strict-boundary-run",
            [
                "session",
                "run",
                "--session",
                args.session,
                "--runtime-policy",
                "strict",
                "--",
                "node",
                "-e",
                boundary_source,
                owned_file,
                boundary_paths["outer_oci_root"],
                boundary_paths["peer_worktree"],
                boundary_paths["control_store"],
                boundary_paths["secret"],
            ],
            90,
        )
        if boundary_run.returncode != 0 or not isinstance(boundary_result, dict) or boundary_result.get("ok") is not True:
            failures.append(f"strict current-session read/write/Git/boundary payload failed (exit={boundary_run.returncode})")
        boundary_physical = recursively_find(boundary_result, "physical_execution") if isinstance(boundary_result, dict) else None
        if not isinstance(boundary_physical, dict):
            failures.append("strict boundary run omitted physical execution evidence")
        else:
            if boundary_physical.get("procfs", {}).get("mode") != "denied":
                failures.append("strict boundary run did not record the selected inherited-masked procfs topology")
            start = boundary_physical.get("start", {})
            namespaces = start.get("namespaces", {}) if isinstance(start, dict) else {}
            if not isinstance(start, dict) or start.get("state") != "observed" or any(
                not isinstance(namespaces.get(name), dict)
                or namespaces[name].get("state") != "observed"
                or namespaces[name].get("distinct_from_caller") is not True
                for name in ("pid", "user", "mount", "ipc", "uts")
            ):
                failures.append("strict boundary run did not observe distinct PID/user/mount/IPC/UTS namespaces")
            if boundary_physical.get("termination", {}).get("reason") != "exited":
                failures.append("strict boundary run did not observe normal payload termination")
            if boundary_physical.get("cleanup", {}).get("state") != "observed-empty":
                failures.append("strict boundary run did not observe its PID namespace empty")
        boundary_raw = recursively_find(boundary_result, "raw_output") if isinstance(boundary_result, dict) else None
        boundary_report = None
        boundary_streams = complete_raw_streams(boundary_raw)
        if boundary_streams is None:
            failures.append("strict boundary run did not preserve complete byte-faithful stdout/stderr")
        else:
            try:
                boundary_stdout, _ = boundary_streams
                boundary_report = json.loads(boundary_stdout)
            except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
                boundary_report = None
            if not isinstance(boundary_report, dict):
                failures.append("strict boundary payload output could not be decoded from the physical raw-output receipt")
            else:
                denials = boundary_report.get("denials")
                if not isinstance(denials, dict) or set(denials) != {"outer_oci_root", "peer_worktree", "control_store", "secret"}:
                    failures.append("strict boundary payload did not report all four explicit denial probes")
                elif any(
                    not isinstance(denials.get(name), dict)
                    or denials[name].get("denied") is not True
                    or not isinstance(denials[name].get("code"), str)
                    for name in ("outer_oci_root", "peer_worktree", "control_store", "secret")
                ):
                    failures.append("strict boundary payload reported a sentinel read without an observed denial code")
                if boundary_report.get("write") != owned_file or owned_file not in boundary_report.get("git_status", ""):
                    failures.append("strict boundary payload did not prove its own claimed write through Git")
        (evidence / "target-strict-boundary-summary.json").write_text(
            json.dumps({"physical_execution": boundary_physical, "payload": boundary_report}, indent=2) + "\n"
        )

        target_before = process_snapshot("target-processes-before-stale-test", args.session)
        stale_snapshot_doc = invoke_ok(
            "target-verification-snapshot-stale",
            ["verification", "snapshot", "--session", args.session],
        )
        stale_snapshot = stale_snapshot_doc.get("snapshot")
        if not isinstance(stale_snapshot, dict):
            raise RuntimeError("owner snapshot response omitted snapshot")

        # Advance this disposable session's claim generation once with a
        # known tracked path, then submit the pre-change snapshot exactly once.
        claim_result, claim_doc = invoke(
            "target-stale-trigger-claim",
            ["session", "claim", "--session", args.session, "--resource", stale_trigger_file, "--mode", "read"],
        )
        if claim_result.returncode != 0 or not isinstance(claim_doc, dict) or claim_doc.get("ok") is not True:
            raise RuntimeError("the single bounded public stale-trigger claim was not accepted")
        fresh_snapshot = invoke_ok(
            "target-verification-snapshot-after-claim",
            ["verification", "snapshot", "--session", args.session],
        ).get("snapshot")
        stale_generation = stale_snapshot.get("filesystem_policy_token", {}).get("claim_set_generation")
        candidate_generation = (
            fresh_snapshot.get("filesystem_policy_token", {}).get("claim_set_generation")
            if isinstance(fresh_snapshot, dict)
            else None
        )
        if not isinstance(fresh_snapshot, dict) or candidate_generation == stale_generation:
            raise RuntimeError("the single public claim did not advance the owner snapshot generation")

        stale_profile = {
            "contract_id": "nawabari.verification-profile.v1",
            "schema_version": 1,
            "profile_id": "physical-stale-snapshot-refusal",
            "profile_version": "1",
            "executable": "node",
            "argv": ["-e", "process.stdout.write('STALE_SNAPSHOT_MUST_NOT_START\\n')"],
            "cwd": stale_snapshot.get("worktree"),
            "read_visibility": "repository",
            "declared_read": [],
            "write_policy": "deny",
            "timeout_ms": 5000,
            "max_output_bytes": 8192,
        }
        stale_request = {
            "contract_id": "nawabari.session-bound-verification.v1",
            "schema_version": 1,
            "session_id": args.session,
            "snapshot": stale_snapshot,
            "profile": stale_profile,
        }
        request_path = f"/tmp/nawabari-oci-proof-{uuid.uuid4()}.json"
        write_script = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readFileSync(0),{mode:0o600})"
        writer = subprocess.run(
            [args.podman_wrapper, "exec", "-i", args.container_id, *env, "node", "-e", write_script, request_path],
            input=json.dumps(stale_request).encode(),
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("stale-request-write.stdout", writer.stdout)
        save("stale-request-write.stderr", writer.stderr)
        if writer.returncode != 0:
            raise RuntimeError("could not write bounded stale-snapshot request")
        stale_result, stale_doc = invoke(
            "stale-verification-execution",
            ["verification", "execute", "--request-file", request_path],
        )
        after_stale = process_snapshot("target-processes-after-stale-test", args.session)
        stale_code = stale_doc.get("code") if isinstance(stale_doc, dict) else None
        if stale_result.returncode == 0 or stale_code != "STALE_REGISTRY":
            failures.append(f"stale snapshot was not refused as STALE_REGISTRY (exit={stale_result.returncode}, code={stale_code})")
        if execution_ids(target_before) != execution_ids(after_stale):
            failures.append("stale snapshot attempt added or removed a durable execution record")
        save("stale-snapshot-comparison.json", json.dumps({"before": execution_ids(target_before), "after": execution_ids(after_stale)}, indent=2).encode() + b"\n")

        timeout_snapshot = fresh_snapshot
        timeout_profile = {
            **stale_profile,
            "profile_id": "physical-timeout-descendant-cleanup",
            "argv": [
                "-e",
                "const {spawn}=require('node:child_process');spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write('timeout-child-started\\n');setInterval(()=>{},1000)",
            ],
            "timeout_ms": 1500,
            "max_output_bytes": 16384,
        }
        timeout_request = {
            "contract_id": "nawabari.session-bound-verification.v1",
            "schema_version": 1,
            "session_id": args.session,
            "snapshot": timeout_snapshot,
            "profile": timeout_profile,
        }
        timeout_path = f"/tmp/nawabari-oci-proof-{uuid.uuid4()}.json"
        writer = subprocess.run(
            [args.podman_wrapper, "exec", "-i", args.container_id, *env, "node", "-e", write_script, timeout_path],
            input=json.dumps(timeout_request).encode(),
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("timeout-request-write.stdout", writer.stdout)
        save("timeout-request-write.stderr", writer.stderr)
        if writer.returncode != 0:
            raise RuntimeError("could not write bounded timeout request")
        timeout_result, timeout_doc = invoke("timeout-verification-execution", ["verification", "execute", "--request-file", timeout_path], 45)
        timeout_evidence = recursively_find(timeout_doc, "execution_evidence") if isinstance(timeout_doc, dict) else None
        physical = timeout_evidence.get("physical_execution") if isinstance(timeout_evidence, dict) else None
        if not isinstance(physical, dict):
            failures.append(f"timeout receipt omitted physical execution evidence (exit={timeout_result.returncode})")
        else:
            if physical.get("termination", {}).get("reason") != "timeout":
                failures.append("verifier timeout did not record termination.reason=timeout")
            if physical.get("cleanup", {}).get("state") != "observed-empty":
                failures.append("verifier timeout did not observe the PID namespace empty")
            managed_execution = timeout_doc.get("managed_execution") if isinstance(timeout_doc, dict) else None
            owned_execution = managed_execution.get("owned_execution") if isinstance(managed_execution, dict) else None
            if not isinstance(owned_execution, dict) or owned_execution.get("state") != "empty":
                failures.append("verifier timeout did not preserve observed-empty owner cgroup evidence")
            timeout_raw = timeout_evidence.get("raw_output") if isinstance(timeout_evidence, dict) else None
            timeout_streams = complete_raw_streams(timeout_raw)
            if timeout_streams is None or b"timeout-child-started" not in timeout_streams[0]:
                failures.append("verifier timeout did not preserve complete byte-faithful output from the started payload")

        # Launch a second strict process in the target, wait for owner-visible
        # populated cgroup evidence, then exercise only the new public close
        # operation. The payload's own 45-second deadline bounds a denied close.
        target, _, _ = launch_persistent("target-strict-run", args.session)
        target_active = wait_active("target", args.session, target)
        close_completed = False
        if target_active is None or not active_cgroup(target_active):
            failures.append("target strict execution never exposed an active observed owned cgroup")
            try:
                collect_process(target, "target-strict-run", 55)
            except RuntimeError as error:
                failures.append(str(error))
        else:
            close_result, close_doc = invoke(
                "target-close-terminate",
                ["session", "close", "--session", args.session, "--drain-policy", "terminate"],
                30,
            )
            if close_result.returncode != 0 or not isinstance(close_doc, dict) or close_doc.get("ok") is not True:
                failures.append(
                    f"public close termination did not complete (exit={close_result.returncode}, code={close_doc.get('code') if isinstance(close_doc, dict) else 'unparseable'})"
                )
            else:
                closed_session = recursively_find(close_doc, "session")
                close_completed = isinstance(closed_session, dict) and closed_session.get("state") == "closed"
                if not close_completed:
                    failures.append("public close termination returned success without a closed selected session")
            try:
                collect_process(target, "target-strict-run", 55)
            except RuntimeError as error:
                failures.append(str(error))
            target_doc = None
            try:
                target_doc = json.loads((evidence / "target-strict-run.stdout").read_bytes())
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                pass
            run_evidence = recursively_find(target_doc, "execution_evidence") if isinstance(target_doc, dict) else None
            if run_evidence is None and isinstance(target_doc, dict):
                run_evidence = recursively_find(target_doc, "physical_execution")
            target_physical = run_evidence.get("physical_execution") if isinstance(run_evidence, dict) else None
            if not isinstance(target_physical, dict):
                failures.append("cancelled run did not preserve physical execution evidence")
            else:
                if target_physical.get("procfs", {}).get("mode") != "denied":
                    failures.append("cancelled run did not preserve its selected inherited-masked procfs topology")
                if target_physical.get("cleanup", {}).get("state") != "observed-empty":
                    failures.append("cancelled run did not observe the owned PID namespace empty")
                if target_physical.get("termination", {}).get("state") != "observed-exited":
                    failures.append("cancelled run did not observe the payload exited")
                if target_physical.get("termination", {}).get("reason") != "cancelled":
                    failures.append("public close did not produce an observed cancelled termination reason")
            target_raw = recursively_find(target_doc, "raw_output") if isinstance(target_doc, dict) else None
            target_streams = complete_raw_streams(target_raw)
            if target_streams is None or b'"parent"' not in target_streams[0] or b'"child"' not in target_streams[0]:
                failures.append("cancelled strict run did not preserve complete byte-faithful parent/descendant output")

            target_after_close = process_snapshot("target-processes-after-close", args.session)
            expected_cancelled_execution = (
                target_physical.get("correlation_id") if isinstance(target_physical, dict) else None
            )
            process_records = target_after_close.get("processes")
            matching_cancelled = [
                item
                for item in process_records
                if isinstance(item, dict)
                and isinstance(item.get("execution"), dict)
                and item["execution"].get("execution_id") == expected_cancelled_execution
            ] if isinstance(process_records, list) else []
            if not isinstance(expected_cancelled_execution, str) or len(matching_cancelled) != 1:
                failures.append("post-close session observation did not find the exact cancelled execution record")
            elif not isinstance(matching_cancelled[0].get("cgroups"), dict) or matching_cancelled[0]["cgroups"].get("state") != "empty":
                failures.append("post-close owner observation did not prove the exact cancelled execution cgroup empty")

        if not close_completed:
            # Any fallback here is still the canonical default wait operation;
            # it never signals the payload or treats host process exit as proof.
            wait_close, wait_doc = invoke(
                "target-close-wait-cleanup",
                ["session", "close", "--session", args.session],
                30,
            )
            if wait_close.returncode != 0 or not isinstance(wait_doc, dict) or wait_doc.get("ok") is not True:
                failures.append("target disposable session did not converge through default wait cleanup")

        # Verify the unrelated session remained active and its owned execution
        # remained populated after target close. Never signal it from the host.
        sibling_after = process_snapshot("sibling-processes-after-target-close", args.sibling_session)
        if not active_cgroup(sibling_after):
            failures.append("sibling owned cgroup was not observed populated after target cancellation")
        save("sibling-active-owned-execution-count.json", json.dumps({"count": populated_execution_count(sibling_after)}, indent=2).encode() + b"\n")
        sibling_show = invoke_ok("sibling-show-after-target-close", ["session", "show", "--session", args.sibling_session])
        sibling_record = recursively_find(sibling_show, "session")
        if not isinstance(sibling_record, dict) and isinstance(sibling_show.get("session_id"), str):
            sibling_record = sibling_show
        if not isinstance(sibling_record, dict) or sibling_record.get("state") != "active":
            failures.append("sibling session did not remain active after target cancellation")

        inspect = subprocess.run(
            [args.podman_wrapper, "inspect", "--format", "{{.State.Running}}", args.container_id],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("container-running-after-target-close.stdout", inspect.stdout)
        save("container-running-after-target-close.stderr", inspect.stderr)
        if inspect.returncode != 0 or inspect.stdout.strip() != b"true":
            failures.append("repository OCI container was not observed running after target cancellation")

        # The sibling payload is bounded in its own namespace and exits itself;
        # this wait does not cancel or signal it.
        try:
            sibling_code = collect_process(sibling, "sibling-strict-run", 65)
            if sibling_code != 0:
                failures.append(f"sibling strict process did not complete normally (exit={sibling_code})")
        except RuntimeError as error:
            failures.append(str(error))
        sibling_output = (evidence / "sibling-strict-run.stdout").read_bytes()
        try:
            sibling_doc = json.loads(sibling_output)
        except (UnicodeDecodeError, json.JSONDecodeError):
            sibling_doc = None
        sibling_physical = recursively_find(sibling_doc, "physical_execution") if isinstance(sibling_doc, dict) else None
        if not isinstance(sibling_physical, dict):
            failures.append("sibling strict run did not preserve physical execution evidence")
        else:
            if sibling_physical.get("cleanup", {}).get("state") != "observed-empty":
                failures.append("sibling strict run did not observe its own PID namespace empty after natural exit")
            start = sibling_physical.get("start", {})
            namespaces = start.get("namespaces", {}) if isinstance(start, dict) else {}
            if not isinstance(start, dict) or start.get("state") != "observed" or any(
                not isinstance(namespaces.get(name), dict)
                or namespaces[name].get("state") != "observed"
                or namespaces[name].get("distinct_from_caller") is not True
                for name in ("pid", "user", "mount", "ipc", "uts")
            ):
                failures.append("sibling strict run did not observe distinct PID/user/mount/IPC/UTS namespaces")
            raw = recursively_find(sibling_doc, "raw_output")
            sibling_streams = complete_raw_streams(raw)
            if sibling_streams is None:
                failures.append("sibling strict run did not preserve complete raw output")
            else:
                stdout, _ = sibling_streams
                if b'"parent"' not in stdout or b'"child"' not in stdout:
                    failures.append("sibling strict payload did not report its parent and descendant identities")

        # Keep the pre-existing sibling session and worktree active for the
        # owner; this proof only waits for its bounded payload to exit.
        sibling_final = invoke_ok("sibling-show-left-active", ["session", "show", "--session", args.sibling_session])
        sibling_final_record = recursively_find(sibling_final, "session")
        if not isinstance(sibling_final_record, dict) and isinstance(sibling_final.get("session_id"), str):
            sibling_final_record = sibling_final
        if (
            not isinstance(sibling_final_record, dict)
            or sibling_final_record.get("state") != "active"
            or sibling_final_record.get("worktree") != sibling_worktree
        ):
            failures.append("the original sibling session and worktree were not left active")

        summary = {
            "package_sha256": args.package_sha256,
            "session_id": args.session,
            "drain_probe_session_id": args.drain_probe_session,
            "sibling_session_id": args.sibling_session,
            "failures": failures,
            "result": "passed" if not failures else "failed",
        }
        (evidence / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary, indent=2))
        return 0 if not failures else 1
    except Exception as error:  # Preserve evidence and precise failure; never synthesize a pass.
        (evidence / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
        print(f"proof harness blocked: {type(error).__name__}: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
