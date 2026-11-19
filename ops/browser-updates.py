#!/usr/bin/env python3
"""Check tags from the installation's Git origin and apply owner-approved releases."""

import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time


ROOT = Path(".update-state")
STATUS = ROOT / "status/status.json"
REQUEST = ROOT / "requests/update.json"
CHECK = ROOT / "requests/check"
RECOVERY = ROOT / "recovery.json"
TAG = re.compile(r"v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})")
COMMIT = re.compile(r"[a-f0-9]{40}")
CHECK_INTERVAL_MS = 10 * 60 * 1000
GIT = ["git", "-c", f"safe.directory={Path.cwd()}", "-c", "core.hooksPath=/dev/null"]
COMPOSE = ["./ops/compose.sh"]


def now():
    return int(time.time() * 1000)


def save(file, value):
    temporary = file.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    os.replace(temporary, file)


def run(args, *, capture=False, timeout=60, check=True):
    return subprocess.run(args, check=check, timeout=timeout, text=True,
                          stdout=subprocess.PIPE if capture else None)


def output(args):
    return run(args, capture=True).stdout.strip()


def git(*args):
    return output([*GIT, *args])


def ancestor(older, newer):
    code = run([*GIT, "merge-base", "--is-ancestor", older, newer], check=False).returncode
    if code not in (0, 1):
        raise RuntimeError("Unable to compare the release with the checkout.")
    return code == 0


def version_key(tag):
    return tuple(map(int, TAG.fullmatch(tag).groups()))


def resolve_tag(tag):
    git("fetch", "--no-tags", "origin", "refs/tags/" + tag)
    return git("rev-parse", "FETCH_HEAD^{commit}")


def latest(head):
    tags = []
    for line in git("ls-remote", "--tags", "--refs", "origin", "refs/tags/v*").splitlines():
        ref = line.split("\t", 1)[1]
        tag = ref.removeprefix("refs/tags/")
        if TAG.fullmatch(tag):
            tags.append(tag)
    if not tags:
        return None
    tag = max(tags, key=version_key)
    commit = resolve_tag(tag)
    if ancestor(commit, head):
        return None
    if not ancestor(head, commit):
        raise RuntimeError("The latest release cannot fast-forward this checkout.")
    manifest = json.loads(git("show", f"{commit}:package.json"))
    if not isinstance(manifest, dict) or manifest.get("version") != tag[1:]:
        raise RuntimeError("The release tag does not match its package version.")
    return {"version": tag, "commit": commit}


def read_request():
    # The app can write to this directory. Accept only one small regular file
    # and parse it as data. Never follow links or run commands from it.
    try:
        fd = os.open(REQUEST, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as request:
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 1024:
            raise ValueError("Invalid update request file.")
        data = json.loads(request.read(1025))
    if not isinstance(data, dict) or set(data) != {"version", "commit"}:
        raise ValueError("Invalid update request.")
    if not isinstance(data["version"], str) or not TAG.fullmatch(data["version"]):
        raise ValueError("Invalid release version.")
    if not isinstance(data["commit"], str) or not COMMIT.fullmatch(data["commit"]):
        raise ValueError("Invalid release commit.")
    return data


def take_check_request():
    # The app asks for an immediate release check by creating this file. Its
    # content is never read; unlinking does not follow symbolic links.
    try:
        CHECK.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as error:
        print(f"Ignored an invalid release check request: {error}", flush=True)
        return False


def ready():
    probe = ("fetch('http://127.0.0.1:3000/internal/update-ready',"
             "{signal:AbortSignal.timeout(5000)})"
             ".then(r=>r.json()).then(r=>process.exit(r.ready===true?0:1))"
             ".catch(()=>process.exit(1))")
    return run([*COMPOSE, "exec", "-T", "server", "node", "-e", probe],
               timeout=15, check=False).returncode == 0


def start():
    run([*COMPOSE, "up", "-d", "--wait", "--wait-timeout", "240", "server", "caddy"],
        timeout=270)


def image_ids():
    services = json.loads(output([*COMPOSE, "--profile", "build", "config", "--format", "json"]))["services"]
    server = output([*COMPOSE, "ps", "-q", "server"])
    return {
        services["server"]["image"]: output(["docker", "inspect", "--format", "{{.Image}}", server]),
        services["runner-image"]["image"]: output([
            "docker", "image", "inspect", "--format", "{{.Id}}", services["runner-image"]["image"],
        ]),
    }


def restore_previous(recovery):
    previous = recovery["previous"]
    head = git("rev-parse", "HEAD")
    if head != previous:
        if head != recovery["candidate"]:
            raise RuntimeError("The checkout was changed during the update.")
        git("reset", "--keep", previous)
    for name, image_id in recovery["images"].items():
        run(["docker", "image", "tag", image_id, name])
    start()


def finish(current, phase, message):
    REQUEST.unlink(missing_ok=True)
    current.update(phase=phase, message=message, heartbeat=now())
    if phase == "succeeded":
        current.update(available=None, checkedAt=None)
    save(STATUS, current)
    try:
        RECOVERY.unlink(missing_ok=True)
    except OSError as error:
        print(f"Could not clean up the completed update journal: {error}", flush=True)


def failed(current, error):
    print(f"Browser update failed: {error}", flush=True)
    if RECOVERY.exists():
        try:
            restore_previous(json.loads(RECOVERY.read_text()))
        except (OSError, RuntimeError, subprocess.SubprocessError) as rollback_error:
            print(f"Could not restart the previous version: {rollback_error}", flush=True)
            current.update(available=None, checkedAt=None)
            finish(current, "failed",
                   "Update failed and the previous version could not start. Check the updater log and use the matching backup if recovery is needed.")
            return
    finish(current, "failed",
           "Update failed. Workspace kept the previous version. Check the updater log for details.")


def tick():
    current = {
        "phase": "idle", "heartbeat": now(), "checkedAt": None, "checkFailed": False,
        "available": None, "target": None, "message": None,
    }
    if STATUS.exists():
        current.update(json.loads(STATUS.read_text()))
    if current["phase"] == "updating":
        failed(current, RuntimeError("The host updater was interrupted."))
        return
    if RECOVERY.exists():
        # The result was already recorded, but the previous process exited
        # before it removed its journal.
        RECOVERY.unlink()
    current["heartbeat"] = now()
    try:
        requested = read_request()
        if requested:
            if requested != current["available"] or current["checkFailed"]:
                raise ValueError("The approved release is no longer available.")
            current.update(phase="waiting", target=requested, message=None)
            save(STATUS, current)
            if not ready():
                return
            previous = git("rev-parse", "HEAD")
            if git("status", "--porcelain"):
                raise RuntimeError("The Workspace checkout contains local changes.")
            commit = resolve_tag(requested["version"])
            if commit != requested["commit"] or commit == previous or not ancestor(previous, commit):
                current.update(available=None, checkedAt=None)
                raise ValueError("The release changed or no longer fast-forwards the checkout.")
            current.update(phase="updating", heartbeat=now())
            save(STATUS, current)
            if not ready():
                current.update(phase="waiting")
                save(STATUS, current)
                return
            save(RECOVERY, {"previous": previous, "candidate": commit, "images": image_ids()})
            git("merge", "--ff-only", commit)
            run([*COMPOSE, "build", "server", "runner-image"], timeout=1800)
            run(["./ops/backup.sh", "--keep-stopped"], timeout=360)
            start()
            finish(current, "succeeded", None)
            return
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        failed(current, error)
        return
    if current["phase"] == "waiting":
        current.update(phase="idle", target=None)
    if take_check_request() or now() - (current["checkedAt"] or 0) >= CHECK_INTERVAL_MS:
        try:
            current.update(available=latest(git("rev-parse", "HEAD")), checkFailed=False)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            print(f"Release check failed: {error}", flush=True)
            current.update(available=None, checkFailed=True)
        current["checkedAt"] = now()
    current["heartbeat"] = now()
    save(STATUS, current)


if __name__ == "__main__":
    os.environ.update(GIT_TERMINAL_PROMPT="0", WORKSPACE_MAINTENANCE_LOCKED="1")
    with (ROOT / "maintenance.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit(0)
        tick()
