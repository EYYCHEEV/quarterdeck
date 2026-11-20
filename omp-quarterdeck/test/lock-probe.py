import fcntl
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(75)
sys.exit(0)
