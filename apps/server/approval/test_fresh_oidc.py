from __future__ import annotations

import unittest

import approval_security
from test_oidc import GoogleOidcTests


class FreshOidcTests(GoogleOidcTests):
    def test_every_exchange_requires_its_login_record_start(self):
        provider, _ = self.provider(self.claims())
        with self.assertRaises(TypeError):
            provider.exchange_code('standin-code', 'V' * 43, 'N' * 43)

    def test_invalid_record_starts_are_refused_and_old_issue_limit_remains(self):
        for started in (None, True, '1000', -1, 1001, float('nan'), float('inf')):
            with self.subTest(started=started):
                provider, _ = self.provider(self.claims())
                with self.assertRaises(approval_security.ApprovalRefused):
                    provider.exchange_code('standin-code', 'V' * 43, 'N' * 43, auth_started=started)
        provider, _ = self.provider(self.claims(iat=399))
        with self.assertRaises(approval_security.ApprovalRefused):
            provider.exchange_code('standin-code', 'V' * 43, 'N' * 43, auth_started=400.0)
