import copy
import ipaddress
import unittest
from pathlib import Path

import door_policy


ROOT = Path(__file__).resolve().parent
POLICY = ROOT / "door-policy.json"
CHAT_BLOCK = ROOT / "chat-route-block.json"


class DoorPolicyTests(unittest.TestCase):
    def test_front_proxy_and_private_stalwart_calls_are_exact(self):
        policy = door_policy.load_policy(POLICY)
        self.assertEqual(door_policy.validate_policy(policy), {
            "stalwart_listeners": 2,
            "caddy_public_https": 1,
            "stalwart_public": 0,
            "bot_permissions": 10,
            "public_routes": 20,
        })
        self.assertEqual(
            policy["publicUrl"],
            f"https://{policy['hostname']}",
        )
        self.assertEqual(policy["frontProxy"]["publishedPorts"], [443])
        self.assertFalse(policy["frontProxy"]["port80"])
        self.assertEqual(policy["frontProxy"]["certificate"], {
            "holder": "caddy",
            "challenge": "tls-alpn-01",
            "disableHttpChallenge": True,
            "automaticRedirects": False,
            "renewalFailureAlert": True,
        })

        calls = door_policy.build_management_calls(
            policy,
            current_listener_ids=["old-listener"],
            current_event_ids=["old-event"],
            current_script_ids=["old-script"],
            current_application_ids=["application-b", "application-a"],
            domain_id="domain-1",
        )
        self.assertEqual([call[0] for call in calls], [
            "x:Http/set",
            "x:Security/set",
            "x:Email/set",
            "x:Jmap/set",
            "x:Asn/set",
            "x:SpamSettings/set",
            "x:MtaStageRcpt/set",
            "x:MtaStageAuth/set",
            "x:MtaStageData/set",
            "x:EventTracingLevel/set",
            "x:SieveSystemScript/set",
            "x:Domain/set",
            "x:Application/set",
            "x:NetworkListener/set",
        ])
        listener_set = calls[-1][1]
        self.assertEqual(listener_set["destroy"], ["old-listener"])
        self.assertEqual(
            listener_set["create"],
            {
                listener["name"]: door_policy.listener_settings(
                    policy,
                    listener,
                )
                for listener in policy["listeners"]
            },
        )
        self.assertEqual(
            calls[-4][1]["create"]["from-match"],
            policy["senderPolicy"]["systemScript"],
        )
        self.assertEqual(calls[-3][1], {
            "update": {"domain-1": policy["localDomainPolicy"]},
        })
        self.assertEqual(calls[-2], (
            "x:Application/set",
            {
                "update": {
                    "application-a": policy["webUi"],
                    "application-b": policy["webUi"],
                },
            },
            "set-web-ui",
        ))
        self.assertEqual(policy["singletons"]["Email"]["maxPublicKeys"], 1)
        self.assertEqual(policy["singletons"]["Jmap"]["maxSnippetResults"], 1)
        for name in ("MtaStageRcpt", "MtaStageAuth", "MtaStageData"):
            with self.subTest(singleton=name):
                for expression in policy["singletons"][name].values():
                    self.assertEqual(expression.get("match"), {})
        self.assertFalse(policy["senderPolicy"]["systemScript"]["contents"].endswith("\n"))
        self.assertEqual(
            policy["singletons"]["Asn"],
            {"@type": "Resource", "asnUrls": {}, "geoUrls": {}},
        )
        self.assertEqual(
            policy["singletons"]["SpamSettings"],
            {
                "enable": False,
                "spamFilterRulesUrl": "file:///msd-absent/spam-filter-rules.json.gz",
            },
        )
        self.assertEqual(
            policy["webUi"],
            {
                "resourceUrl": "file:///msd-absent/webui.zip",
                "autoUpdateInterval": 86400000,
                "unpackDirectory": "/tmp/msd-webui",
                "enable": False,
            },
        )

    def test_jmap_api_route_and_endpoint_expression_are_exact(self):
        policy = door_policy.load_policy(POLICY)
        api_route = next(
            route
            for route in policy["frontProxy"]["routes"]
            if route["matcher"] == "jmap_api"
        )
        self.assertEqual(api_route["methods"], ["POST"])
        self.assertEqual(api_route["path"], "/jmap/")
        self.assertNotIn(
            "/jmap",
            {route["path"] for route in policy["frontProxy"]["routes"]},
        )
        self.assertNotIn(
            "/jmap/*",
            {route["path"] for route in policy["frontProxy"]["routes"]},
        )

        allowed = policy["singletons"]["Http"]["allowedEndpoints"]
        self.assertEqual(allowed, door_policy.EXPECTED_ALLOWED_ENDPOINTS)
        expression = allowed["match"]["0"]["if"]
        self.assertIn("method == 'POST' && path == '/jmap/'", expression)
        self.assertNotIn("method == 'POST' && path == '/jmap'", expression)
        self.assertNotIn("/jmap/*", expression)

        for refused_path in ("/jmap", "/jmap/*"):
            unsafe = copy.deepcopy(policy)
            next(
                route
                for route in unsafe["frontProxy"]["routes"]
                if route["matcher"] == "jmap_api"
            )["path"] = refused_path
            with self.subTest(refused_path=refused_path):
                with self.assertRaises(door_policy.PolicyError):
                    door_policy.validate_policy(unsafe)

    def test_jmap_post_body_limit_matches_request_limit_without_opening_uploads(self):
        policy = door_policy.load_policy(POLICY)
        jmap = policy["singletons"]["Jmap"]
        self.assertEqual(jmap["maxRequestSize"], 1048576)
        self.assertEqual(jmap["maxUploadSize"], jmap["maxRequestSize"])
        self.assertEqual(
            {
                key: jmap[key]
                for key in (
                    "maxConcurrentUploads",
                    "maxUploadCount",
                    "uploadQuota",
                )
            },
            {
                "maxConcurrentUploads": 1,
                "maxUploadCount": 1,
                "uploadQuota": 1,
            },
        )
        self.assertNotIn(
            "/jmap/upload",
            {route["path"] for route in policy["frontProxy"]["routes"]},
        )
        self.assertNotIn(
            "unlimitedUploads",
            policy["botApiKey"]["permissions"],
        )

    def test_caddyfile_is_443_only_exact_and_passes_real_client_addresses(self):
        policy = door_policy.load_policy(POLICY)
        caddyfile = door_policy.build_caddyfile(policy)
        caddy = policy["deployment"]["endpoints"]["caddy"]
        self.assertIn("auto_https disable_redirects", caddyfile)
        self.assertIn("disable_http_challenge", caddyfile)
        self.assertIn(
            f"https://{policy['hostname']}:{caddy['port']}",
            caddyfile,
        )
        self.assertNotRegex(caddyfile, r"(?m)^\s*:80\b")
        self.assertEqual(caddyfile.count("proxy_protocol v2"), 3)
        self.assertNotIn("/jmap/*", caddyfile)
        self.assertNotIn("/jmap/upload", caddyfile)
        self.assertNotIn("/jmap/download", caddyfile)
        self.assertNotIn("/jmap/eventsource", caddyfile)
        for route in policy["frontProxy"]["routes"]:
            self.assertIn(route["path"], caddyfile)
        self.assertIn("respond @known_public_path 405", caddyfile)
        self.assertTrue(caddyfile.rstrip().endswith("}"))
        self.assertIn("respond 404", caddyfile)
        for path in (
            "/captain/chat",
            "/captain/assets/chat.css",
            "/captain/assets/chat.js",
            "/captain/api/chats",
            "/captain/api/chat",
            "/captain/events",
        ):
            self.assertNotIn(path, caddyfile)
        self.assertNotIn("captain-app", caddyfile)

    def test_chat_route_block_is_separate_off_by_default_and_exact_when_enabled(self):
        policy = door_policy.load_policy(POLICY)
        block = door_policy.load_chat_block(CHAT_BLOCK)

        default = door_policy.build_caddyfile(
            policy,
            chat_block=block,
        )
        self.assertNotIn("captain-app", default)
        self.assertNotIn("/captain/chat", default)

        enabled = door_policy.build_caddyfile(
            policy,
            chat_block=block,
            enable_chat=True,
        )
        self.assertEqual(
            enabled.count("reverse_proxy captain-app:8080"),
            4,
        )
        for route in block["routes"]:
            for path in route["paths"]:
                self.assertIn(path, enabled)
        self.assertIn("request_body", enabled)
        self.assertIn("max_size 16KB", enabled)
        self.assertNotIn("path /*", enabled)
        self.assertNotRegex(enabled, r"(?m)^\s*:80\b")

        for change in (
            lambda value: value.update(default="on"),
            lambda value: value.update(upstream="captain-app:80"),
            lambda value: value["routes"][0].update(paths=["/*"]),
            lambda value: value["routes"][2].pop("maxBody"),
        ):
            unsafe = copy.deepcopy(block)
            change(unsafe)
            with self.assertRaises(door_policy.PolicyError):
                door_policy.build_caddyfile(
                    policy,
                    chat_block=unsafe,
                    enable_chat=True,
                )

    def test_client_failures_ban_the_client_and_never_caddy(self):
        policy = door_policy.load_policy(POLICY)
        trusted = ipaddress.ip_network(
            door_policy.trusted_caddy_network(policy)
        )
        endpoints = policy["deployment"]["endpoints"]
        caddy = ipaddress.ip_address(endpoints["caddy"]["address"])
        client = ipaddress.ip_address("192.0.2.23")
        self.assertIn(caddy, trusted)

        def remote_address(peer, presented):
            if peer != caddy or peer not in trusted:
                raise door_policy.PolicyError("untrusted PROXY protocol peer")
            return presented

        counts = {}
        for _ in range(policy["singletons"]["Security"]["authBanRate"]["count"]):
            peer = remote_address(caddy, client)
            counts[peer] = counts.get(peer, 0) + 1
        self.assertEqual(counts[client], 5)
        self.assertNotIn(caddy, counts)
        with self.assertRaises(door_policy.PolicyError):
            remote_address(
                ipaddress.ip_address(endpoints["join"]["address"]),
                client,
            )
        self.assertEqual(
            door_policy.trusted_caddy_network(policy),
            f"{endpoints['caddy']['address']}/32",
        )
        self.assertTrue(
            policy["frontProxy"]["applicationForwarding"][
                "rejectUntrustedForwarding"
            ]
        )

    def test_readback_must_match_every_security_control(self):
        policy = door_policy.load_policy(POLICY)
        calls = door_policy.build_management_calls(
            policy,
            current_listener_ids=[],
            current_event_ids=[],
            current_script_ids=[],
            current_application_ids=["application-a", "application-b"],
            domain_id="domain-1",
        )
        readback = copy.deepcopy(policy["singletons"])
        readback["EventTracingLevel"] = [{"id": "event-id", **policy["eventLevels"][0]}]
        readback["SieveSystemScript"] = [{"id": "script-id", **policy["senderPolicy"]["systemScript"]}]
        readback["Domain"] = {"id": "domain-1", "name": policy["mailDomain"], **policy["localDomainPolicy"]}
        readback["Application"] = [
            {"id": identifier, **policy["webUi"]}
            for identifier in ("application-a", "application-b")
        ]
        readback["NetworkListener"] = [
            {"id": f"listener-{index}", **listener}
            for index, listener in enumerate(calls[-1][1]["create"].values())
        ]
        door_policy.verify_readback(policy, readback)
        live_shape = copy.deepcopy(readback)
        trusted = live_shape["NetworkListener"][0]["overrideProxyTrustedNetworks"]
        address = next(iter(trusted)).removesuffix("/32")
        live_shape["NetworkListener"][0]["overrideProxyTrustedNetworks"] = {address: True}
        door_policy.verify_readback(policy, live_shape)


        unsafe = copy.deepcopy(readback)
        unsafe["NetworkListener"][0][
            "overrideProxyTrustedNetworks"
        ] = {policy["deployment"]["serviceNetwork"]: True}
        with self.assertRaisesRegex(door_policy.PolicyError, "readback"):
            door_policy.verify_readback(policy, unsafe)

        unsafe = copy.deepcopy(readback)
        unsafe["Domain"]["allowRelaying"] = True
        with self.assertRaisesRegex(door_policy.PolicyError, "readback"):
            door_policy.verify_readback(policy, unsafe)

        unsafe = copy.deepcopy(readback)
        unsafe["Application"][0].pop("enable")
        with self.assertRaisesRegex(door_policy.PolicyError, "readback Application"):
            door_policy.verify_readback(policy, unsafe)

        unsafe = copy.deepcopy(readback)
        unsafe["Application"] = []
        with self.assertRaisesRegex(door_policy.PolicyError, "readback Application"):
            door_policy.verify_readback(policy, unsafe)

    def test_unsafe_policy_variants_fail_closed(self):
        original = door_policy.load_policy(POLICY)
        mutations = []

        def mutated(change):
            value = copy.deepcopy(original)
            change(value)
            mutations.append(value)

        mutated(lambda value: value["frontProxy"].update(port80=True))
        mutated(lambda value: value["frontProxy"]["certificate"].update(disableHttpChallenge=False))
        mutated(lambda value: value.update(publicUrl="https://other.invalid"))
        mutated(lambda value: value["frontProxy"]["routes"].append({
            "methods": ["GET"], "path": "/jmap/*", "upstream": "stalwart", "reason": "broad"
        }))
        mutated(lambda value: value["listeners"][0].update(scope="public-dual-stack"))
        mutated(lambda value: value["listeners"][0].update(useTls=True, implicitTls=True))
        mutated(
            lambda value: value["deployment"]["endpoints"]["join"].update(
                address=value["deployment"]["endpoints"]["caddy"]["address"]
            )
        )
        mutated(
            lambda value: value["deployment"]["endpoints"]["admin"].update(
                address=value["deployment"]["endpoints"]["join"]["address"]
            )
        )
        mutated(lambda value: value["singletons"]["Http"]["allowedEndpoints"].update(else_="200"))
        mutated(lambda value: value["singletons"]["Security"].update(authBanRate=None))
        mutated(lambda value: value["singletons"]["MtaStageRcpt"]["allowRelaying"].update(else_="true"))
        mutated(lambda value: value["botApiKey"]["permissions"].append("sysAccountGet"))
        mutated(lambda value: value["accountQuotas"].pop("maxDiskQuota"))
        mutated(lambda value: value["senderPolicy"]["systemScript"].update(isActive=False))
        mutated(lambda value: value["localDomainPolicy"].update(allowRelaying=True))
        mutated(
            lambda value: value["webUi"].update(
                resourceUrl="https://example.invalid/webui.zip"
            )
        )
        mutated(lambda value: value["webUi"].update(enable=True))

        self.assertEqual(len(mutations), 17)
        for unsafe in mutations:
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(door_policy.PolicyError):
                    door_policy.validate_policy(unsafe)


if __name__ == "__main__":
    unittest.main(verbosity=2)
