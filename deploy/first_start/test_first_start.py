import copy
import json
import unittest
from pathlib import Path

import first_start


POLICY_PATH = Path(__file__).resolve().parents[1] / "door" / "door-policy.json"
POLICY = json.loads(POLICY_PATH.read_text(encoding="utf-8"))



class FakeManagement:
    def __init__(self, state, *, fail_at=None, corrupt_readback=None):
        self.state = copy.deepcopy(state)
        self.fail_at = fail_at
        self.corrupt_readback = corrupt_readback
        self.singleton_gets = []
        self.write_count = 0

    def call(self, method, arguments, call_id):
        if method.endswith("/get"):
            name = method[2:-4]
            if name in first_start.SINGLETONS:
                expected_properties = ["id", *POLICY["singletons"][name]]
                if arguments != {
                    "ids": ["singleton"],
                    "properties": expected_properties,
                }:
                    raise AssertionError(f"{name} singleton read is not bounded by id and properties")
                self.singleton_gets.append(name)
            result = {"list": copy.deepcopy(self.state[name])}
            if self.corrupt_readback == "listener" and name == "NetworkListener" and self.write_count >= 14:
                result["list"][0]["maxConnections"] += 1
            if self.corrupt_readback == "application" and name == "Application" and self.write_count >= 14:
                result["list"][0].pop("enable")
            return result

        self.write_count += 1
        if self.fail_at == self.write_count:
            self.fail_at = None
            raise RuntimeError("stand-in rejected one write")

        name = method[2:-4]
        if "update" in arguments:
            updates = arguments["update"]
            if set(updates) == {"singleton"}:
                singleton = copy.deepcopy(updates["singleton"])
                singleton["id"] = "singleton"
                self.state[name] = [singleton]
            else:
                by_id = {item["id"]: item for item in self.state[name]}
                for identifier, value in updates.items():
                    by_id[identifier] = {
                        **by_id[identifier],
                        **copy.deepcopy(value),
                        "id": identifier,
                    }
                self.state[name] = list(by_id.values())
            return {"updated": {identifier: {} for identifier in updates}}

        current = self.state[name]
        destroyed = set(arguments.get("destroy", []))
        kept = [item for item in current if item.get("id") not in destroyed]
        created = []
        for creation_id, value in arguments.get("create", {}).items():
            item = copy.deepcopy(value)
            item["id"] = "created-" + creation_id
            created.append(item)
        self.state[name] = kept + created
        return {"created": {creation_id: {} for creation_id in arguments.get("create", {})}}


def old_state():
    return {
        "Http": [{"id": "singleton", "enableHsts": False}],
        "Security": [{"id": "singleton", "authBanPeriod": 1}],
        "Email": [{"id": "singleton", "maxMessageSize": 1}],
        "Jmap": [{"id": "singleton", "maxMethodCalls": 1}],
        "Asn": [{"id": "singleton", "@type": "Resource", "asnUrls": {"old": "old"}, "geoUrls": {}}],
        "SpamSettings": [{"id": "singleton", "enable": True, "spamFilterRulesUrl": "file:///old"}],
        "MtaStageRcpt": [{"id": "singleton", "maxRecipients": {"match": {}, "else": "9"}}],
        "MtaStageAuth": [{"id": "singleton", "mustMatchSender": {"match": {}, "else": "false"}}],
        "MtaStageData": [{"id": "singleton", "script": {"match": {}, "else": "''"}}],
        "EventTracingLevel": [{"id": "old-event", "event": "old", "level": "debug"}],
        "SieveSystemScript": [],
        "Application": [
            {
                "id": "application-a",
                "resourceUrl": "https://example.invalid/old-a.zip",
                "autoUpdateInterval": 1000,
                "unpackDirectory": "/tmp/old-a",
                "enable": True,
            },
            {
                "id": "application-b",
                "resourceUrl": "https://example.invalid/old-b.zip",
                "autoUpdateInterval": 2000,
                "unpackDirectory": "/tmp/old-b",
                "enable": True,
            },
        ],
        "Domain": [{
            "id": "domain-1",
            "name": POLICY["mailDomain"],
            "allowRelaying": True,
            "catchAllAddress": "catchall",
            "subAddressing": {"@type": "Plus"},
        }],
        "NetworkListener": [
            {
                "id": "old-listener",
                "name": "old-loopback",
                "bind": {"loopback-test": True},
                "protocol": "http",
                "useTls": False,
                "implicitTls": False,
                "maxConnections": 1,
                "overrideProxyTrustedNetworks": {},
            }
        ],
    }

def semantic(state):
    return {
        name: sorted(
            [{key: value for key, value in item.items() if key != "id"} for item in items],
            key=lambda value: json.dumps(value, sort_keys=True),
        )
        for name, items in state.items()
    }


class FirstStartTests(unittest.TestCase):
    def test_every_failed_write_rolls_back_then_a_retry_reaches_exact_policy(self):
        policy = copy.deepcopy(POLICY)
        expected_old = old_state()
        for fail_at in range(1, 15):
            with self.subTest(fail_at=fail_at):
                client = FakeManagement(expected_old, fail_at=fail_at)
                with self.assertRaises(first_start.FirstStartError):
                    first_start.apply_policy(client, policy)
                self.assertEqual(semantic(client.state), semantic(expected_old))

                proof = first_start.apply_policy(client, policy)
                self.assertEqual(proof["managementWrites"], 14)
                first_start.verify_installed(client, policy)
                self.assertEqual(set(client.singleton_gets), set(first_start.SINGLETONS))

    def test_bad_readback_rolls_back(self):
        policy = copy.deepcopy(POLICY)
        expected_old = old_state()
        client = FakeManagement(expected_old, corrupt_readback="listener")
        with self.assertRaises(first_start.FirstStartError):
            first_start.apply_policy(client, policy)
        self.assertEqual(semantic(client.state), semantic(expected_old))

    def test_application_readback_requires_every_field_and_a_nonempty_list(self):
        policy = copy.deepcopy(POLICY)
        expected_old = old_state()
        client = FakeManagement(expected_old, corrupt_readback="application")
        with self.assertRaises(first_start.FirstStartError):
            first_start.apply_policy(client, policy)
        self.assertEqual(semantic(client.state), semantic(expected_old))

        empty_application = old_state()
        empty_application["Application"] = []
        client = FakeManagement(empty_application)
        with self.assertRaises(first_start.FirstStartError):
            first_start.apply_policy(client, policy)
        self.assertEqual(semantic(client.state), semantic(empty_application))


if __name__ == "__main__":
    unittest.main(verbosity=2)
