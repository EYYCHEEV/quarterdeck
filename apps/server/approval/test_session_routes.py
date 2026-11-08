from __future__ import annotations

import copy
import unittest
from pathlib import Path

import approval_security
import door_policy
from test_session_pages import SessionPageTests


class StepUpRouteTests(SessionPageTests):
    def test_stepup_rejects_malformed_query_and_post_only_return_pages(self):
        for query in ['next', 'next=%2Fcaptain%2Fapprove', 'next=%2Fcaptain%2Flogout', 'next=%2Fcaptain%2Fstep-up', 'next=https%3A%2F%2Fother.invalid', 'next=%2Fcaptain%2Fchat&next=%2Fcaptain%2Fpending']:
            with self.subTest(query=query):
                response = self.app.handle(self.request('/captain/step-up?' + query))
                self.assertEqual(response.status, 403)
                self.assertEqual(self.provider.calls, [])

    def test_new_routes_refuse_near_miss_paths_and_unknown_methods(self):
        routes = [approval_security.STEP_UP_PATH, approval_security.DEVICES_PATH, approval_security.DEVICE_SIGNOUT_PATH, approval_security.EVERYWHERE_PATH, approval_security.SIGNED_OUT_PATH]
        for path in routes:
            for near in (path + "/", path + "-extra", path.upper()):
                with self.subTest(path=near):
                    self.assertEqual(self.app.handle(self.request(near)).status, 404)
            self.assertIn(self.app.handle(self.request(path, method="DELETE")).status, (404, 405))

    def test_signed_out_probe_exception_is_200_with_button_and_no_cookie(self):
        response = self.app.handle(self.request(approval_security.SIGNED_OUT_PATH))
        self.assertEqual(response.status, 200)
        self.assertIn(b"Sign in</button>", response.body)
        self.assertFalse(any(name.lower() in {"set-cookie", "location"} for name, _ in response.headers))


class SessionDoorTests(unittest.TestCase):
    def test_new_pages_are_exact_routes_to_approval_not_a_wildcard(self):
        policy_path = Path(door_policy.__file__).with_name('door-policy.json')
        policy = door_policy.load_policy(policy_path)
        door_policy.validate_policy(policy)
        routes = {row['path']: row for row in policy['frontProxy']['routes']}
        wanted = {approval_security.STEP_UP_PATH: ['GET'], approval_security.DEVICES_PATH: ['GET'], approval_security.DEVICE_SIGNOUT_PATH: ['POST'], approval_security.EVERYWHERE_PATH: ['POST'], approval_security.SIGNED_OUT_PATH: ['GET']}
        rendered = door_policy.build_caddyfile(policy)
        for path, methods in wanted.items():
            with self.subTest(path=path):
                self.assertIn(path, routes)
                self.assertEqual(routes[path]['methods'], methods)
                self.assertEqual(routes[path]['upstream'], 'approval')
                self.assertEqual(routes[path]['maxBody'], '8KB')
                self.assertIn(path, rendered)
        unsafe = copy.deepcopy(policy)
        unsafe['frontProxy']['routes'].append({'matcher': 'catchall', 'methods': ['GET', 'POST'], 'path': '/captain/*', 'upstream': 'approval'})
        with self.assertRaises(door_policy.PolicyError):
            door_policy.validate_policy(unsafe)
