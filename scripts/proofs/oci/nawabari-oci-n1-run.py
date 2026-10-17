#!/usr/bin/env python3
"""Bounded public-CLI N1 proof for strict OCI execution and owned cancellation.

This script is intentionally not run until the matching immutable Nawabari
artifact is installed in the selected disposable OCI container. It consumes
the prepared target/drain scope and existing live sibling created/selected by
`nawabari-oci-n1-prepare.py` through Nawabari's public CLI. Closed target and
drain records are replaced only through public session creation. The target
itself is cancelled, then replaced publicly after its owned execution and
claim lease close, leaving the tested replacement and original sibling active.
It never uses host process signalling or stops/restarts the repository
container.
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

    def invoke(
        name: str,
        argv: list[str],
        timeout: int = 30,
        workdir: str | None = None,
    ) -> tuple[subprocess.CompletedProcess[bytes], dict | None]:
        selected_prefix = prefix if workdir is None else [
            args.podman_wrapper,
            "exec",
            "--workdir",
            workdir,
            args.container_id,
            *env,
        ]
        command = [*selected_prefix, args.nawabari, "--json", *argv]
        result = subprocess.run(command, capture_output=True, timeout=timeout, check=False)
        save(f"{name}.stdout", result.stdout)
        save(f"{name}.stderr", result.stderr)
        save(f"{name}.argv.json", json.dumps(command).encode() + b"\n")
        try:
            document = json.loads(result.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            document = None
        return result, document

    def invoke_ok(name: str, argv: list[str], timeout: int = 30, workdir: str | None = None) -> dict:
        result, document = invoke(name, argv, timeout, workdir)
        if result.returncode != 0 or not isinstance(document, dict) or document.get("ok") is not True:
            raise RuntimeError(
                f"{name} failed: exit={result.returncode}, code={document.get('code') if isinstance(document, dict) else 'unparseable'}"
            )
        return document

    def write_container_json(name: str, value: dict) -> str:
        remote = f"/tmp/nawabari-n1-{uuid.uuid4()}.json"
        command = [
            args.podman_wrapper,
            "exec",
            "-i",
            args.container_id,
            *env,
            "node",
            "-e",
            "const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readFileSync(0),{mode:0o600})",
            remote,
        ]
        result = subprocess.run(
            command,
            input=json.dumps(value, separators=(",", ":")).encode(),
            capture_output=True,
            timeout=30,
            check=False,
        )
        save(f"{name}.stdout", result.stdout)
        save(f"{name}.stderr", result.stderr)
        save(f"{name}.argv.json", json.dumps(command).encode() + b"\n")
        if result.returncode != 0:
            raise RuntimeError(f"could not write public CLI request artifact {name}")
        return remote

    def create_fresh_session(name: str, source_key: str, profile: str, claims: list[tuple[str, str]]) -> dict:
        source = session_manifest.get(source_key)
        scope = source.get("scope") if isinstance(source, dict) else None
        working_set = source.get("working_set") if isinstance(source, dict) else None
        if not isinstance(scope, dict) or not isinstance(working_set, dict):
            raise RuntimeError(f"session manifest omitted the bounded {source_key} artifacts")
        base = scope.get("base")
        expected_revision = base.get("revision") if isinstance(base, dict) else None
        head = subprocess.run(
            [*prefix, "git", "rev-parse", "main"], capture_output=True, timeout=30, check=False
        )
        save(f"{name}-repository-main-head.stdout", head.stdout)
        save(f"{name}-repository-main-head.stderr", head.stderr)
        if head.returncode != 0 or head.stdout.decode("ascii", errors="replace").strip() != expected_revision:
            raise RuntimeError(f"current repository main no longer matches the {source_key} base revision")
        candidate = json.loads(json.dumps(working_set))
        candidate["workingSetId"] = f"oci-n1-physical-{name}-{uuid.uuid4()}"
        scope_path = write_container_json(f"{name}-create-execution-scope", scope)
        candidate_path = write_container_json(f"{name}-create-candidate-working-set", candidate)
        create_argv = [
            "session",
            "create",
            "--base",
            "main",
            "--profile",
            profile,
            "--execution-scope-file",
            scope_path,
            "--candidate-working-set-file",
            candidate_path,
        ]
        for resource, mode in claims:
            create_argv.extend(["--resource", resource, "--mode", mode])
        create_argv.append("--enforce-claims")
        created = invoke_ok(f"{name}-create-session", create_argv, timeout=120)
        created_session = recursively_find(created, "session")
        if not isinstance(created_session, dict) and isinstance(created.get("session_id"), str):
            created_session = created
        if not isinstance(created_session, dict) or not isinstance(created_session.get("session_id"), str):
            raise RuntimeError(f"fresh {name} create omitted its canonical session identity")
        shown = invoke_ok(
            f"{name}-show-session", ["session", "show", "--session", created_session["session_id"]]
        )
        record = recursively_find(shown, "session")
        if not isinstance(record, dict) and isinstance(shown.get("session_id"), str):
            record = shown
        if not isinstance(record, dict) or record.get("state") != "active":
            raise RuntimeError(f"fresh {name} owner record is not active")
        repository = scope.get("repository")
        repository_id = repository.get("repositoryId") if isinstance(repository, dict) else None
        if record.get("base_revision") != expected_revision or record.get("repository") != repository_id:
            raise RuntimeError(f"fresh {name} owner record differs from the bounded source repository/base")
        claimed = invoke_ok(
            f"{name}-show-claims", ["session", "claims", "--session", record["session_id"]]
        ).get("claims")
        normalized_claims = {
            (item.get("resource"), item.get("mode")) for item in claimed if isinstance(item, dict)
        } if isinstance(claimed, list) else set()
        if normalized_claims != set(claims):
            raise RuntimeError(f"fresh {name} owner did not atomically retain its exact bounded claims")
        snapshot_doc = invoke_ok(
            f"{name}-initial-snapshot", ["verification", "snapshot", "--session", record["session_id"]]
        )
        snapshot = snapshot_doc.get("snapshot")
        if not isinstance(snapshot, dict) or snapshot.get("session_id") != record["session_id"]:
            raise RuntimeError(f"fresh {name} verification snapshot omitted its canonical session identity")
        return {
            "create": created,
            "session": record,
            "snapshot": snapshot,
            "scope": scope,
            "working_set": candidate,
            "claims": claimed,
        }

    def create_fresh_drain_probe() -> dict:
        return create_fresh_session(
            "drain-probe", "drain_probe", "builtin:minimal", [("README.md", "read")]
        )

    def create_fresh_target(name: str) -> dict:
        return create_fresh_session(
            name,
            "target",
            session_manifest.get("profile_id", "repository:oci-n1-physical-v3"),
            [("README.md", "read"), (owned_file, "write")],
        )

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

    def command_line(argv: list[str], workdir: str | None = None) -> list[str]:
        selected_prefix = prefix if workdir is None else [
            args.podman_wrapper,
            "exec",
            "--workdir",
            workdir,
            args.container_id,
            *env,
        ]
        return [*selected_prefix, args.nawabari, "--json", *argv]

    def launch_persistent(
        name: str, session_id: str, session_worktree: str
    ) -> tuple[subprocess.Popen[bytes], pathlib.Path, pathlib.Path]:
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
            ],
            session_worktree,
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

    def inspect_engine_resources() -> dict:
        host = subprocess.run(
            [args.podman_wrapper, "inspect", "--format", "{{json .HostConfig}}", args.container_id],
            capture_output=True,
            timeout=30,
            check=False,
        )
        network = subprocess.run(
            [args.podman_wrapper, "inspect", "--format", "{{json .NetworkSettings}}", args.container_id],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save("engine-hostconfig-inspect.stdout", host.stdout)
        save("engine-hostconfig-inspect.stderr", host.stderr)
        save("engine-network-inspect.stdout", network.stdout)
        save("engine-network-inspect.stderr", network.stderr)
        if host.returncode != 0 or network.returncode != 0:
            raise RuntimeError("repository container engine resource/network inspection failed")
        try:
            host_config = json.loads(host.stdout)
            network_settings = json.loads(network.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("repository container engine inspection was not valid JSON") from error
        if not isinstance(host_config, dict) or not isinstance(network_settings, dict):
            raise RuntimeError("repository container engine inspection omitted host/network objects")
        networks = network_settings.get("Networks")
        observed = {
            "memory_bytes": host_config.get("Memory"),
            "nano_cpus": host_config.get("NanoCpus"),
            "cpu_quota_usec": host_config.get("CpuQuota"),
            "cpu_period_usec": host_config.get("CpuPeriod"),
            "pids_limit": host_config.get("PidsLimit"),
            "network_mode": host_config.get("NetworkMode"),
            "networks": sorted(networks) if isinstance(networks, dict) else None,
            "pid_mode": host_config.get("PidMode"),
            "cgroup_mode": host_config.get("CgroupMode"),
            "privileged": host_config.get("Privileged"),
        }
        (evidence / "engine-resource-observation.json").write_text(json.dumps(observed, indent=2) + "\n")
        expected = {
            "memory_bytes": 536_870_912,
            "nano_cpus": 1_000_000_000,
            "cpu_quota_usec": 100_000,
            "cpu_period_usec": 100_000,
            "pids_limit": 128,
            "network_mode": "none",
            "networks": ["none"],
            "pid_mode": "private",
            "cgroup_mode": "private",
            "privileged": False,
        }
        mismatches = {key: {"expected": value, "observed": observed.get(key)} for key, value in expected.items() if observed.get(key) != value}
        if mismatches:
            failures.append(f"engine resource/isolation observation did not match the bounded OCI profile: {mismatches}")
        return observed

    def observe_owned_cgroup_limits(name: str, document: dict, session_id: str) -> dict | None:
        processes = document.get("processes")
        records = processes if isinstance(processes, list) else []
        owned = [
            item
            for item in records
            if isinstance(item, dict)
            and isinstance(item.get("execution"), dict)
            and item["execution"].get("session_id") == session_id
            and isinstance(item.get("cgroups"), dict)
            and item["cgroups"].get("state") in {"active", "empty"}
            and isinstance(item["cgroups"].get("cgroups"), dict)
        ]
        if len(owned) != 1:
            failures.append(f"{name} did not identify exactly one owner-backed execution cgroup for the selected session")
            return None
        item = owned[0]
        execution = item["execution"]
        cgroups = item["cgroups"]["cgroups"]
        root = execution.get("cgroup_root")
        scope = cgroups.get("scope")
        execution_id = execution.get("execution_id")
        if (
            not isinstance(root, str)
            or not root.startswith("/sys/fs/cgroup/")
            or not isinstance(scope, str)
            or not scope.startswith("nawabari-")
            or any(char not in "0123456789abcdef" for char in scope.removeprefix("nawabari-"))
            or len(scope.removeprefix("nawabari-")) != 48
            or not isinstance(execution_id, str)
        ):
            failures.append(f"{name} public execution record omitted a canonical owner cgroup identity")
            return None
        script = (
            "const fs=require('node:fs'),path=require('node:path');"
            "const root=process.argv[1],scope=process.argv[2];"
            "if(!root.startsWith('/sys/fs/cgroup/')||!/^nawabari-[0-9a-f]{48}$/.test(scope))process.exit(2);"
            "const dirs=[root,path.join(root,'nawabari'),path.join(root,'nawabari',scope)];"
            "const out=dirs.map(directory=>{const values={};for(const file of ['cpu.max','memory.max','pids.max']){"
            "try{values[file]=fs.readFileSync(path.join(directory,file),'utf8').trim()}catch(e){values[file]=null}}"
            "return {directory,values}});process.stdout.write(JSON.stringify(out)+'\\n');"
        )
        observed = subprocess.run(
            [*prefix, "node", "-e", script, root, scope],
            capture_output=True,
            timeout=30,
            check=False,
        )
        save(f"{name}-owned-cgroup-limits.stdout", observed.stdout)
        save(f"{name}-owned-cgroup-limits.stderr", observed.stderr)
        if observed.returncode != 0:
            failures.append(f"{name} could not read its owner-backed cgroup limit chain from the OCI container")
            return None
        try:
            chain = json.loads(observed.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError):
            failures.append(f"{name} cgroup limit-chain output was not valid JSON")
            return None
        if not isinstance(chain, list) or len(chain) != 3 or any(not isinstance(level, dict) for level in chain):
            failures.append(f"{name} cgroup limit-chain observation was incomplete")
            return None

        def parse_cpu(value: object) -> tuple[float, int, int] | None:
            if not isinstance(value, str):
                return None
            parts = value.split()
            if len(parts) != 2 or parts[0] == "max":
                return None
            try:
                quota, period = int(parts[0]), int(parts[1])
            except ValueError:
                return None
            if quota < 1 or period < 1:
                return None
            return quota / period, quota, period

        cpu_limits = [parse_cpu(level.get("values", {}).get("cpu.max")) for level in chain]
        cpu_limits = [limit for limit in cpu_limits if limit is not None]
        scalar_limits: dict[str, list[int]] = {"memory.max": [], "pids.max": []}
        for level in chain:
            values = level.get("values")
            if not isinstance(values, dict):
                continue
            for key, limits in scalar_limits.items():
                value = values.get(key)
                if isinstance(value, str) and value != "max" and value.isdigit() and int(value) > 0:
                    limits.append(int(value))
        effective = {
            "cpu": None if not cpu_limits else {
                "cores": min(cpu_limits)[0],
                "quota_usec": min(cpu_limits)[1],
                "period_usec": min(cpu_limits)[2],
            },
            "memory_bytes": min(scalar_limits["memory.max"]) if scalar_limits["memory.max"] else None,
            "pids": min(scalar_limits["pids.max"]) if scalar_limits["pids.max"] else None,
        }
        result = {
            "session_id": session_id,
            "execution_id": execution_id,
            "cgroup_root": root,
            "scope": scope,
            "chain": chain,
            "effective_inherited_limits": effective,
        }
        (evidence / f"{name}-owned-cgroup-limits.json").write_text(json.dumps(result, indent=2) + "\n")
        if (
            effective["cpu"] is None
            or effective["cpu"]["cores"] > 1.0
            or effective["memory_bytes"] is None
            or effective["memory_bytes"] > 536_870_912
            or effective["pids"] is None
            or effective["pids"] > 128
        ):
            failures.append(f"{name} owner cgroup did not observe the bounded inherited 1 CPU/512 MiB/128 PID limits")
        return result

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
        engine_resources = inspect_engine_resources()

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
        if isinstance(target_session, dict) and target_session.get("state") == "closed":
            target = create_fresh_target("target")
            session_manifest["target"] = target
            target_session = target["session"]
            args.session = target_session.get("session_id")
            target_worktree = target_session.get("worktree")
            (evidence / "fresh-target-creation.json").write_text(json.dumps(target, indent=2) + "\n")
        if not isinstance(target_session, dict) or target_session.get("state") != "active":
            raise RuntimeError("target public session is not observed active")
        if isinstance(drain_probe_session, dict) and drain_probe_session.get("state") == "closed":
            drain_probe = create_fresh_drain_probe()
            session_manifest["drain_probe"] = drain_probe
            drain_probe_session = drain_probe["session"]
            args.drain_probe_session = drain_probe_session.get("session_id")
            drain_probe_worktree = drain_probe_session.get("worktree")
            (evidence / "fresh-drain-probe-creation.json").write_text(json.dumps(drain_probe, indent=2) + "\n")
        if not isinstance(drain_probe_session, dict) or drain_probe_session.get("state") != "active":
            raise RuntimeError("zero-execution drain probe session is not observed active before its close test")
        if not isinstance(sibling_session, dict) or sibling_session.get("state") != "active":
            raise RuntimeError("sibling public session is not observed active")
        active_ids = {
            target_session.get("session_id"),
            drain_probe_session.get("session_id"),
            sibling_session.get("session_id"),
        }
        active_worktrees = {
            target_session.get("worktree"),
            drain_probe_session.get("worktree"),
            sibling_session.get("worktree"),
        }
        if (
            len(active_ids) != 3
            or None in active_ids
            or len(active_worktrees) != 3
            or None in active_worktrees
            or target_session.get("worktree") != target_worktree
            or drain_probe_session.get("worktree") != drain_probe_worktree
            or sibling_session.get("worktree") != sibling_worktree
        ):
            raise RuntimeError("public session owner records differ from the preparation manifest")

        effective_manifest = {
            "source_manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
            "target_session_id": args.session,
            "target_worktree": target_worktree,
            "drain_probe_session_id": args.drain_probe_session,
            "drain_probe_worktree": drain_probe_worktree,
            "sibling_session_id": args.sibling_session,
            "sibling_worktree": sibling_worktree,
            "repository_base_revision": session_manifest.get("repository_head_after"),
            "package_sha256": args.package_sha256,
        }
        (evidence / "effective-session-identities.json").write_text(json.dumps(effective_manifest, indent=2) + "\n")

        claims = invoke_ok("target-claims-before-reset", ["session", "claims", "--session", args.session]).get("claims")
        if not isinstance(claims, list):
            raise RuntimeError("target public session claims response omitted claims")
        normalized_claims = {
            (item.get("resource"), item.get("mode"))
            for item in claims
            if isinstance(item, dict)
        }
        expected_claims = {("README.md", "read"), (owned_file, "write")}
        if normalized_claims != expected_claims:
            current_snapshot = invoke_ok(
                "target-snapshot-before-claim-reset", ["verification", "snapshot", "--session", args.session]
            ).get("snapshot")
            generation = (
                current_snapshot.get("filesystem_policy_token", {}).get("claim_set_generation")
                if isinstance(current_snapshot, dict)
                else None
            )
            if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
                raise RuntimeError("could not bind target claim reset to a current owner generation")
            reset_result, reset_doc = invoke(
                "target-claims-reset-to-pretest-baseline",
                [
                    "session",
                    "update",
                    "--session",
                    args.session,
                    "--resource",
                    "README.md",
                    "--mode",
                    "read",
                    "--resource",
                    owned_file,
                    "--mode",
                    "write",
                    "--if-generation",
                    str(generation),
                ],
                30,
            )
            if reset_result.returncode != 0 or not isinstance(reset_doc, dict) or reset_doc.get("ok") is not True:
                raise RuntimeError("could not CAS-reset the disposable target to its original exact claim set")
            claims = invoke_ok(
                "target-initial-claims", ["session", "claims", "--session", args.session]
            ).get("claims")
            if not isinstance(claims, list):
                raise RuntimeError("target public session claims response omitted claims after reset")
            normalized_claims = {
                (item.get("resource"), item.get("mode"))
                for item in claims
                if isinstance(item, dict)
            }
        if normalized_claims != expected_claims:
            raise RuntimeError("target did not return to its exact README-read and fixture-write baseline")
        save("target-initial-claims-normalized.json", json.dumps(sorted([list(item) for item in normalized_claims]), indent=2).encode() + b"\n")

        (evidence / "run-identity.json").write_text(
            json.dumps(
                {
                    **effective_manifest,
                    "sessions_manifest_sha256": effective_manifest["source_manifest_sha256"],
                    "installed_proof": installed_proof,
                    "started_at_unix": time.time(),
                },
                indent=2,
            )
            + "\n"
        )
        proof_target_session_id = args.session

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

        # Preserve an actually running strict sibling while the separate
        # cancellation probe is closed. Both payloads are finite if owner
        # cancellation fails.
        sibling, _, _ = launch_persistent("sibling-strict-run", args.sibling_session, sibling_worktree)
        sibling_active = wait_active("sibling", args.sibling_session, sibling)
        sibling_cgroup_limits = None
        if sibling_active is None or not active_cgroup(sibling_active):
            failures.append("sibling strict execution never exposed an active observed owned cgroup")
        else:
            sibling_cgroup_limits = observe_owned_cgroup_limits("sibling-active", sibling_active, args.sibling_session)

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
            "const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),crypto=require('node:crypto');"
            "const [owned,outerRoot,peer,control,secret]=process.argv.slice(1);"
            "assert.ok(fs.readFileSync('README.md','utf8').length>0,'bounded README read failed');"
            "const marker='OCI_NAWABARI_N1_OWNED_WRITE_'+process.pid+'\\n';"
            "fs.writeFileSync(owned,marker);"
            "assert.equal(fs.readFileSync(owned,'utf8'),marker,'protected payload could not read back its own write');"
            "const gitVersion=cp.spawnSync('git',['--version'],{encoding:'utf8'});"
            "assert.equal(gitVersion.status,0,gitVersion.stderr);"
            "const gitMetadata=cp.spawnSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'});"
            "assert.notEqual(gitMetadata.status,0,'strict payload unexpectedly accessed repository Git metadata');"
            "const probes={outer_oci_root:outerRoot,peer_worktree:peer,control_store:control,secret};"
            "const denials={};for(const [name,path] of Object.entries(probes)){let code=null;try{fs.readFileSync(path)}"
            "catch(error){code=error.code||error.name}assert.ok(code,`strict boundary exposed ${name}`);denials[name]={denied:true,code};}"
            "const report={read:'README.md',write:owned,write_sha256:crypto.createHash('sha256').update(marker).digest('hex'),"
            "git_executable:gitVersion.stdout.trim(),git_metadata_denied:{status:gitMetadata.status,stderr:gitMetadata.stderr.trim()},denials};"
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
            target_worktree,
        )
        session_request_identity = (
            recursively_find(boundary_result, "request_identity") if isinstance(boundary_result, dict) else None
        )
        if not isinstance(session_request_identity, dict) or session_request_identity.get("network_mode") != "inherited":
            failures.append("strict target session did not preserve its owner-observed inherited network mode")
        network_isolation = {
            "container_engine": engine_resources,
            "session_request_identity": session_request_identity,
            "effective_network_mode": (
                "none" if engine_resources.get("network_mode") == "none"
                and isinstance(session_request_identity, dict)
                and session_request_identity.get("network_mode") == "inherited"
                else "unknown"
            ),
        }
        (evidence / "network-isolation-observation.json").write_text(json.dumps(network_isolation, indent=2) + "\n")
        if boundary_run.returncode != 0 or not isinstance(boundary_result, dict) or boundary_result.get("ok") is not True:
            failures.append(f"strict current-session read/write/boundary payload failed (exit={boundary_run.returncode})")
        checkpoint_result = invoke(
            "target-checkpoint-after-protected-write",
            ["checkpoint", "--session", args.session],
            30,
            target_worktree,
        )
        if checkpoint_result[0].returncode != 0 or not isinstance(checkpoint_result[1], dict) or checkpoint_result[1].get("ok") is not True:
            failures.append("public owner checkpoint did not complete after the protected write")
            checkpoint_doc = None
        else:
            checkpoint_doc = checkpoint_result[1]
            checkpoint_paths = checkpoint_doc.get("paths")
            changed = checkpoint_paths.get("changed") if isinstance(checkpoint_paths, dict) else None
            in_claim = checkpoint_doc.get("in_claim")
            if (
                checkpoint_doc.get("session_id") != args.session
                or checkpoint_doc.get("worktree") != target_worktree
                or not isinstance(changed, list)
                or owned_file not in changed
                or not isinstance(in_claim, list)
                or owned_file not in in_claim
            ):
                failures.append("public owner checkpoint did not observe the protected write under its exact session claim")
        (evidence / "target-owner-checkpoint-summary.json").write_text(
            json.dumps(checkpoint_doc, indent=2) if checkpoint_doc is not None else "null"
        )
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
                if (
                    boundary_report.get("write") != owned_file
                    or not isinstance(boundary_report.get("write_sha256"), str)
                    or boundary_report.get("git_executable", "").startswith("git version ") is not True
                    or not isinstance(boundary_report.get("git_metadata_denied"), dict)
                    or boundary_report["git_metadata_denied"].get("status") == 0
                ):
                    failures.append("strict payload did not prove its write/readback and the bounded Git metadata denial")
        (evidence / "target-strict-boundary-summary.json").write_text(
            json.dumps(
                {"physical_execution": boundary_physical, "payload": boundary_report, "owner_checkpoint": checkpoint_doc},
                indent=2,
            )
            + "\n"
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
            "read_visibility": "declared",
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
            workdir=target_worktree,
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
        timeout_result, timeout_doc = invoke(
            "timeout-verification-execution",
            ["verification", "execute", "--request-file", timeout_path],
            45,
            target_worktree,
        )
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

        # Cancel the tested target itself after its successful positive and
        # verifier checks. It is replaced publicly only after its close
        # releases the exclusive write claim, so sibling sessions never race
        # for the same write lease.
        target, _, _ = launch_persistent("target-strict-run", args.session, target_worktree)
        target_active = wait_active("target", args.session, target)
        target_cgroup_limits = None
        close_completed = False
        close_dirty_worktree = False
        discard_completed = False
        target_cgroup_empty = False
        if target_active is None or not active_cgroup(target_active):
            failures.append("target strict execution never exposed an active observed owned cgroup")
            try:
                collect_process(target, "target-strict-run", 55)
            except RuntimeError as error:
                failures.append(str(error))
        else:
            target_cgroup_limits = observe_owned_cgroup_limits(
                "target-active-before-cancel", target_active, proof_target_session_id
            )
            close_result, close_doc = invoke(
                "target-close-terminate",
                ["session", "close", "--session", args.session, "--drain-policy", "terminate"],
                30,
            )
            if close_result.returncode != 0 or not isinstance(close_doc, dict) or close_doc.get("ok") is not True:
                close_code = close_doc.get("code") if isinstance(close_doc, dict) else None
                if close_code == "DIRTY_WORKTREE":
                    # The owner correctly protects uncommitted work at close.
                    # Preserve this result and use explicit discard only after
                    # both physical cleanup authorities prove the payload gone.
                    close_dirty_worktree = True
                else:
                    failures.append(
                        f"public close termination did not complete (exit={close_result.returncode}, code={close_code or 'unparseable'})"
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

            target_after_close = process_snapshot("target-processes-after-close", proof_target_session_id)
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
            else:
                target_cgroup_empty = True

            target_pid_namespace_empty = (
                isinstance(target_physical, dict)
                and target_physical.get("cleanup", {}).get("state") == "observed-empty"
            )
            if close_dirty_worktree:
                if not target_pid_namespace_empty or not target_cgroup_empty:
                    failures.append("explicit discard was withheld because owner and PID-namespace cleanup were not both observed empty")
                else:
                    discard_result, discard_doc = invoke(
                        "target-discard-after-proven-cancel",
                        ["session", "discard", "--session", proof_target_session_id],
                        60,
                    )
                    if discard_result.returncode != 0 or not isinstance(discard_doc, dict) or discard_doc.get("ok") is not True:
                        failures.append(
                            f"explicit discard after dirty-worktree protection failed (exit={discard_result.returncode}, code={discard_doc.get('code') if isinstance(discard_doc, dict) else 'unparseable'})"
                        )
                    else:
                        discard_completed = (
                            discard_doc.get("final_state") == "closed"
                            and isinstance(discard_doc.get("session"), dict)
                            and discard_doc["session"].get("session_id") == proof_target_session_id
                        )
                        if not discard_completed:
                            failures.append("explicit discard returned without closing the exact disposable target session")
                    (evidence / "target-dirty-close-and-discard.json").write_text(
                        json.dumps(
                            {
                                "close_code": "DIRTY_WORKTREE",
                                "physical_pid_namespace_empty": target_pid_namespace_empty,
                                "owner_cgroup_empty": target_cgroup_empty,
                                "discard_exit_code": discard_result.returncode,
                                "discard_response": discard_doc,
                                "discard_completed": discard_completed,
                            },
                            indent=2,
                        )
                        + "\n"
                    )
            if close_completed or discard_completed:
                closed_target = invoke_ok(
                    "target-show-closed-after-cancel", ["session", "show", "--session", proof_target_session_id]
                )
                closed_target_record = recursively_find(closed_target, "session")
                if not isinstance(closed_target_record, dict) and isinstance(closed_target.get("session_id"), str):
                    closed_target_record = closed_target
                if not isinstance(closed_target_record, dict) or closed_target_record.get("state") != "closed":
                    failures.append("target session did not remain owner-observed closed after termination/discard")

        if not close_completed and not close_dirty_worktree and not discard_completed:
            # Any fallback here is still the canonical default wait operation;
            # it never signals the payload or treats host process exit as proof.
            wait_close, wait_doc = invoke(
                "target-close-wait-cleanup",
                ["session", "close", "--session", proof_target_session_id],
                30,
            )
            if wait_close.returncode != 0 or not isinstance(wait_doc, dict) or wait_doc.get("ok") is not True:
                failures.append("target session did not converge through default wait cleanup")

        closed_target_after_wait = invoke_ok(
            "target-show-closed-after-wait", ["session", "show", "--session", proof_target_session_id]
        )
        closed_target_after_wait_record = recursively_find(closed_target_after_wait, "session")
        if not isinstance(closed_target_after_wait_record, dict) and isinstance(closed_target_after_wait.get("session_id"), str):
            closed_target_after_wait_record = closed_target_after_wait
        if not isinstance(closed_target_after_wait_record, dict) or closed_target_after_wait_record.get("state") != "closed":
            failures.append("the tested target session was not owner-observed closed before replacement")
        else:
            replacement = create_fresh_target("post-cancel-target")
            session_manifest["target"] = replacement
            target_session = replacement["session"]
            args.session = target_session.get("session_id")
            target_worktree = target_session.get("worktree")
            (evidence / "fresh-target-after-cancel-creation.json").write_text(
                json.dumps(replacement, indent=2) + "\n"
            )

        # Verify the unrelated session remained active and its owned execution
        # remained populated after cancellation. Never signal it from the host.
        sibling_after = process_snapshot("sibling-processes-after-cancel", args.sibling_session)
        if not active_cgroup(sibling_after):
            failures.append("sibling owned cgroup was not observed populated after target cancellation")
        save("sibling-active-owned-execution-count.json", json.dumps({"count": populated_execution_count(sibling_after)}, indent=2).encode() + b"\n")
        sibling_show = invoke_ok("sibling-show-after-cancel", ["session", "show", "--session", args.sibling_session])
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

        # Keep the pre-existing sibling and tested target session/worktree
        # active for the owner; only wait for the bounded sibling payload.
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
            "tested_target_session_id": proof_target_session_id,
            "replacement_active_session_id": args.session,
            "drain_probe_session_id": args.drain_probe_session,
            "sibling_session_id": args.sibling_session,
            "engine_resources": engine_resources,
            "session_network_mode": session_request_identity.get("network_mode")
            if isinstance(session_request_identity, dict)
            else None,
            "network_isolation": network_isolation,
            "target_owned_cgroup_limits": target_cgroup_limits,
            "sibling_owned_cgroup_limits": sibling_cgroup_limits,
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
