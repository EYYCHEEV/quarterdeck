import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys

HELPER = pathlib.Path(__file__).resolve().with_name("safe_unpack.py")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
USAGE = "usage: wake_archive_check.py pack SOURCE VERSION OUTPUT | test ARCHIVE VERSION | check COMMIT"


def run(command, **options):
    code = subprocess.run(command, **options).returncode
    if code:
        sys.exit(f"{command[0]} exited with {code}")


def pipe(producer, consumer, **options):
    left = subprocess.Popen(producer, stdout=subprocess.PIPE)
    right = subprocess.Popen(consumer, stdin=left.stdout, **options)
    left.stdout.close()
    codes = [right.wait(), left.wait()]
    if any(codes):
        sys.exit(f"{producer[0]} | {consumer[0]} exited with {codes}")


def new_folder():
    made = subprocess.run(["mktemp", "-d"], check=True, capture_output=True, text=True)
    return made.stdout.rstrip("\n")


def name_of(version):
    if not VERSION.fullmatch(version):
        sys.exit("bad version")
    return f"quarterdeck-omp-wake-{version}"


def pack(source, version, output):
    name = name_of(version)
    target = pathlib.Path(output) / f"{name}.tar.gz"
    with open(target, "wb") as handle:
        pipe(
            [
                "tar", "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
                "--transform", f"s,^omp-quarterdeck,{name},",
                "-cf", "-", "-C", str(source), "omp-quarterdeck",
            ],
            ["gzip", "-n", "-9"],
            stdout=handle,
        )
    return target


def test(archive, version):
    name = name_of(version)
    folder = new_folder()
    try:
        unpacked = os.path.join(folder, "extension")
        run([sys.executable, str(HELPER), str(archive), unpacked])
        parent = os.path.dirname(folder)
        print(f"unpack parent: {parent} {stat.S_IMODE(os.stat(parent).st_mode):o}", flush=True)
        run(["bun", "test"], cwd=os.path.join(unpacked, name))
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def check(commit):
    folder = new_folder()
    try:
        source = os.path.join(folder, "source")
        os.mkdir(source)
        pipe(["git", "archive", "--format=tar", commit], ["tar", "-x", "-C", source])
        with open(os.path.join(source, "omp-quarterdeck", "package.json"), encoding="utf-8") as handle:
            version = json.load(handle)["version"]
        test(pack(source, version, folder), version)
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def main(arguments):
    if len(arguments) == 4 and arguments[0] == "pack":
        pack(*arguments[1:])
    elif len(arguments) == 3 and arguments[0] == "test":
        test(*arguments[1:])
    elif len(arguments) == 2 and arguments[0] == "check":
        check(arguments[1])
    else:
        sys.exit(USAGE)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
