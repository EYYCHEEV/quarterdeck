from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: check_bundle.py <qd-web folder> <built app folder>", file=sys.stderr)
        return 2
    sys.path.insert(0, os.path.abspath(sys.argv[1]))
    sys.path.insert(1, os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "approval"))
    sys.path.insert(2, os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), "shared"))
    import bundle

    try:
        loaded = bundle.Bundle.load(os.path.abspath(sys.argv[2]))
    except bundle.BundleRefused as refusal:
        print(f"refused: {refusal}")
        return 1
    long_cache = [path for path in loaded.paths if bundle.HASHED_CHUNK.fullmatch(path)]
    scripts = [path for path in loaded.paths if path.endswith(".js")]
    for path in loaded.paths:
        print(f"served  {path}")
    for path in loaded.skipped:
        print(f"skipped {path}")
    print(f"content policy: {loaded.csp}")
    print(f"files served: {len(loaded.paths)}; files skipped: {len(loaded.skipped)}")
    print(f"script files with the long cache rule: {len(long_cache)} of {len(scripts)}")
    for route in ("/", "/chat/iris", "/settings", "/index.html"):
        print(f"route {route}: {'page' if loaded.has(route) else 'not served'}")
    if loaded.skipped or not all(loaded.has(route) for route in ("/", "/chat/iris")):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
