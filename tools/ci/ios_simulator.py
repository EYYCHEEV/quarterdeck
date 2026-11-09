import http.client
import json
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

LINE = "iOS typing lane: "
RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.iOS-"
SESSION_SECONDS = 240
MESSAGE_LIMIT = 200
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
USAGE = "usage: ios_simulator.py pick WANTED MODEL | port | wait NAME URL SECONDS | session URL UDID"


def fail(message):
    print(LINE + message, file=sys.stderr)
    return 1


def runtime_version(runtime):
    if not runtime.startswith(RUNTIME_PREFIX):
        return None
    try:
        return tuple(int(part) for part in runtime[len(RUNTIME_PREFIX):].split("-"))
    except ValueError:
        return None


def pick(listing, wanted, model):
    prefix = tuple(int(part) for part in wanted.split("."))
    found = []
    for runtime, devices in listing["devices"].items():
        version = runtime_version(runtime)
        if version is None or version[:len(prefix)] != prefix:
            continue
        for device in devices:
            if device["name"] == model and device.get("isAvailable", True):
                found.append((version, device["udid"]))
    if not found:
        return None
    newest = max(version for version, udid in found)
    udid = min(udid for version, udid in found if version == newest)
    return udid, ".".join(str(part) for part in newest)


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def request(method, url, body=None):
    data = None if body is None else json.dumps(body).encode()
    call = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with OPENER.open(call, timeout=SESSION_SECONDS) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        status, raw = error.code, error.read()
        error.close()
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {}
    return status, payload


def command_pick(wanted, model):
    if not re.fullmatch(r"[0-9]+(\.[0-9]+)*", wanted):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        chosen = pick(json.load(sys.stdin), wanted, model)
    except (ValueError, KeyError, AttributeError, TypeError):
        return fail("the simulator list could not be read")
    if chosen is None:
        return fail(f"no ready iOS {wanted} simulator named {model}")
    print(f"QD_UDID={chosen[0]}")
    print(f"QD_RUNTIME={chosen[1]}")
    return 0


def command_port():
    print(free_port())
    return 0


def command_wait(name, url, seconds):
    deadline = time.monotonic() + float(seconds)
    while True:
        try:
            with OPENER.open(url, timeout=5):
                return 0
        except urllib.error.HTTPError as error:
            error.close()
            return 0
        except (OSError, http.client.HTTPException):
            pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return fail(f"{name} did not answer within {float(seconds):g} seconds")
        time.sleep(min(0.5, remaining))


def command_session(base, udid):
    capabilities = {"platformName": "iOS", "safari:useSimulator": True, "safari:deviceUDID": udid}
    try:
        status, payload = request("POST", base + "/session", {"capabilities": {"alwaysMatch": capabilities}})
    except (OSError, http.client.HTTPException):
        return fail("safaridriver did not answer the session request")
    value = payload.get("value") if isinstance(payload, dict) else None
    value = value if isinstance(value, dict) else {}
    session = value.get("sessionId")
    if status != 200 or not session:
        message = " ".join(str(value.get("message", "")).split())[:MESSAGE_LIMIT]
        if "remote automation" in message.lower():
            return fail("Remote Automation is not on in the simulator")
        detail = f": {message}" if message else ""
        return fail(f"safaridriver refused the session ({value.get('error', status)}){detail}")
    try:
        closed, answer = request("DELETE", base + "/session/" + urllib.parse.quote(str(session), safe=""))
    except (OSError, http.client.HTTPException):
        closed = None
    if closed != 200:
        return fail("safaridriver could not close the preflight session")
    print(LINE + "one session was created and closed on the simulator")
    return 0


COMMANDS = {
    "pick": (command_pick, 2),
    "port": (command_port, 0),
    "wait": (command_wait, 3),
    "session": (command_session, 2),
}


def main(argv):
    command = COMMANDS.get(argv[1]) if len(argv) > 1 else None
    if command is None or len(argv) - 2 != command[1]:
        print(USAGE, file=sys.stderr)
        return 2
    return command[0](*argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
