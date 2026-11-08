import unittest

import helper


TOKEN_A = bytearray(b"API_" + bytes([65]) * 38)
TOKEN_B = bytearray(b"API_" + bytes([66]) * 38)


class FakeAdmin:
    def __init__(self, fail_at=None):
        self.fail_at = fail_at
        self.steps = 0
        self.accounts = {}
        self.keys = {}
        self.issued = []
        self.events = []

    def _step(self, name):
        self.steps += 1
        self.events.append(name)
        if self.fail_at == self.steps:
            self.fail_at = None
            raise RuntimeError("stand-in admin failure")

    def create_account(self, bot_name):
        self._step("create-account")
        self.accounts["account-1"] = {"name": bot_name, "active": False}
        return "account-1"

    def verify_account(self, account_id, bot_name, active):
        self._step("verify-account-active" if active else "verify-account-inactive")
        account = self.accounts.get(account_id)
        if account != {"name": bot_name, "active": active}:
            raise RuntimeError("account readback mismatch")
    def account_exists(self, account_id):
        self.events.append("account-exists")
        return account_id in self.accounts


    def destroy_account(self, account_id):
        self.events.append("destroy-account")
        self.accounts.pop(account_id, None)
        for key_id in [key_id for key_id, value in self.keys.items() if value["account"] == account_id]:
            self.keys.pop(key_id)

    def create_key(self, account_id):
        self._step("create-key")
        key_id = f"key-{len(self.keys) + 1}"
        token = bytearray(TOKEN_A if not self.keys else TOKEN_B)
        self.keys[key_id] = {"account": account_id, "active": False, "token": bytes(token)}
        self.issued.append(token)
        return key_id, token

    def verify_key(self, account_id, key_id, active):
        self._step("verify-key-active" if active else "verify-key-inactive")
        value = self.keys.get(key_id)
        if value is None or value["account"] != account_id or value["active"] is not active:
            raise RuntimeError("key readback mismatch")

    def activate_account(self, account_id):
        self._step("activate-account")
        self.accounts[account_id]["active"] = True

    def deactivate_account(self, account_id):
        self._step("deactivate-account")
        self.accounts[account_id]["active"] = False

    def activate_key(self, account_id, key_id):
        self._step("activate-key")
        self.keys[key_id]["active"] = True

    def revoke_key(self, account_id, key_id):
        self._step("revoke-key")
        if key_id in self.keys:
            self.keys[key_id]["active"] = False

    def force_revoke_key(self, account_id, key_id):
        self.events.append("force-revoke-key")
        if key_id in self.keys:
            self.keys[key_id]["active"] = False

    def accepts(self, token):
        candidate = bytes(token)
        for value in self.keys.values():
            account = self.accounts.get(value["account"])
            if value["token"] == candidate and value["active"] and account and account["active"]:
                return True
        return False


class FakeAdapter:
    def __init__(self, fail=None):
        self.fail = fail
        self.values = {}
        self.retired = []
        self.events = []

    def save(self, bot_name, token):
        self.events.append("save")
        if self.fail == "save":
            raise RuntimeError("stand-in save failure")
        receipt = f"{bot_name}-slot-{len(self.values) + 1}"
        self.values[receipt] = bytearray(token)
        return receipt

    def read(self, receipt):
        self.events.append("read")
        if self.fail == "read":
            raise RuntimeError("stand-in read failure")
        return bytearray(self.values[receipt])

    def retire(self, receipt, reason):
        self.events.append("retire")
        if (receipt, reason) not in self.retired:
            self.retired.append((receipt, reason))
        self.values.pop(receipt, None)

class OpenClient:
    def __init__(self, verifier, token):
        self.verifier = verifier
        self.token = bytearray(token)

    def expect_refused(self):
        self.verifier.events.append("open-client-refused")
        if self.verifier.fail_open_check:
            raise RuntimeError("stand-in old-client check failure")
        if self.verifier.admin.accepts(self.token):
            raise RuntimeError("old client still accepted")
        helper.clear(self.token)


class FakeVerifier:
    def __init__(self, admin, fail_prove=False, fail_open_check=False):
        self.admin = admin
        self.fail_prove = fail_prove
        self.fail_open_check = fail_open_check
        self.events = []

    def expect_refused(self, token):
        self.events.append("refused-before-activation")
        if self.admin.accepts(token):
            raise RuntimeError("inactive key was accepted")

    def prove(self, token):
        self.events.append("prove-active")
        if self.fail_prove or not self.admin.accepts(token):
            raise RuntimeError("active key proof failed")

    def open(self, token):
        self.events.append("open-old-client")
        return OpenClient(self, token)


def active_bot():
    admin = FakeAdmin()
    admin.accounts["account-1"] = {"name": "bot-a", "active": True}
    admin.keys["key-1"] = {"account": "account-1", "active": True, "token": bytes(TOKEN_A)}
    adapter = FakeAdapter()
    adapter.values["bot-a-slot-1"] = bytearray(TOKEN_A)
    record = helper.BotRecord("bot-a", "account-1", "key-1", "bot-a-slot-1")
    return admin, adapter, record


class HelperTests(unittest.TestCase):
    def test_prepare_keeps_account_inactive_then_activate_uses_saved_readback(self):
        admin = FakeAdmin()
        adapter = FakeAdapter()
        verifier = FakeVerifier(admin)
        service = helper.ThreeActionHelper(admin, adapter, verifier)

        prepared = service.prepare_collect(helper.ApprovedJoin("ABCDEFGH", "bot-a"))
        target = prepared.target
        credential = prepared.take_credential()
        self.addCleanup(helper.clear, credential)

        self.assertEqual(
            target,
            helper.CollectTarget(
                "bot-a", "account-1", "key-1", "bot-a-slot-1"
            ),
        )
        self.assertEqual(credential, TOKEN_A)
        self.assertFalse(admin.accounts[target.account_id]["active"])
        self.assertFalse(admin.keys[target.key_id]["active"])
        self.assertEqual(verifier.events, ["refused-before-activation"])
        self.assertEqual(admin.issued[0], bytearray())

        record = service.activate_collect(target)
        self.assertEqual(
            record,
            helper.BotRecord("bot-a", "account-1", "key-1", "bot-a-slot-1"),
        )
        self.assertTrue(admin.accounts[record.account_id]["active"])
        self.assertTrue(admin.keys[record.key_id]["active"])
        self.assertEqual(
            verifier.events,
            [
                "refused-before-activation",
                "refused-before-activation",
                "prove-active",
            ],
        )
        self.assertNotIn("API_", repr(record))

    def test_each_admin_failure_during_prepare_restores_no_account_or_key(self):
        for fail_at in range(1, 5):
            with self.subTest(fail_at=fail_at):
                admin = FakeAdmin(fail_at=fail_at)
                adapter = FakeAdapter()
                service = helper.ThreeActionHelper(
                    admin, adapter, FakeVerifier(admin)
                )
                with self.assertRaises(helper.HelperRefused):
                    service.prepare_collect(
                        helper.ApprovedJoin("ABCDEFGH", "bot-a")
                    )
                self.assertEqual(admin.accounts, {})
                self.assertEqual(admin.keys, {})
                self.assertTrue(
                    all(value == bytearray() for value in admin.issued)
                )

    def test_adapter_failure_during_prepare_restores_no_account_or_key(self):
        for adapter_failure in ("save", "read"):
            with self.subTest(adapter_failure=adapter_failure):
                admin = FakeAdmin()
                adapter = FakeAdapter(fail=adapter_failure)
                service = helper.ThreeActionHelper(
                    admin, adapter, FakeVerifier(admin)
                )
                with self.assertRaises(helper.HelperRefused):
                    service.prepare_collect(
                        helper.ApprovedJoin("ABCDEFGH", "bot-a")
                    )
                self.assertEqual(admin.accounts, {})
                self.assertEqual(admin.keys, {})

    def test_activation_failure_then_rollback_restores_no_account_or_key(self):
        for fail_at, prove_failure in (
            (5, False),
            (6, False),
            (7, False),
            (8, False),
            (None, True),
        ):
            with self.subTest(fail_at=fail_at, prove_failure=prove_failure):
                admin = FakeAdmin()
                adapter = FakeAdapter()
                service = helper.ThreeActionHelper(
                    admin,
                    adapter,
                    FakeVerifier(admin, fail_prove=prove_failure),
                )
                prepared = service.prepare_collect(
                    helper.ApprovedJoin("ABCDEFGH", "bot-a")
                )
                target = prepared.target
                credential = prepared.take_credential()
                helper.clear(credential)
                admin.fail_at = fail_at
                with self.assertRaises(helper.HelperRefused):
                    service.activate_collect(target)
                service.rollback_collect(target)
                self.assertEqual(admin.accounts, {})
                self.assertEqual(admin.keys, {})

    def test_rollback_is_idempotent_and_orders_key_empty_permissions_account(self):
        admin = FakeAdmin()
        adapter = FakeAdapter()
        service = helper.ThreeActionHelper(admin, adapter, FakeVerifier(admin))
        prepared = service.prepare_collect(
            helper.ApprovedJoin("ABCDEFGH", "bot-a")
        )
        target = prepared.target
        credential = prepared.take_credential()
        helper.clear(credential)
        before = len(admin.events)

        service.rollback_collect(target)
        self.assertEqual(
            admin.events[before:],
            [
                "force-revoke-key",
                "account-exists",
                "deactivate-account",
                "verify-account-inactive",
                "destroy-account",
            ],
        )
        service.rollback_collect(target)

        self.assertEqual(admin.accounts, {})
        self.assertEqual(admin.keys, {})
        self.assertEqual(adapter.retired, [(target.helper_receipt, "collect-rollback")])
    def test_replace_proves_new_then_revokes_old_and_rejects_open_client(self):
        admin, adapter, record = active_bot()
        verifier = FakeVerifier(admin)
        replaced = helper.ThreeActionHelper(admin, adapter, verifier).replace(record)
        self.assertNotEqual(replaced.key_id, record.key_id)
        self.assertTrue(admin.keys[replaced.key_id]["active"])
        self.assertFalse(admin.keys[record.key_id]["active"])
        self.assertIn((record.adapter_receipt, "replaced"), adapter.retired)
        self.assertEqual(verifier.events, ["open-old-client", "refused-before-activation", "prove-active", "open-client-refused"])

    def test_failed_replace_cancels_new_and_keeps_old(self):
        for fail_prove in (True,):
            admin, adapter, record = active_bot()
            verifier = FakeVerifier(admin, fail_prove=fail_prove)
            with self.assertRaises(helper.HelperRefused):
                helper.ThreeActionHelper(admin, adapter, verifier).replace(record)
            self.assertTrue(admin.keys[record.key_id]["active"])
            new_keys = [value for key_id, value in admin.keys.items() if key_id != record.key_id]
            self.assertTrue(new_keys and not any(value["active"] for value in new_keys))

    def test_cancel_disables_account_revokes_key_and_rejects_open_client(self):
        admin, adapter, record = active_bot()
        verifier = FakeVerifier(admin)
        helper.ThreeActionHelper(admin, adapter, verifier).cancel(record)
        self.assertFalse(admin.accounts[record.account_id]["active"])
        self.assertFalse(admin.keys[record.key_id]["active"])
        self.assertIn((record.adapter_receipt, "cancelled"), adapter.retired)
        self.assertEqual(verifier.events, ["open-old-client", "open-client-refused"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
