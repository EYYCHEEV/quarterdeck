import copy
import importlib.util
import ipaddress
import json
import re
import unittest
from pathlib import Path

import layout


ROOT = Path(__file__).resolve().parent
POLICY = json.loads(
    (ROOT.parent / "door" / "door-policy.json").read_text(encoding="utf-8")
)
HELPER_RUNTIME = layout.render_configuration(
    json.loads(
        (ROOT.parent / "helper" / "runtime-config.template.json").read_text(
            encoding="utf-8"
        )
    ),
    POLICY,
)



RUNTIME_REFERENCE = "sha256:96d0ae33a56f26416534c388da1c93562b98dd59705a3e4bc677adc0b651d3ff"
RUNTIME_CONFIG_DIGEST = "sha256:a9addbcee0970d0fabb0e68bd6750e71ecfb7794c34a8189faefb7e4471ba89e"
RUNTIME_DIFF_IDS = [
    "sha256:cbbb365270c4c1c6e19f57cf154fa318c0ef8023a09b130fe9a975cd9a475c2e",
    "sha256:ffaf7d80b47696ad3cf7dd2d01bf886c3e42f234ebb5ba42b9829b27bae75f14",
    "sha256:567370932be906cbd13961e5e19e1ee3f9a1ff6f0e8e407f8b61625241f92c4c",
    "sha256:8ea0d2570ee71fb416f7f813bc4d84d652eaa4828bb34c672c5c37a79c963e86",
    "sha256:a7849bca08ed6ed1011e994c52549c86a34985cfa6fc7c5cdf13582b10e570af",
    "sha256:8aacc240fd2a6f60aa7626ebeefd5a4ebd5b7fd60391d365048c8795aa5ca4d6",
    "sha256:17d1af76b86f522b08e62cf470ff43a5256bf1333d02a53f2610d89f78608b9a",
    "sha256:e7c8e5cd2a23b73760863db1499f2e1e8c6514763f8f44c7f2a70bb99a381d8d",
    "sha256:fc5a17c94641eccb6d5de2b03eee2904befae5b25231d556e10f7c0a1643b49d",
    "sha256:d1f3cdc27baa4153944557d0378da5eef3e8c32179da3527990484f110957ae7",
    "sha256:4a798601b6955521386428a4b4bd439bb54e39fc3170ccc103d551a7ec85c950",
    "sha256:c903b3c015ae05cc93f077c165c21d7d28cad352a13da9fd5fb59dcb956dfac8",
    "sha256:3ae7063feb384cf9a8b665bb88c6ecce304ab4820748364492d1aba44fecdf3a",
    "sha256:220090f8f6d7dd851f71ea2ac34a8064cdf98b4716f9720387adf1fc1cb282df",
    "sha256:b69b5971c643a544773a9b84571225f4014f47f82285fd3e857cdce11845bbf8"
]
RUNTIME_COPY_SHA256 = {
    "door/door-policy.json": "c3d7b8db009629acc54f9d387f331c412ec4350d975bc473019b4c42d9b3dfad",
    "door/door_policy.py": "fcb20de6ce171ac0ef89fe2d0f0ab21474aaf67d64c190f52f59dd9028eb887c",
    "first_start/bootstrap_launcher.py": "e51f12c108d54aef768ec4f42e71bddc2e255d42235f1929bcf40b9bf5ba470f",
    "first_start/first_start.py": "608369af2d181756419af0e74783afd64b49e4ff5fbaacfb4b353e820dc3541a",
    "first_start/normal_launcher.py": "a07b5d603112460873a4221c63b1b8c0a7a3e1086766e5bb63d0412ec994b0f6",
    "first_start/password_file.py": "ed8541c0062917b0a52d6e256cfccac05ddb1628825affe0f370fce8240094bd",
    "first_start/recovery_launcher.py": "08cd0f9fb72bd745b4cabbb49a6c36ae9ccbbd1ed94e295dd308b330e8ef0d67"
}


GOOD_MANIFEST = {
    "format": 1,
    "images": {
        "stalwart-source": {
            "repository": "docker.io/stalwartlabs/stalwart",
            "version": "v1.0.1",
            "reference": "docker.io/stalwartlabs/stalwart@sha256:" + "a" * 64,
        },
        "python-source": {
            "repository": "docker.io/library/python",
            "version": "3.14.0-slim-trixie",
            "reference": "docker.io/library/python@sha256:" + "b" * 64,
        },
        "caddy-source": {
            "repository": "docker.io/library/caddy",
            "version": "2.11.7-alpine",
            "reference": "docker.io/library/caddy@sha256:" + "c" * 64,
        },
        "stalwart-runtime": {
            "repository": "local/quarterdeck-stalwart",
            "version": "v1",
            "reference": RUNTIME_REFERENCE,
            "configDigest": RUNTIME_CONFIG_DIGEST,
            "diffIds": RUNTIME_DIFF_IDS.copy(),
            "copySha256": RUNTIME_COPY_SHA256.copy(),
        },
    },
}


class ContainerLayoutTests(unittest.TestCase):
    def test_deployment_coordinates_render_only_from_door_policy(self):
        policy = json.loads(
            (ROOT.parent / "door" / "door-policy.json").read_text(
                encoding="utf-8"
            )
        )
        deployment = policy["deployment"]
        template_path = ROOT / "compose.template.json"
        template_text = template_path.read_text(encoding="utf-8")
        rendered = layout.render(
            json.loads(template_text),
            GOOD_MANIFEST,
            policy,
        )

        endpoints = deployment["endpoints"]
        for name in ("caddy", "stalwart", "join", "approval"):
            self.assertEqual(
                rendered["services"][name]["networks"]["service"][
                    "ipv4_address"
                ],
                endpoints[name]["address"],
            )
        self.assertEqual(
            rendered["networks"]["service"]["ipam"]["config"],
            [{"subnet": deployment["serviceNetwork"]}],
        )
        for value in (
            deployment["serviceNetwork"],
            *(endpoints[name]["address"] for name in endpoints),
        ):
            self.assertNotIn(value, template_text)

    def test_runtime_templates_render_host_and_network_values_from_policy(self):
        templates = {
            "connect": (
                ROOT.parent / "connect" / "runtime-config.template.json"
            ),
            "approval": (
                ROOT.parent / "approval" / "runtime-config.template.json"
            ),
            "helper": (
                ROOT.parent / "helper" / "runtime-config.template.json"
            ),
            "bootstrap": (
                ROOT.parent / "first_start" / "bootstrap-request.json"
            ),
            "captain": (
                ROOT.parent.parent
                / "captain-app"
                / "runtime-config.template.json"
            ),
        }
        rendered = {}
        configured_values = {
            POLICY["hostname"],
            POLICY["publicUrl"],
            POLICY["mailDomain"],
            POLICY["deployment"]["serviceNetwork"],
            *(
                endpoint["address"]
                for endpoint in POLICY["deployment"]["endpoints"].values()
            ),
        }
        for name, path in templates.items():
            text = path.read_text(encoding="utf-8")
            for value in configured_values:
                self.assertNotIn(value, text)
            rendered[name] = layout.render_configuration(
                json.loads(text),
                POLICY,
            )

        endpoints = POLICY["deployment"]["endpoints"]
        self.assertEqual(
            rendered["connect"]["bind"],
            {
                "address": endpoints["join"]["address"],
                "port": endpoints["join"]["port"],
            },
        )
        self.assertEqual(
            rendered["approval"]["trustedProxy"],
            endpoints["caddy"]["address"],
        )
        self.assertEqual(
            rendered["helper"]["management"],
            {
                "username": f"admin@{POLICY['mailDomain']}",
                "address": endpoints["admin"]["address"],
                "port": endpoints["admin"]["port"],
            },
        )
        bootstrap = rendered["bootstrap"]["methodCalls"][0][1]["update"][
            "singleton"
        ]
        self.assertEqual(bootstrap["defaultHostname"], POLICY["hostname"])
        self.assertEqual(
            rendered["captain"]["jmapSessionUrl"],
            f"{POLICY['publicUrl']}/.well-known/jmap",
        )
        self.assertEqual(
            rendered["captain"]["authSocket"],
            "/run/quarterdeck-captain-auth/auth.sock",
        )
        self.assertEqual(bootstrap["defaultDomain"], POLICY["mailDomain"])
        unpublished_release = {
            "artifactUrl": None,
            "version": None,
            "sha256": None,
        }
        self.assertEqual(rendered["connect"]["release"], unpublished_release)
        self.assertEqual(rendered["approval"]["release"], unpublished_release)
        self.assertEqual(
            rendered["approval"]["paths"],
            {
                "oidc": "/var/lib/quarterdeck-approval/oidc.json",
                "state": "/var/lib/quarterdeck-approval/state.sqlite",
                "socket": "/run/quarterdeck-approval/approve.sock",
                "captainAuthSocket": (
                    "/run/quarterdeck-captain-auth/auth.sock"
                ),
            },
        )
        self.assertFalse((ROOT.parent / "door" / "Caddyfile").exists())

        policy_consumers = (
            ROOT / "compose.template.json",
            ROOT.parent / "approval" / "runtime-config.template.json",
            ROOT.parent / "connect" / "runtime-config.template.json",
            ROOT.parent.parent
            / "captain-app"
            / "runtime-config.template.json",
            ROOT.parent / "first_start" / "first_start.py",
            ROOT.parent / "first_start" / "normal_launcher.py",
            ROOT.parent / "helper" / "management_transport.py",
            ROOT.parent / "helper" / "runtime-config.template.json",
        )
        for path in policy_consumers:
            text = path.read_text(encoding="utf-8")
            for value in configured_values:
                self.assertNotIn(value, text, str(path))

    def test_rendered_runtime_and_configuration_files_have_no_leftover_tokens(self):
        runtime_templates = (
            ROOT.parent / "connect" / "runtime-config.template.json",
            ROOT.parent / "helper" / "runtime-config.template.json",
            ROOT.parent / "approval" / "runtime-config.template.json",
            ROOT.parent.parent / "captain-app" / "runtime-config.template.json",
            ROOT.parent / "first_start" / "bootstrap-request.json",
        )
        for path in runtime_templates:
            with self.subTest(path=str(path)):
                rendered = layout.render_configuration(
                    json.loads(path.read_text(encoding="utf-8")),
                    POLICY,
                )
                self.assertNotIn("${", json.dumps(rendered))

        door_path = ROOT.parent / "door" / "door_policy.py"
        spec = importlib.util.spec_from_file_location(
            "door_policy_module",
            door_path,
        )
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        door_policy = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(door_policy)
        self.assertNotIn("${", door_policy.build_caddyfile(POLICY))

        compose_templates = (
            ROOT / "compose.template.json",
            ROOT / "compose.step13.template.json",
        )
        compose_tokens = set()
        for path in compose_templates:
            rendered = layout.render(
                json.loads(path.read_text(encoding="utf-8")),
                GOOD_MANIFEST,
                POLICY,
            )
            compose_tokens.update(
                re.findall(r"\$\{([^{}]+)\}", json.dumps(rendered))
            )
        first_start = layout.render(
            json.loads(
                (ROOT / "compose.first-start.template.json").read_text(
                    encoding="utf-8"
                )
            ),
            GOOD_MANIFEST,
            POLICY,
            helper_runtime=HELPER_RUNTIME,
        )
        compose_tokens.update(
            re.findall(r"\$\{([^{}]+)\}", json.dumps(first_start))
        )
        self.assertEqual(
            compose_tokens,
            {"QD_ROOT", "QD_PACKAGE", "QD_EGRESS_SUBNET", "QD_CARD_LINK_ORIGIN"},
        )
        with self.assertRaises(layout.LayoutError):
            layout.render_configuration(
                {"leftover": "${RUNTIME_PLACEHOLDER}"},
                POLICY,
            )
        with self.assertRaises(layout.LayoutError):
            layout.render(
                {"leftover": "${COMPOSE_PLACEHOLDER}"},
                GOOD_MANIFEST,
                POLICY,
            )

    def test_unset_or_mutable_images_are_refused(self):
        for image in GOOD_MANIFEST["images"]:
            with self.subTest(image=image):
                manifest = copy.deepcopy(GOOD_MANIFEST)
                manifest["images"][image]["reference"] = None
                with self.assertRaises(layout.LayoutError):
                    layout.validate_manifest(manifest)
                manifest["images"][image]["reference"] = manifest["images"][image]["repository"] + ":latest"
                with self.assertRaises(layout.LayoutError):
                    layout.validate_manifest(manifest)

    def test_runtime_build_contract_is_offline_and_reproducible(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        for required in (
            "--network=none",
            "--pull=false",
            "--no-cache",
            "--provenance=false",
            "SOURCE_DATE_EPOCH=0",
            "type=oci",
            "rewrite-timestamp=true",
            "docker image load",
            "manifest digest",
            "config digest",
            "containerd image store",
            "repeat the no-cache build",
        ):
            with self.subTest(required=required):
                self.assertIn(required, readme)

    def test_stalwart_store_config_is_fixed_to_its_private_volume(self):
        config = json.loads((ROOT / "stalwart-config.json").read_text(encoding="utf-8"))
        self.assertEqual(
            config,
            {
                "@type": "RocksDb",
                "path": "/var/lib/stalwart/data",
                "blobSize": 4096,
                "bufferSize": 134217728,
                "poolWorkers": None,
                "poolMaxConnections": None,
                "cacheSize": None,
            },
        )

    def test_normal_layout_has_one_caddy_port_and_private_fixed_backends(self):
        template = json.loads((ROOT / "compose.template.json").read_text(encoding="utf-8"))
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        layout.validate_normal(rendered, POLICY)

        services = rendered["services"]
        self.assertEqual(
            set(services),
            {"caddy", "stalwart", "join", "helper", "approval", "captain-app"},
        )
        self.assertEqual(
            services["caddy"]["ports"],
            [f"443:{POLICY['deployment']['endpoints']['caddy']['port']}/tcp"],
        )
        for name in ("stalwart", "join", "helper", "approval", "captain-app"):
            self.assertNotIn("ports", services[name])
        deployment = POLICY["deployment"]
        endpoints = deployment["endpoints"]
        self.assertEqual(
            services["caddy"]["networks"]["service"]["ipv4_address"],
            endpoints["caddy"]["address"],
        )
        self.assertEqual(
            services["stalwart"]["networks"]["service"]["ipv4_address"],
            endpoints["stalwart"]["address"],
        )
        self.assertEqual(
            services["join"]["networks"]["service"]["ipv4_address"],
            endpoints["join"]["address"],
        )
        self.assertEqual(
            services["approval"]["networks"],
            {
                "service": {
                    "ipv4_address": endpoints["approval"]["address"],
                },
                "egress": {},
            },
        )
        self.assertEqual(
            services["captain-app"]["networks"],
            {"service": {}},
        )
        self.assertEqual(
            services["captain-app"]["user"],
            "2700:2700",
        )
        self.assertEqual(services["helper"]["network_mode"], "service:stalwart")
        self.assertEqual(
            rendered["networks"]["service"]["ipam"]["config"],
            [{"subnet": deployment["serviceNetwork"]}],
        )

    def test_approval_alone_joins_the_dedicated_egress_bridge(self):
        template = json.loads(
            (ROOT / "compose.template.json").read_text(encoding="utf-8")
        )
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        networks = rendered["networks"]

        self.assertEqual(
            networks["egress"],
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
        self.assertEqual(
            [
                name
                for name, service in rendered["services"].items()
                if "egress" in service.get("networks", {})
            ],
            ["approval"],
        )
        layout.validate_normal(rendered, POLICY)

        for mutation in (
            lambda candidate: candidate["services"]["approval"][
                "networks"
            ].pop("egress"),
            lambda candidate: candidate["services"]["join"]["networks"].update(
                egress={}
            ),
            lambda candidate: candidate["networks"]["egress"]["ipam"][
                "config"
            ][0].update(subnet="198.51.100.0/29"),
        ):
            candidate = copy.deepcopy(rendered)
            mutation(candidate)
            with self.assertRaises(layout.LayoutError):
                layout.validate_normal(candidate, POLICY)

    def test_packages_and_private_state_have_one_owner(self):
        template = json.loads((ROOT / "compose.template.json").read_text(encoding="utf-8"))
        services = layout.render(template, GOOD_MANIFEST, POLICY)["services"]
        serialized = {name: json.dumps(service) for name, service in services.items()}

        self.assertIn("${QD_PACKAGE}/signup:/opt/quarterdeck/signup:ro", services["join"]["volumes"])
        self.assertIn("${QD_PACKAGE}/signup:/opt/quarterdeck/signup:ro", services["helper"]["volumes"])
        self.assertEqual(
            services["helper"]["environment"]["PYTHONPATH"],
            "/opt/quarterdeck/signup:/opt/quarterdeck/qd-mail-stalwart",
        )
        self.assertIn(
            "${QD_PACKAGE}/qd-mail-stalwart:"
            "/opt/quarterdeck/qd-mail-stalwart:ro",
            services["helper"]["volumes"],
        )
        self.assertEqual(
            services["join"]["environment"]["PYTHONPATH"],
            (
                "/opt/quarterdeck/signup:/opt/quarterdeck/shared:"
                "/opt/quarterdeck/qd-mail-stalwart"
            ),
        )
        self.assertIn(
            "${QD_PACKAGE}/golive/shared:/opt/quarterdeck/shared:ro",
            services["join"]["volumes"],
        )
        self.assertIn(
            "${QD_PACKAGE}/qd-mail-stalwart:"
            "/opt/quarterdeck/qd-mail-stalwart:ro",
            services["join"]["volumes"],
        )
        self.assertIn(
            "${QD_PACKAGE}/signup:/opt/quarterdeck/signup:ro",
            services["approval"]["volumes"],
        )
        self.assertIn(
            "${QD_PACKAGE}/golive/shared:/opt/quarterdeck/shared:ro",
            services["approval"]["volumes"],
        )
        self.assertEqual(
            services["approval"]["environment"]["PYTHONPATH"],
            (
                "/opt/quarterdeck/captain-app:/opt/quarterdeck/signup:"
                "/opt/quarterdeck/shared"
            ),
        )
        self.assertEqual(
            services["join"]["command"],
            [
                "python3",
                "/opt/quarterdeck/connect/public_join.py",
                "--config",
                "/var/lib/quarterdeck-join/runtime.json",
            ],
        )
        self.assertEqual(
            services["helper"]["command"],
            [
                "python3",
                "/opt/quarterdeck/helper/server.py",
                "--config",
                "/var/lib/quarterdeck-helper/runtime.json",
            ],
        )
        self.assertEqual(
            services["approval"]["command"],
            [
                "python3",
                "/opt/quarterdeck/approval/server.py",
                "--config",
                "/var/lib/quarterdeck-approval/runtime.json",
            ],
        )
        self.assertEqual(
            services["captain-app"]["command"],
            [
                "python3",
                "/opt/quarterdeck/captain-app/server.py",
                "--config",
                "/var/lib/quarterdeck-captain/runtime.json",
            ],
        )

        self.assertIn("/var/lib/stalwart", serialized["stalwart"])
        self.assertNotIn("/var/lib/stalwart", "".join(serialized[name] for name in services if name != "stalwart"))
        self.assertIn("/data", serialized["caddy"])
        self.assertNotIn("caddy-data", "".join(serialized[name] for name in services if name != "caddy"))
        self.assertIn("approval-secrets", serialized["approval"])
        self.assertNotIn("approval-secrets", "".join(serialized[name] for name in services if name != "approval"))
        self.assertIn("helper-admin", serialized["helper"])
        self.assertNotIn("helper-admin", "".join(serialized[name] for name in services if name != "helper"))
        self.assertIn("/run/quarterdeck-control", serialized["join"])
        self.assertIn("/run/quarterdeck-control", serialized["helper"])
        self.assertIn("/run/quarterdeck-approval", serialized["join"])
        self.assertIn("/run/quarterdeck-approval", serialized["approval"])
        self.assertIn("/run/quarterdeck-captain-auth", serialized["approval"])
        self.assertIn("/run/quarterdeck-captain-auth", serialized["captain-app"])
        self.assertIn("captain-mail-key", serialized["captain-app"])
        self.assertNotIn(
            "captain-mail-key",
            "".join(
                serialized[name]
                for name in services
                if name != "captain-app"
            ),
        )
        self.assertNotIn("approval-secrets", serialized["captain-app"])
        self.assertNotIn("quarterdeck-admin", serialized["captain-app"])
        self.assertNotIn("docker.sock", json.dumps(services))

    def test_first_start_layout_has_bounded_bootstrap_and_recovery_services(self):
        template = json.loads((ROOT / "compose.first-start.template.json").read_text(encoding="utf-8"))
        rendered = layout.render(
            template,
            GOOD_MANIFEST,
            POLICY,
            helper_runtime=HELPER_RUNTIME,
        )
        layout.validate_first_start(rendered, HELPER_RUNTIME)
        self.assertEqual(
            set(rendered["services"]),
            {
                "stalwart-bootstrap",
                "stalwart-recovery",
                "first-start-configurator",
            },
        )
        bootstrap = rendered["services"]["stalwart-bootstrap"]
        recovery = rendered["services"]["stalwart-recovery"]
        configurator = rendered["services"]["first-start-configurator"]
        self.assertEqual(bootstrap["network_mode"], "none")
        self.assertEqual(bootstrap["logging"], {"driver": "none"})
        self.assertEqual(recovery["network_mode"], "none")
        self.assertEqual(configurator["network_mode"], "service:stalwart-recovery")
        for service in (bootstrap, recovery, configurator):
            self.assertNotIn("ports", service)
            self.assertNotIn("networks", service)
            self.assertNotIn("environment", service)
        self.assertEqual(
            bootstrap["entrypoint"],
            ["python3", "/opt/quarterdeck/bootstrap_launcher.py"],
        )
        self.assertEqual(
            bootstrap["command"],
            [
                "/run/quarterdeck-bootstrap/bootstrap-request.json",
                "/run/quarterdeck-admin/credential",
                f"admin@{POLICY['mailDomain']}",
                "18080",
                "--",
                "/usr/local/bin/stalwart",
                "--config",
                "/etc/stalwart/config.json",
            ],
        )
        bootstrap_volumes = set(bootstrap["volumes"])
        self.assertIn(
            "${QD_ROOT}/config/stalwart/bootstrap-request.json:"
            "/run/quarterdeck-bootstrap/bootstrap-request.json:ro",
            bootstrap_volumes,
        )
        self.assertIn(
            "${QD_ROOT}/secrets/helper-admin:/run/quarterdeck-admin:rw",
            bootstrap_volumes,
        )
        serialized = json.dumps(rendered)
        self.assertNotIn("STALWART_RECOVERY_ADMIN", serialized)
        self.assertNotIn("STALWART_RECOVERY_MODE", serialized)
        self.assertNotIn("password:", serialized)
        self.assertNotIn("Authorization", serialized)

    def test_unsafe_bootstrap_metadata_fails_closed(self):
        template = json.loads((ROOT / "compose.first-start.template.json").read_text(encoding="utf-8"))
        rendered = layout.render(
            template,
            GOOD_MANIFEST,
            POLICY,
            helper_runtime=HELPER_RUNTIME,
        )
        mutations = [
            lambda value: value["services"]["stalwart-bootstrap"].update(
                environment={"BOOTSTRAP_PASSWORD": "standin"}
            ),
            lambda value: value["services"]["stalwart-bootstrap"]["command"].append(
                "standin-credential"
            ),
            lambda value: value["services"]["stalwart-bootstrap"]["command"].__setitem__(
                1, "/run/quarterdeck-admin/other"
            ),
            lambda value: value["services"]["stalwart-bootstrap"]["command"].__setitem__(
                2, "other-admin"
            ),
            lambda value: value["services"]["stalwart-bootstrap"].update(
                network_mode="bridge"
            ),
            lambda value: value["services"]["stalwart-bootstrap"].update(
                ports=["18080:18080"]
            ),
            lambda value: value["services"]["stalwart-bootstrap"]["volumes"].remove(
                "${QD_ROOT}/secrets/helper-admin:/run/quarterdeck-admin:rw"
            ),
            lambda value: value["services"]["stalwart-bootstrap"].update(
                logging={
                    "driver": "json-file",
                    "options": {"max-size": "1m", "max-file": "2"},
                }
            ),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                candidate = copy.deepcopy(rendered)
                mutate(candidate)
                with self.assertRaises(layout.LayoutError):
                    layout.validate_first_start(candidate, HELPER_RUNTIME)

    def test_step_13_one_shots_have_exact_identities_and_isolation(self):
        template = json.loads(
            (ROOT / "compose.step13.template.json").read_text(
                encoding="utf-8"
            )
        )
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        layout.validate_step13(rendered)

        services = rendered["services"]
        self.assertEqual(
            set(services),
            {
                "write-oidc",
                "place-google-secret",
                "write-registry",
                "captain-account",
                "captain-account-admin",
            },
        )
        self.assertEqual(
            {name: service["user"] for name, service in services.items()},
            {
                "write-oidc": "2500:2500",
                "place-google-secret": "2500:2500",
                "write-registry": "2700:2700",
                "captain-account": "2700:2700",
                "captain-account-admin": "2200:2200",
            },
        )
        self.assertEqual(
            {
                name: service["network_mode"]
                for name, service in services.items()
            },
            {
                "write-oidc": "none",
                "place-google-secret": "none",
                "write-registry": "none",
                "captain-account": "none",
                "captain-account-admin": "service:stalwart",
            },
        )
        for service in services.values():
            self.assertEqual(service["logging"], {"driver": "none"})
            self.assertEqual(service["restart"], "no")
            self.assertNotIn("ports", service)
            self.assertNotIn("networks", service)

        serialized = {
            name: json.dumps(service)
            for name, service in services.items()
        }
        self.assertIn("approval-secrets", serialized["write-oidc"])
        self.assertIn("approval-secrets", serialized["place-google-secret"])
        self.assertNotIn(
            "approval-secrets",
            serialized["write-registry"]
            + serialized["captain-account"]
            + serialized["captain-account-admin"],
        )
        self.assertIn("captain-mail-key", serialized["captain-account"])
        self.assertNotIn(
            "captain-mail-key",
            serialized["write-oidc"]
            + serialized["place-google-secret"]
            + serialized["write-registry"]
            + serialized["captain-account-admin"],
        )
        self.assertIn("quarterdeck-admin", serialized["captain-account-admin"])
        self.assertNotIn(
            "quarterdeck-admin",
            serialized["write-oidc"]
            + serialized["place-google-secret"]
            + serialized["write-registry"]
            + serialized["captain-account"],
        )

    def test_step_13_one_shot_drift_fails_closed(self):
        template = json.loads(
            (ROOT / "compose.step13.template.json").read_text(
                encoding="utf-8"
            )
        )
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        mutations = [
            lambda value: value["services"]["write-oidc"].update(
                user="2700:2700"
            ),
            lambda value: value["services"]["place-google-secret"].update(
                network_mode="bridge"
            ),
            lambda value: value["services"]["write-registry"].update(
                logging={"driver": "json-file"}
            ),
            lambda value: value["services"]["captain-account"].update(
                ports=["8080:8080"]
            ),
            lambda value: value["services"]["captain-account-admin"][
                "volumes"
            ].append(
                "${QD_ROOT}/secrets/captain-mail-key:"
                "/run/quarterdeck-captain-mail:rw"
            ),
            lambda value: value["services"]["captain-account-admin"].update(
                network_mode="none"
            ),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                candidate = copy.deepcopy(rendered)
                mutate(candidate)
                with self.assertRaises(layout.LayoutError):
                    layout.validate_step13(candidate)

    def test_capability_contract_allows_only_caddy_net_bind_service(self):
        normal_template = json.loads(
            (ROOT / "compose.template.json").read_text(encoding="utf-8")
        )
        normal = layout.render(normal_template, GOOD_MANIFEST, POLICY)
        self.assertEqual(
            normal["services"]["caddy"]["cap_add"],
            ["NET_BIND_SERVICE"],
        )
        for name, service in normal["services"].items():
            if name != "caddy":
                self.assertNotIn("cap_add", service)


        for service in normal["services"].values():
            service.pop("cap_add", None)
        layout.validate_normal(normal, POLICY)

        normal["services"]["caddy"]["cap_add"] = ["NET_BIND_SERVICE"]
        layout.validate_normal(normal, POLICY)

    def test_normal_capability_drift_fails_closed(self):
        template = json.loads(
            (ROOT / "compose.template.json").read_text(encoding="utf-8")
        )
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        mutations = [
            lambda value: value["services"]["caddy"].update(
                cap_add=["SYS_ADMIN"]
            ),
            lambda value: value["services"]["caddy"].update(
                cap_add=["NET_BIND_SERVICE", "SYS_ADMIN"]
            ),
            lambda value: value["services"]["caddy"].update(cap_add=[]),
        ]
        mutations.extend(
            lambda value, name=name: value["services"][name].update(
                cap_add=["NET_BIND_SERVICE"]
            )
            for name in rendered["services"]
            if name != "caddy"
        )

        for mutate in mutations:
            with self.subTest(mutation=mutate):
                candidate = copy.deepcopy(rendered)
                mutate(candidate)
                with self.assertRaises(layout.LayoutError):
                    layout.validate_normal(candidate, POLICY)

    def test_first_start_and_step_13_capability_additions_fail_closed(self):
        first_start_template = json.loads(
            (ROOT / "compose.first-start.template.json").read_text(
                encoding="utf-8"
            )
        )
        first_start = layout.render(
            first_start_template,
            GOOD_MANIFEST,
            POLICY,
            helper_runtime=HELPER_RUNTIME,
        )
        for name in first_start["services"]:
            with self.subTest(model="first-start", service=name):
                candidate = copy.deepcopy(first_start)
                candidate["services"][name]["cap_add"] = [
                    "NET_BIND_SERVICE"
                ]
                with self.assertRaises(layout.LayoutError):
                    layout.validate_first_start(candidate, HELPER_RUNTIME)

        step_13_template = json.loads(
            (ROOT / "compose.step13.template.json").read_text(
                encoding="utf-8"
            )
        )
        step_13 = layout.render(step_13_template, GOOD_MANIFEST, POLICY)
        for name in step_13["services"]:
            with self.subTest(model="step-13", service=name):
                candidate = copy.deepcopy(step_13)
                candidate["services"][name]["cap_add"] = [
                    "NET_BIND_SERVICE"
                ]
                with self.assertRaises(layout.LayoutError):
                    layout.validate_step13(candidate)

    def test_unsafe_runtime_changes_fail_closed(self):
        template = json.loads((ROOT / "compose.template.json").read_text(encoding="utf-8"))
        rendered = layout.render(template, GOOD_MANIFEST, POLICY)
        mutations = [
            lambda value: value["services"]["join"].update(privileged=True),
            lambda value: value["services"]["helper"].update(network_mode="host"),
            lambda value: value["services"]["stalwart"].update(cap_drop=[]),
            lambda value: value["services"]["stalwart"].update(ports=["9000:9000"]),
            lambda value: value["services"]["caddy"].update(
                ports=["80:18080/tcp", value["services"]["caddy"]["ports"][0]]
            ),
            lambda value: value["services"]["helper"]["volumes"].append("/var/run/docker.sock:/var/run/docker.sock:rw"),
            lambda value: value["services"]["stalwart"].update(environment={"STALWART_RECOVERY_MODE": "1"}),
            lambda value: value["services"]["captain-app"].update(
                ports=["8080:8080"]
            ),
            lambda value: value["services"]["captain-app"].update(
                user="2702:2702"
            ),
            lambda value: value["services"]["captain-app"]["volumes"].remove(
                "${QD_PACKAGE}/qd-cards:/opt/quarterdeck/qd-cards:ro"
            ),
            lambda value: value["services"]["captain-app"]["environment"].update(
                PYTHONPATH="/opt/quarterdeck/captain-app"
            ),
            lambda value: value["services"]["approval"]["volumes"].append(
                "${QD_ROOT}/volumes/stalwart-data:/var/lib/stalwart:rw"
            ),
            lambda value: value["services"]["helper"]["environment"].pop("PYTHONPATH"),
            lambda value: value["services"]["caddy"]["networks"]["service"].update(
                ipv4_address=str(
                    ipaddress.ip_address(
                        POLICY["deployment"]["endpoints"]["caddy"][
                            "address"
                        ]
                    )
                    + 1
                )
            ),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                candidate = copy.deepcopy(rendered)
                mutate(candidate)
                with self.assertRaises(layout.LayoutError):
                    layout.validate_normal(candidate, POLICY)


if __name__ == "__main__":
    unittest.main(verbosity=2)
