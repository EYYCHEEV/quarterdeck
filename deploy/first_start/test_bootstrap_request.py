import json
import unittest
from pathlib import Path


REQUEST = Path(__file__).with_name("bootstrap-request.json")


class BootstrapRequestTests(unittest.TestCase):
    def test_bootstrap_is_fixed_to_private_stores_manual_dns_and_no_stalwart_certificate(self):
        document = json.loads(REQUEST.read_text(encoding="utf-8"))
        self.assertEqual(document["using"], ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"])
        self.assertEqual(len(document["methodCalls"]), 1)
        method, arguments, call_id = document["methodCalls"][0]
        self.assertEqual((method, call_id), ("x:Bootstrap/set", "bootstrap"))
        settings = arguments["update"]["singleton"]
        self.assertEqual(
            settings["defaultHostname"],
            "${deployment:hostname}",
        )
        self.assertEqual(
            settings["defaultDomain"],
            "${deployment:mail-domain}",
        )
        self.assertIs(settings["requestTlsCertificate"], False)
        self.assertIs(settings["generateDkimKeys"], False)
        self.assertEqual(settings["dataStore"], {"@type": "RocksDb", "path": "/var/lib/stalwart/data"})
        self.assertEqual(settings["blobStore"], {"@type": "Default"})
        self.assertEqual(settings["searchStore"], {"@type": "Default"})
        self.assertEqual(settings["inMemoryStore"], {"@type": "Default"})
        self.assertEqual(settings["directory"], {"@type": "Internal"})
        self.assertEqual(
            settings["tracer"],
            {"@type": "Log", "path": "/var/log/stalwart", "ansi": False, "level": "info"},
        )
        self.assertEqual(settings["dnsServer"], {"@type": "Manual"})
        serialized = REQUEST.read_text(encoding="utf-8").lower()
        self.assertNotIn("password", serialized)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("api_", serialized)


if __name__ == "__main__":
    unittest.main(verbosity=2)
