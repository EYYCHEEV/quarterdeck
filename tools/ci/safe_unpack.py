import os
import posixpath
import stat
import sys
import tarfile
import zipfile


def refuse(reason):
    sys.exit("unsafe archive: " + reason)


def check_names(names):
    seen = set()
    for name in names:
        if not name or name.startswith("/") or "\\" in name or "\x00" in name:
            refuse("bad member name")
        parts = name.rstrip("/").split("/")
        if ".." in parts or "" in parts:
            refuse("bad member name")
        normal = posixpath.normpath(name)
        if normal in seen:
            refuse("duplicate member name")
        seen.add(normal)


def unpack_zip(path, destination):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        check_names([member.filename for member in members])
        for member in members:
            kind = stat.S_IFMT(member.external_attr >> 16)
            if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                refuse("link or device member")
        os.makedirs(destination)
        archive.extractall(destination)


def unpack_tar(path, destination):
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        check_names([member.name for member in members])
        for member in members:
            if not (member.isreg() or member.isdir()):
                refuse("link or device member")
        os.makedirs(destination)
        archive.extractall(destination, members=members, filter="data")


source, destination = sys.argv[1], sys.argv[2]
if source.endswith(".whl"):
    unpack_zip(source, destination)
elif source.endswith((".tar.gz", ".tar")):
    unpack_tar(source, destination)
else:
    refuse("unknown archive type")
