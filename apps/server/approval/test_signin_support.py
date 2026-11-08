from __future__ import annotations

import captain_auth


def production_sign_in(state, authenticator):
    captain_auth._authority = None
    captain_auth.install(state, authenticator)
    return captain_auth
