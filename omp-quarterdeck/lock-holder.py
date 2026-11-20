import fcntl
import os
import signal
import stat
import sys

HELD = 75
FAILED = 2


def stop(signum, frame):
    raise SystemExit(0)


def take(path):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    info = os.fstat(descriptor)
    private = (
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and info.st_uid == os.getuid()
        and stat.S_IMODE(info.st_mode) == 0o600
    )
    if not private:
        raise ValueError
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return descriptor


def hold():
    try:
        os.write(1, b"locked\n")
    except OSError:
        return FAILED
    try:
        while os.read(0, 65536):
            pass
    except OSError:
        return 0
    return 0


def main(arguments):
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if len(arguments) != 2:
        return FAILED
    try:
        descriptor = take(arguments[1])
    except BlockingIOError:
        return HELD
    except Exception:
        return FAILED
    outcome = hold()
    os.close(descriptor)
    return outcome


if __name__ == "__main__":
    sys.exit(main(sys.argv))
