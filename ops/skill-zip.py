"""Translate a bounded ZIP to and from file entries without extracting paths."""
import base64
import io
import json
import stat
import sys
import zipfile

MAX_BYTES = 20 * 1024 * 1024
MAX_FILES = 500
MAX_ARCHIVE_BYTES = 22 * 1024 * 1024


def import_zip():
    archive = sys.stdin.buffer.read(MAX_ARCHIVE_BYTES + 1)
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("The ZIP is too large.")
    with zipfile.ZipFile(io.BytesIO(archive)) as source:
        members = source.infolist()
        if len(members) > MAX_FILES * 2:
            raise ValueError("The ZIP has too many entries.")
        files = []
        total = 0
        for member in members:
            name = member.orig_filename
            mode = member.external_attr >> 16
            if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("Links and special files are not supported.")
            if name.startswith("__MACOSX/") or name.rsplit("/", 1)[-1] == ".DS_Store":
                continue
            if member.is_dir():
                continue
            if len(files) >= MAX_FILES or total + member.file_size > MAX_BYTES:
                raise ValueError("The archive exceeds 500 files or 20 MB unpacked.")
            with source.open(member) as entry:
                data = entry.read(MAX_BYTES - total + 1)
            total += len(data)
            if total > MAX_BYTES:
                raise ValueError("The archive exceeds 20 MB unpacked.")
            files.append({"path": name, "data": base64.b64encode(data).decode("ascii")})
        return json.dumps(files).encode()


def export_zip():
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for entry in json.load(sys.stdin):
            archive.writestr(entry["path"], base64.b64decode(entry["data"], validate=True))
    return result.getvalue()


if __name__ == "__main__":
    try:
        sys.stdout.buffer.write(import_zip() if sys.argv[1] == "import" else export_zip())
    except ValueError as error:
        sys.stderr.write(str(error)[:200])
        sys.exit(2)
    except (RuntimeError, OSError, zipfile.BadZipFile, NotImplementedError):
        sys.exit(1)
