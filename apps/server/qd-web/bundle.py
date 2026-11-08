from __future__ import annotations

import base64
import hashlib
import os
import re
import stat
from dataclasses import dataclass
from urllib.parse import urlsplit

import approval_app


MAX_FILES = 4096
MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 128 * 1024 * 1024
POLICY_TAIL = "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
LONG_CACHE = "public, max-age=31536000, immutable"
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/vnd.microsoft.icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".txt": "text/plain; charset=utf-8",
}
FILE_PATH = re.compile(r"/[A-Za-z0-9._~@+=-]+(?:/[A-Za-z0-9._~@+=-]+)*")
HASHED_CHUNK = re.compile(r"/chunk-[A-Z0-9]{8}\.js")
SEGMENT = r"[A-Za-z0-9._~%-]{1,128}"
APP_PATH = re.compile(
    rf"/|/queue|/queue/{SEGMENT}|/lanes/{SEGMENT}|/projects|/projects/{SEGMENT}"
    rf"|/projects/{SEGMENT}/pages|/projects/{SEGMENT}/pages/{SEGMENT}"
    rf"|/projects/{SEGMENT}/artifacts/{SEGMENT}|/chat/{SEGMENT}|/mail|/mail/{SEGMENT}"
    rf"|/settings|/settings/{SEGMENT}|/settings/bots/{SEGMENT}"
)
INLINE_SCRIPT = re.compile(rb"<script\b([^>]*)>(.*?)</script\s*>", re.IGNORECASE | re.DOTALL)
SOURCE_ATTRIBUTE = re.compile(rb"(?:^|\s)src\s*=", re.IGNORECASE)


class BundleRefused(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class Entry:
    body: bytes
    content_type: str
    cache: str
    etag: str | None


def _policy(page: bytes) -> str:
    hashes: list[str] = []
    for attributes, body in INLINE_SCRIPT.findall(page):
        if SOURCE_ATTRIBUTE.search(attributes):
            continue
        digest = "'sha256-" + base64.b64encode(hashlib.sha256(body).digest()).decode("ascii") + "'"
        if digest not in hashes:
            hashes.append(digest)
    scripts = "" if not hashes else "script-src 'self' " + " ".join(hashes) + "; "
    return "default-src 'self'; " + scripts + POLICY_TAIL


def _offered(request: approval_app.Request) -> set[str]:
    value = next(
        (
            offered
            for name, offered in request.headers.items()
            if name.lower() == "if-none-match"
        ),
        "",
    )
    return {item.strip().removeprefix("W/") for item in value.split(",")}


def _read(path: str, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise BundleRefused("bundle file is not a plain file")
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise BundleRefused("bundle file is too large")
    return data


class Bundle:
    def __init__(self, entries: dict[str, Entry], page: Entry, csp: str, skipped: tuple[str, ...]) -> None:
        self._entries = entries
        self._page = page
        self.csp = csp
        self.skipped = skipped

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(sorted(self._entries))

    @classmethod
    def load(
        cls,
        root: str,
        *,
        max_files: int = MAX_FILES,
        max_file_bytes: int = MAX_FILE_BYTES,
        max_total_bytes: int = MAX_TOTAL_BYTES,
    ) -> "Bundle":
        if not isinstance(root, str) or not root.startswith("/") or "\0" in root:
            raise BundleRefused("bundle folder is invalid")
        try:
            top = os.stat(root)
        except OSError:
            raise BundleRefused("bundle folder is invalid") from None
        if not stat.S_ISDIR(top.st_mode):
            raise BundleRefused("bundle folder is invalid")
        entries: dict[str, Entry] = {}
        skipped: list[str] = []
        seen = 0
        total = 0
        for folder, names, files in os.walk(root, followlinks=False):
            relative_folder = os.path.relpath(folder, root)
            prefix = "" if relative_folder == "." else relative_folder + "/"
            kept = []
            for name in sorted(names):
                if name.startswith(".") or os.path.islink(os.path.join(folder, name)):
                    skipped.append(prefix + name + "/")
                else:
                    kept.append(name)
            names[:] = kept
            for name in sorted(files):
                seen += 1
                if seen > max_files:
                    raise BundleRefused("bundle has too many files")
                relative = prefix + name
                full = os.path.join(folder, name)
                metadata = os.lstat(full)
                url = "/" + relative
                extension = os.path.splitext(name)[1].lower()
                if (
                    not stat.S_ISREG(metadata.st_mode)
                    or name.startswith(".")
                    or extension not in TYPES
                    or FILE_PATH.fullmatch(url) is None
                    or url == "/captain"
                    or url.startswith("/captain/")
                ):
                    skipped.append(relative)
                    continue
                if metadata.st_size > max_file_bytes:
                    raise BundleRefused("bundle file is too large")
                total += metadata.st_size
                if total > max_total_bytes:
                    raise BundleRefused("bundle is too large")
                data = _read(full, max_file_bytes)
                is_page = url == "/index.html"
                if is_page:
                    cache, etag = "no-store", None
                else:
                    cache = LONG_CACHE if HASHED_CHUNK.fullmatch(url) else "no-cache"
                    etag = '"' + hashlib.sha256(data).hexdigest() + '"'
                entries[url] = Entry(data, TYPES[extension], cache, etag)
        page = entries.get("/index.html")
        if page is None:
            raise BundleRefused("bundle has no index.html")
        return cls(entries, page, _policy(page.body), tuple(sorted(skipped)))

    def _find(self, path: str) -> Entry | None:
        entry = self._entries.get(path)
        if entry is None and APP_PATH.fullmatch(path) is not None:
            return self._page
        return entry

    def has(self, path: str) -> bool:
        return self._find(path) is not None

    def serve(self, request: approval_app.Request) -> approval_app.Response | None:
        if request.method not in {"GET", "HEAD"}:
            return None
        parsed = urlsplit(request.path)
        if parsed.scheme or parsed.netloc or parsed.fragment:
            return None
        entry = self._find(parsed.path)
        if entry is None:
            return None
        matched = entry.etag is not None and entry.etag in _offered(request)
        headers = [
            ("Content-Type", entry.content_type),
            ("Cache-Control", entry.cache),
        ]
        if entry.etag is not None:
            headers.append(("ETag", entry.etag))
        headers.extend(
            (
                ("Content-Security-Policy", self.csp),
                ("Referrer-Policy", "no-referrer"),
                ("X-Content-Type-Options", "nosniff"),
                ("X-Frame-Options", "DENY"),
                ("Content-Length", "0" if matched else str(len(entry.body))),
            )
        )
        if matched:
            return approval_app.Response(304, tuple(headers), b"")
        body = b"" if request.method == "HEAD" else entry.body
        return approval_app.Response(200, tuple(headers), body)
