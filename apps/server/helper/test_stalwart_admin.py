import copy
import unittest

import stalwart_admin


TOKEN = "API_" + "A" * 38


class FakeTransport:
    def __init__(self, token=TOKEN):
        self.token = token
        self.calls = []
        self.accounts = {}
        self.keys = {}
        self.overrides = {}

    def call(self, method, arguments, call_id):
        self.calls.append((method, copy.deepcopy(arguments), call_id))
        if method in self.overrides:
            return copy.deepcopy(self.overrides[method])
        if method == "x:Domain/query":
            return {"ids": ["domain-1"]}
        if method == "x:Account/query":
            name = arguments["filter"]["name"]
            return {"ids": [key for key, value in self.accounts.items() if value["name"] == name]}
        if method == "x:Account/set":
            if "create" in arguments:
                value = copy.deepcopy(arguments["create"]["account"])
                value["id"] = "account-1"
                self.accounts["account-1"] = value
                return {"created": {"account": {"id": "account-1"}}}
            if "update" in arguments:
                for account_id, patch in arguments["update"].items():
                    self.accounts[account_id].update(copy.deepcopy(patch))
                return {"updated": list(arguments["update"])}
            for account_id in arguments["destroy"]:
                self.accounts.pop(account_id, None)
            return {"destroyed": list(arguments["destroy"])}
        if method == "x:Account/get":
            values = [copy.deepcopy(self.accounts[value]) for value in arguments["ids"] if value in self.accounts]
            return {"list": values, "notFound": [value for value in arguments["ids"] if value not in self.accounts]}
        if method == "x:ApiKey/set":
            account_id = arguments["accountId"]
            if "create" in arguments:
                value = copy.deepcopy(arguments["create"]["key"])
                permissions = value.get("permissions")
                if (
                    not isinstance(permissions, dict)
                    or set(permissions) != {"@type", "permissions"}
                ):
                    return {"notCreated": {"key": {"type": "invalidPatch"}}}
                value.update({"id": "key-1", "accountId": account_id})
                self.keys["key-1"] = value
                return {"created": {"key": {"id": "key-1", "secret": self.token}}}
            if "update" in arguments:
                for key_id, patch in arguments["update"].items():
                    permissions = patch.get("permissions")
                    if (
                        not isinstance(permissions, dict)
                        or set(permissions) != {"@type", "permissions"}
                    ):
                        return {"notUpdated": {key_id: {"type": "invalidPatch"}}}
                    self.keys[key_id].update(copy.deepcopy(patch))
                return {"updated": list(arguments["update"])}
            for key_id in arguments["destroy"]:
                self.keys.pop(key_id, None)
            return {"destroyed": list(arguments["destroy"])}
        if method == "x:ApiKey/get":
            values = [copy.deepcopy(self.keys[value]) for value in arguments["ids"] if value in self.keys]
            return {"list": values, "notFound": [value for value in arguments["ids"] if value not in self.keys]}
        raise AssertionError(f"unexpected method: {method}")


class StalwartAdminTests(unittest.TestCase):
    def test_account_and_key_stay_inactive_until_exact_allowlist_updates(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(transport, "quarterdeck.example")

        account_id = admin.create_account("bot-a")
        admin.verify_account(account_id, "bot-a", False)
        key_id, token = admin.create_key(account_id)
        admin.verify_key(account_id, key_id, False)

        created_account = transport.accounts[account_id]
        self.assertEqual(created_account["@type"], "User")
        self.assertEqual(created_account["roles"], {"@type": "User"})
        self.assertEqual(created_account["permissions"], stalwart_admin.EMPTY_PERMISSIONS)
        self.assertEqual(created_account["quotas"], stalwart_admin.ACCOUNT_QUOTAS)
        self.assertEqual(created_account["encryptionAtRest"], {"@type": "Disabled"})
        self.assertEqual(
            transport.keys[key_id]["permissions"],
            {"@type": "Replace", "permissions": {}},
        )
        self.assertEqual(transport.keys[key_id]["allowedIps"], {})

        admin.activate_account(account_id)
        admin.activate_key(account_id, key_id)
        admin.verify_account(account_id, "bot-a", True)
        admin.verify_key(account_id, key_id, True)
        expected = set(stalwart_admin.ALLOWED_PERMISSIONS)
        self.assertEqual(stalwart_admin.members(transport.accounts[account_id]["permissions"]["enabledPermissions"]), expected)
        self.assertEqual(
            stalwart_admin.members(
                transport.keys[key_id]["permissions"]["permissions"]
            ),
            expected,
        )
        self.assertFalse(expected.intersection(stalwart_admin.FORBIDDEN_PERMISSIONS))
        self.assertFalse(any(value.startswith("sys") for value in expected))
        key_sets = [
            arguments
            for method, arguments, _ in transport.calls
            if method == "x:ApiKey/set"
        ]
        self.assertEqual(
            key_sets[:2],
            [
                {
                    "accountId": account_id,
                    "create": {
                        "key": {
                            "description": "Quarterdeck restricted bot credential",
                            "permissions": {
                                "@type": "Replace",
                                "permissions": {},
                            },
                            "allowedIps": {},
                        }
                    },
                },
                {
                    "accountId": account_id,
                    "update": {
                        key_id: {
                            "permissions": {
                                "@type": "Replace",
                                "permissions": {
                                    permission: True
                                    for permission in stalwart_admin.ALLOWED_PERMISSIONS
                                },
                            }
                        }
                    },
                },
            ],
        )
        key_gets = [
            arguments
            for method, arguments, _ in transport.calls
            if method == "x:ApiKey/get"
        ]
        self.assertTrue(key_gets)
        self.assertTrue(
            all(
                arguments
                == {
                    "accountId": account_id,
                    "ids": [key_id],
                    "properties": [
                        "id",
                        "description",
                        "permissions",
                        "allowedIps",
                    ],
                }
                for arguments in key_gets
            )
        )

        admin.deactivate_account(account_id)
        admin.revoke_key(account_id, key_id)
        admin.verify_account(account_id, "bot-a", False)
        admin.destroy_account(account_id)
        self.assertEqual(transport.accounts, {})
        self.assertEqual(transport.keys, {})
        token[:] = b"\x00" * len(token)
        token.clear()

    def test_live_shaped_standin_refuses_account_permission_shape_for_keys(self):
        transport = FakeTransport()
        response = transport.call(
            "x:ApiKey/set",
            {
                "accountId": "account-1",
                "create": {
                    "key": {
                        "description": "refused",
                        "permissions": copy.deepcopy(
                            stalwart_admin.EMPTY_PERMISSIONS
                        ),
                        "allowedIps": {},
                    }
                },
            },
            "refused-shape",
        )
        self.assertEqual(
            response,
            {"notCreated": {"key": {"type": "invalidPatch"}}},
        )

    def test_account_existence_readback_distinguishes_present_and_removed(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(transport, "quarterdeck.example")
        account_id = admin.create_account("bot-a")

        self.assertTrue(admin.account_exists(account_id))
        admin.destroy_account(account_id)
        self.assertFalse(admin.account_exists(account_id))

    def test_empty_list_without_not_found_is_refused(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(
            transport,
            "quarterdeck.example",
        )
        account_id = admin.create_account("bot-a")
        key_id, token = admin.create_key(account_id)

        transport.overrides["x:Account/get"] = {"list": []}
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.account_exists(account_id)
        transport.overrides.pop("x:Account/get")

        transport.overrides["x:ApiKey/get"] = {"list": []}
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.revoke_key(account_id, key_id)
        token[:] = b"\x00" * len(token)
        token.clear()

    def test_explicit_not_found_is_absence_and_revoke_rechecks_by_id(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(
            transport,
            "quarterdeck.example",
        )
        account_id = admin.create_account("bot-a")
        key_id, token = admin.create_key(account_id)

        admin.verify_key(account_id, key_id, False)
        admin.revoke_key(account_id, key_id)
        key_gets = [
            arguments
            for method, arguments, _ in transport.calls
            if method == "x:ApiKey/get"
        ]
        self.assertGreaterEqual(len(key_gets), 3)
        self.assertTrue(
            all(arguments["ids"] == [key_id] for arguments in key_gets)
        )
        self.assertIsNone(admin._key(account_id, key_id))
        self.assertFalse(admin.account_exists("missing-account"))
        token[:] = b"\x00" * len(token)
        token.clear()

    def test_found_response_must_hold_the_requested_exact_id(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(
            transport,
            "quarterdeck.example",
        )
        account_id = admin.create_account("bot-a")
        key_id, token = admin.create_key(account_id)

        transport.overrides["x:Account/get"] = {
            "list": [{"id": "other-account"}],
            "notFound": [],
        }
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.account_exists(account_id)
        transport.overrides.pop("x:Account/get")
        transport.overrides["x:ApiKey/get"] = {
            "list": [{"id": "other-key"}],
            "notFound": [],
        }
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.verify_key(account_id, key_id, False)
        token[:] = b"\x00" * len(token)
        token.clear()


    def test_readback_refuses_forbidden_or_inherited_permissions(self):
        transport = FakeTransport()
        admin = stalwart_admin.StalwartAdmin(transport, "quarterdeck.example")
        account_id = admin.create_account("bot-a")
        key_id, token = admin.create_key(account_id)

        transport.accounts[account_id]["permissions"] = {"@type": "Inherit"}
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.verify_account(account_id, "bot-a", False)

        transport.keys[key_id]["permissions"] = {
            "@type": "Replace",
            "enabledPermissions": {"admin": True},
            "disabledPermissions": {},
        }
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.verify_key(account_id, key_id, True)
        token[:] = b"\x00" * len(token)
        token.clear()

    def test_invalid_server_credential_is_destroyed(self):
        transport = FakeTransport(token="not-an-api-key")
        admin = stalwart_admin.StalwartAdmin(transport, "quarterdeck.example")
        account_id = admin.create_account("bot-a")
        with self.assertRaises(stalwart_admin.AdminRefused):
            admin.create_key(account_id)
        self.assertEqual(transport.keys, {})

    def test_variable_length_server_credential_is_accepted(self):
        transport = FakeTransport(token="API_" + "B" * 74)
        admin = stalwart_admin.StalwartAdmin(transport, "quarterdeck.example")
        account_id = admin.create_account("bot-a")
        key_id, token = admin.create_key(account_id)
        self.assertEqual(key_id, "key-1")
        self.assertEqual(len(token), 78)
        token[:] = b"\x00" * len(token)
        token.clear()



if __name__ == "__main__":
    unittest.main(verbosity=2)
