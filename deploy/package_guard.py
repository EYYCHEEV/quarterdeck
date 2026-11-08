import importlib.util
import hashlib
import json
import os
import stat
import sys
from functools import cache
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[1]

GUARDED = (
    ("signup_flow.py", Path("signup") / "signup_flow.py", Path("apps") / "server" / "join" / "signup_flow.py"),
    ("qd_jmap.py", Path("mail") / "qd_jmap.py", Path("apps") / "server" / "mail" / "qd_jmap.py"),
)

ARCHIVE_PREFIXES = (
    b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08",
    b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00", b"\x28\xb5\x2f\xfd",
    b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07", b"!<arch>\n", b"!<thin>\n",
)


def digest(path):
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            sha.update(block)
    return sha.hexdigest()


def is_archive(path):
    with open(path, "rb") as handle:
        header = handle.read(512)
    return (
        header.startswith(ARCHIVE_PREFIXES)
        or header[257:262] == b"ustar"
        or (len(header) >= 4 and 0x184D2A50 <= int.from_bytes(header[:4], "little") <= 0x184D2A5F)
    )


def regular_digest(path):
    try:
        details = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(details.st_mode):
        return None
    return digest(path)


def reference(repository):
    table = {}
    problems = []
    for name, public_relative, server_relative in GUARDED:
        server = regular_digest(repository / server_relative)
        if server is None:
            problems.append("missing server copy: " + name)
            continue
        public = regular_digest(repository / public_relative)
        if public == server:
            problems.append("the server copy equals the public copy, so the copies are retired and this check goes: " + name)
            continue
        table[name] = (public, server)
    return table, problems


def check_package(package, repository=REPOSITORY):
    package = Path(package)
    repository = Path(repository)
    table, problems = reference(repository)
    try:
        top = os.lstat(package)
    except OSError:
        return problems + ["missing package folder"]
    if not stat.S_ISDIR(top.st_mode):
        return problems + ["package root is not a real folder"]
    public_names = {public: name for name, (public, _) in table.items() if public}
    for base, folders, files in os.walk(package, followlinks=False):
        folders.sort()
        for name in sorted(folders) + sorted(files):
            full = os.path.join(base, name)
            relative = os.path.relpath(full, package)
            details = os.lstat(full)
            if stat.S_ISLNK(details.st_mode):
                problems.append("link: " + relative)
            elif stat.S_ISDIR(details.st_mode):
                continue
            elif not stat.S_ISREG(details.st_mode):
                problems.append("special file: " + relative)
            elif is_archive(full):
                problems.append("archive: " + relative)
            else:
                value = digest(full)
                if value in public_names:
                    problems.append("public copy of " + public_names[value] + ": " + relative)
                elif name in table and value != table[name][1]:
                    problems.append("not the server copy of " + name + ": " + relative)
    return problems


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from strings(key)
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


@cache
def manifest_validator(service):
    name = "package_plan.py" if service == "qd-web" else "packaging_plan.py"
    location = REPOSITORY / "apps" / "server" / service / name
    spec = importlib.util.spec_from_file_location("package_schema_" + service.replace("-", "_"), location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_manifest(manifest, repository=REPOSITORY):
    manifest = Path(manifest)
    table, problems = reference(Path(repository))
    public_names = {public: name for name, (public, _) in table.items() if public}
    try:
        details = os.lstat(manifest)
    except OSError:
        return problems + ["missing manifest: " + manifest.name]
    if not stat.S_ISREG(details.st_mode):
        return problems + ["manifest is not a regular file: " + manifest.name]
    try:
        document = json.loads(manifest.read_text(encoding="utf-8"))
    except ValueError:
        return problems + ["manifest is not JSON: " + manifest.name]
    bases = document.get("bases") if isinstance(document, dict) else None
    service = manifest.parent.name if manifest.parent.name in {"qd-web", "captain-app"} else None
    if service is None and isinstance(bases, dict):
        if set(bases) == {"appRecord"}:
            service = "qd-web"
        elif set(bases) == {"compose", "doorPolicy"}:
            service = "captain-app"
    if service is None:
        problems.append("manifest schema refused: " + manifest.name)
    else:
        validator = manifest_validator(service)
        try:
            validator.validate_manifest_document(document)
        except validator.PackageRefused:
            problems.append("manifest schema refused: " + manifest.name)
    for text in strings(document):
        normalized = text.lower()
        for value, name in public_names.items():
            if value in normalized:
                problems.append("public copy of " + name + " listed in " + manifest.name)
    return problems


def require(packages, repository=REPOSITORY, manifests=()):
    problems = []
    for package in packages:
        label = Path(package).name
        problems.extend(label + ": " + line for line in check_package(package, repository))
    for manifest in manifests:
        problems.extend(check_manifest(manifest, repository))
    if problems:
        for line in problems:
            print("package guard refused", line, file=sys.stderr)
        raise SystemExit(1)


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        print("usage: package_guard.py PACKAGE_FOLDER...", file=sys.stderr)
        return 2
    problems = []
    for package in arguments:
        problems.extend(check_package(package))
    for line in problems:
        print("refused", line)
    if problems:
        return 1
    print("package guard: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
