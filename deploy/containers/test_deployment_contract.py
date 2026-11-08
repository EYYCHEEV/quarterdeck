import json
import stat
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


GOLIVE_ROOT = Path(__file__).resolve().parents[1]
WORK_ROOT = GOLIVE_ROOT.parent
SIGNUP_ROOT = WORK_ROOT / "signup"
sys.path.insert(0, str(SIGNUP_ROOT))
import approval_service


README = Path(__file__).with_name("README.md")
COMPOSE = Path(__file__).with_name("compose.template.json")


class DirectoryStandIn:
    def __init__(self, owner: int, group: int, mode: int):
        self.info = SimpleNamespace(
            st_mode=stat.S_IFDIR | mode,
            st_uid=owner,
            st_gid=group,
        )

    def lstat(self):
        return self.info


class DeploymentContractTests(unittest.TestCase):
    def test_documented_approval_socket_ownership_matches_runtime(self):
        compose = json.loads(COMPOSE.read_text(encoding="utf-8"))
        join = compose["services"]["join"]
        owner = int(join["user"].split(":", 1)[0])
        group = 2501
        mode = approval_service.SHARED_SOCKET_DIRECTORY_MODE

        self.assertEqual(owner, 2100)
        self.assertIn(str(group), join["group_add"])
        self.assertEqual(mode, 0o2770)
        self.assertIn(
            "| Join-approval socket directory | 2100 (join), group 2501 | 2770 | Join and approval only |",
            README.read_text(encoding="utf-8"),
        )

        with mock.patch.object(approval_service.os, "getuid", return_value=owner):
            approval_service._protected_directory(
                DirectoryStandIn(owner, group, mode), group
            )


    def test_approval_is_the_only_service_with_external_egress(self):
        compose = json.loads(COMPOSE.read_text(encoding="utf-8"))
        services = compose["services"]
        self.assertEqual(
            services["approval"]["networks"],
            {
                "service": {
                    "ipv4_address": "${deployment:approval-address}",
                },
                "egress": {},
            },
        )
        self.assertEqual(
            [
                name
                for name, service in services.items()
                if "egress" in service.get("networks", {})
            ],
            ["approval"],
        )
        self.assertEqual(
            compose["networks"]["egress"],
            {
                "driver": "bridge",
                "driver_opts": {
                    "com.docker.network.bridge.name": "qd-egress0",
                },
                "ipam": {
                    "config": [{"subnet": "${QD_EGRESS_SUBNET}"}],
                },
            },
        )

    def test_wrong_documented_owner_stops_runtime(self):
        owner = 2100
        group = 2501
        mode = approval_service.SHARED_SOCKET_DIRECTORY_MODE
        wrong_owner = owner + 1
        with mock.patch.object(approval_service.os, "getuid", return_value=owner):
            with self.assertRaises(approval_service.PublicFailure):
                approval_service._protected_directory(
                    DirectoryStandIn(wrong_owner, group, mode), group
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
