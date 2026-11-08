from __future__ import annotations

import os
import threading

import approval_security
import auth_bridge
import captain_auth
import captain_auth_socket
from test_session_pages import SessionPageTests


class SessionSocketTests(SessionPageTests):
    def test_actual_private_socket_carries_authoritative_freshness_without_background_touch(self):
        cookies, _ = self.login()
        state, header, _ = self.begin(self.header(cookies), step_up=True)
        cookies = self.cookies(self.finish(state, header))
        token = cookies['__Host-qd-approval']
        socket_dir = self.root / 'a'
        socket_dir.mkdir(mode=0o2770)
        os.chmod(socket_dir, 0o2770)
        service = captain_auth_socket.CaptainAuthSocketService(captain_auth, self.app, socket_dir / 's', expected_uid=os.getuid(), socket_mode=0o660, socket_gid=os.getgid())
        ready = threading.Event()
        thread = threading.Thread(target=service.serve_once, kwargs={'ready': ready})
        thread.start()
        self.addCleanup(lambda: thread.join(5))
        self.assertTrue(ready.wait(5))
        gate = auth_bridge.SocketApprovalGate(auth_bridge.ApprovalAuthClient(str(socket_dir / 's')))
        grant = gate.authenticate(self.request('/captain/api/chats', self.header(cookies)))
        thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(gate.fresh_until(grant), self.start + 900)
        self.clock.value = self.start + 7 * 86400
        self.assertIsNone(self.state.authorize_session(token))

    def test_private_authorize_post_refuses_an_unfresh_card_answer_before_activity(self):
        cookies, _ = self.login()
        self.clock.value += 901
        owner = self.state.authorize_session(cookies['__Host-qd-approval'])
        csrf = self.state.issue_csrf(owner)
        socket_dir = self.root / 'a'
        socket_dir.mkdir(mode=0o2770)
        os.chmod(socket_dir, 0o2770)
        service = captain_auth_socket.CaptainAuthSocketService(captain_auth, self.app, socket_dir / 's', expected_uid=os.getuid(), socket_mode=0o660, socket_gid=os.getgid())
        request = self.request('/captain/cards/test-1/answer', self.header(cookies), method='POST')
        payload = {'operation': 'authorize-post', 'session': cookies['__Host-qd-approval'], 'csrf': csrf, 'request': auth_bridge.SocketApprovalGate._request_facts(request)}
        with self.assertRaises(approval_security.FreshSignInRequired):
            service._authorize(payload)
