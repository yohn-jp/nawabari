/**
 * The Linux primitive used by the typed worktree-file operation authority.
 *
 * This is deliberately a complete, fixed program rather than a shell
 * fragment.  The TypeScript caller invokes it with the selected canonical
 * Landlock Python executable, `-I -c`, an empty environment, and one JSON
 * packet on stdin.  It never receives a pathname for a script, a command
 * string, or an arbitrary interpreter.
 */
export const WORKTREE_FILE_OPERATION_HELPER = String.raw`
import base64
import ctypes
import errno
import hashlib
import json
import os
import stat
import sys

MAX_PACKET = 2 * 1024 * 1024
# The TypeScript validator uses the same one-megabyte ceiling.  Keeping the
# decoded payload below the two-megabyte packet bound leaves room for the
# validated operation envelope and prevents an oversized stdin write from
# becoming an ambiguous helper invocation.
MAX_PAYLOAD = 1 * 1024 * 1024
RENAME_NOREPLACE = 1
AT_FDCWD = -100

def fail(code, message, uncertain=False):
    return {"ok": False, "code": code, "message": message, "uncertain": uncertain}

def safe_name(value):
    return isinstance(value, str) and value != "" and "\x00" not in value and "/" not in value and value not in (".", "..")

def safe_relative(value):
    if not isinstance(value, str) or value == "" or "\x00" in value or "\\" in value:
        return False
    parts = value.split("/")
    return all(safe_name(part) for part in parts)

def open_root(root):
    if not isinstance(root, str) or not os.path.isabs(root):
        raise OSError(errno.EINVAL, "worktree root must be absolute")
    canonical = os.path.realpath(root)
    if canonical != root or not os.path.isdir(root):
        raise OSError(errno.ELOOP, "worktree root is not a canonical directory")
    return os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

def open_parent(root_fd, relative):
    parts = relative.split("/")
    parent_fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            if not safe_name(part):
                raise OSError(errno.EINVAL, "invalid path component")
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = next_fd
        return parent_fd, parts[-1]
    except BaseException:
        os.close(parent_fd)
        raise

def digest_fd(fd):
    digest = hashlib.sha256()
    os.lseek(fd, 0, os.SEEK_SET)
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return digest.hexdigest()

def identity_from_stat(value, digest):
    return {"dev": str(value.st_dev), "ino": str(value.st_ino), "size": value.st_size, "digest": digest}

def inspect_at(parent_fd, name):
    value = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISREG(value.st_mode):
        raise OSError(errno.EINVAL, "target is not a regular file")
    if value.st_nlink != 1:
        raise OSError(errno.EMLINK, "target has an unknown hardlink identity")
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (value.st_dev, value.st_ino):
            raise OSError(errno.EAGAIN, "target identity changed")
        if opened.st_nlink != 1:
            raise OSError(errno.EMLINK, "target has an unknown hardlink identity")
        return fd, identity_from_stat(opened, digest_fd(fd))
    except BaseException:
        os.close(fd)
        raise

def same_expected(identity, expected, allow_absent=False):
    if expected is None:
        return allow_absent
    if not isinstance(expected, dict):
        return False
    if "digest" in expected and expected["digest"] != identity["digest"]:
        return False
    if "dev" in expected and str(expected["dev"]) != identity["dev"]:
        return False
    if "ino" in expected and str(expected["ino"]) != identity["ino"]:
        return False
    if "size" in expected and expected["size"] != identity["size"]:
        return False
    return True

def fsync_directory(fd):
    os.fsync(fd)

def rename_noreplace(source_fd, source_name, target_fd, target_name):
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, "renameat2", None)
    if function is None:
        raise OSError(errno.ENOTSUP, "renameat2 is unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    result = function(source_fd, os.fsencode(source_name), target_fd, os.fsencode(target_name), RENAME_NOREPLACE)
    if result != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))

def create(packet, root_fd):
    parent_fd, name = open_parent(root_fd, packet["path"])
    fd = None
    staging_name = ".nawabari-file-operation-" + hashlib.sha256(packet["operation_id"].encode("utf-8")).hexdigest()[:32]
    try:
        try:
            fd = os.open(staging_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd)
        except FileExistsError:
            return fail("OPERATION_ALREADY_IN_PROGRESS", "CREATE staging identity already exists")
        encoded = packet.get("payload_base64", "")
        payload = base64.b64decode(encoded, validate=True)
        if len(payload) > MAX_PAYLOAD:
            return fail("PAYLOAD_LIMIT", "payload exceeds the bounded limit")
        offset = 0
        while offset < len(payload):
            offset += os.write(fd, payload[offset:])
        os.fsync(fd)
        value = os.fstat(fd)
        identity = identity_from_stat(value, hashlib.sha256(payload).hexdigest())
        os.close(fd)
        fd = None
        try:
            rename_noreplace(parent_fd, staging_name, parent_fd, name)
        except FileExistsError:
            os.unlink(staging_name, dir_fd=parent_fd)
            fsync_directory(parent_fd)
            return fail("TARGET_EXISTS", "CREATE refuses to overwrite an existing target")
        fsync_directory(parent_fd)
        return {"ok": True, "identity": identity}
    except BaseException as error:
        if fd is not None:
            os.close(fd)
        return fail("CREATE_UNCERTAIN", str(error), True)
    finally:
        os.close(parent_fd)

def delete(packet, root_fd):
    parent_fd, name = open_parent(root_fd, packet["path"])
    fd = None
    try:
        try:
            fd, identity = inspect_at(parent_fd, name)
        except FileNotFoundError:
            return fail("TARGET_ABSENT", "DELETE target is absent")
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EINVAL, errno.ELOOP, errno.EMLINK):
                return fail("TARGET_IDENTITY_UNAVAILABLE", str(error))
            raise
        try:
            if not same_expected(identity, packet.get("expected")):
                return fail("EXPECTED_IDENTITY_MISMATCH", "DELETE target identity does not match")
            os.unlink(name, dir_fd=parent_fd)
            os.close(fd)
            fd = None
            fsync_directory(parent_fd)
            return {"ok": True, "identity": identity}
        finally:
            if fd is not None:
                os.close(fd)
    except BaseException as error:
        return fail("DELETE_UNCERTAIN", str(error), True)
    finally:
        os.close(parent_fd)

def rename(packet, root_fd):
    source_parent, source_name = open_parent(root_fd, packet["path"])
    target_parent, target_name = open_parent(root_fd, packet["to_path"])
    source_fd = None
    try:
        try:
            source_fd, identity = inspect_at(source_parent, source_name)
        except FileNotFoundError:
            return fail("SOURCE_ABSENT", "RENAME source is absent")
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EINVAL, errno.ELOOP, errno.EMLINK):
                return fail("SOURCE_IDENTITY_UNAVAILABLE", str(error))
            raise
        if not same_expected(identity, packet.get("expected")):
            return fail("EXPECTED_IDENTITY_MISMATCH", "RENAME source identity does not match")
        try:
            os.stat(target_name, dir_fd=target_parent, follow_symlinks=False)
            return fail("TARGET_EXISTS", "RENAME refuses to overwrite an existing target")
        except FileNotFoundError:
            pass
        rename_noreplace(source_parent, source_name, target_parent, target_name)
        os.close(source_fd)
        source_fd = None
        fsync_directory(target_parent)
        if source_parent != target_parent:
            fsync_directory(source_parent)
        return {"ok": True, "identity": identity}
    except BaseException as error:
        return fail("RENAME_UNCERTAIN", str(error), True)
    finally:
        if source_fd is not None:
            os.close(source_fd)
        os.close(source_parent)
        os.close(target_parent)

def main():
    raw = sys.stdin.buffer.read(MAX_PACKET + 1)
    if len(raw) > MAX_PACKET:
        print(json.dumps(fail("PACKET_LIMIT", "packet exceeds the bounded limit"), separators=(",", ":")))
        return 2
    try:
        packet = json.loads(raw.decode("utf-8"))
        if not isinstance(packet, dict):
            raise ValueError("packet must be an object")
        root_fd = open_root(packet["root"])
        try:
            operation = packet.get("operation")
            if operation == "CREATE":
                result = create(packet, root_fd)
            elif operation == "DELETE":
                result = delete(packet, root_fd)
            elif operation == "RENAME":
                result = rename(packet, root_fd)
            else:
                result = fail("INVALID_OPERATION", "unsupported operation")
        finally:
            os.close(root_fd)
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result.get("ok") else 1
    except BaseException as error:
        print(json.dumps(fail("HELPER_REJECTED", str(error)), separators=(",", ":")))
        return 1

sys.exit(main())
`;
