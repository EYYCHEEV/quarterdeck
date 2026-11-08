from __future__ import annotations

import json
from pathlib import Path
import re
import unittest

BASE = Path(__file__).resolve().parent


class DeploymentQdTests(unittest.TestCase):
    def service(self):
        document = json.loads((BASE / 'compose.approval-qd.json').read_text())
        self.assertEqual(set(document['services']), {'approval-qd'})
        return document['services']['approval-qd']

    def runtime(self):
        return json.loads((BASE / 'runtime-qd.template.json').read_text())

    def test_shared_owner_and_exact_qd_auth_boundary(self):
        service = self.service()
        runtime = self.runtime()
        self.assertEqual(service['user'], '2500:2500')
        self.assertEqual(service['group_add'], ['2711'])
        self.assertEqual(runtime['captainAuth'], {'peerUid': 2700, 'socketMode': '0660', 'socketGid': 2711})
        self.assertEqual(runtime['paths']['captainAuthSocket'], '/run/quarterdeck-qd-auth/auth.sock')
        self.assertEqual(runtime['publicOrigin'], 'https://qd.example.invalid')
        self.assertEqual(runtime['oidcRedirectUri'], 'https://qd.example.invalid/captain/oidc/callback')

    def test_only_new_state_and_auth_are_writable_and_no_join_is_mounted(self):
        service = self.service()
        runtime = self.runtime()
        mounts = service['volumes']
        writable = {row['source']: row['target'] for row in mounts if not row['read_only']}
        self.assertEqual(writable, {'${QD_ROOT}/volumes/qd-approval-state': '/var/lib/quarterdeck-approval-qd', '${QD_ROOT}/volumes/qd-auth': '/run/quarterdeck-qd-auth'})
        private = [row for row in mounts if row['source'] == '${QD_ROOT}/secrets/approval-secrets/oidc.json']
        self.assertEqual(len(private), 1)
        self.assertTrue(private[0]['read_only'])
        self.assertEqual(private[0]['target'], runtime['paths']['oidc'])
        self.assertEqual(runtime['paths']['state'], '/var/lib/quarterdeck-approval-qd/state.sqlite')
        self.assertEqual(runtime['paths']['socket'], '/run/quarterdeck-no-join/approve.sock')
        for row in mounts:
            self.assertEqual(row['type'], 'bind')
            self.assertEqual(row['bind'], {'create_host_path': False})
            self.assertNotIn('/run/quarterdeck-no-join', row['target'])
            self.assertNotIn('captain-auth', row['source'])
            self.assertNotIn('approval-socket', row['source'])
        variables = set(re.findall(r'\$\{([^}]+)\}', json.dumps(service)))
        self.assertEqual(variables, {'QD_PACKAGE', 'QD_ROOT'})

    def test_container_hardening_and_bounded_private_listener(self):
        service = self.service()
        self.assertTrue(service['read_only'])
        self.assertEqual(service['cap_drop'], ['ALL'])
        self.assertEqual(service['security_opt'], ['no-new-privileges:true'])
        self.assertNotIn('ports', service)
        self.assertNotIn('network_mode', service)
        self.assertEqual(service['networks'], {'service': {}, 'egress': {}})
        self.assertEqual(service['memswap_limit'], service['mem_limit'])
        self.assertLessEqual(service['pids_limit'], 256)
        self.assertEqual(service['command'], ['python3', '-B', '/opt/quarterdeck/approval/server.py', '--config', '/etc/quarterdeck/approval-qd/runtime.json'])
        self.assertEqual(service['image'], 'docker.io/library/python@sha256:0aecac02dc3d4c5dbb024b753af084cafe41f5416e02193f1ce345d671ec966e')
        for mount in service['tmpfs']:
            for flag in ('noexec', 'nosuid', 'nodev', 'mode=0700'):
                self.assertIn(flag, mount)
        self.assertEqual(self.runtime()['bind']['port'], 19091)


if __name__ == '__main__':
    unittest.main(verbosity=2)
