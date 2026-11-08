import copy
import json
import tempfile
import unittest
from pathlib import Path

import layout
from test_layout import GOOD_MANIFEST, POLICY

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "compose.template.json"
SETTING = "QD_CARD_LINK_ORIGIN"
REFERENCE = "${QD_CARD_LINK_ORIGIN}"


def render_normal():
    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    return layout.render(template, copy.deepcopy(GOOD_MANIFEST), POLICY)


class CardLinkSettingTests(unittest.TestCase):
    def test_render_keeps_the_deploy_time_reference(self):
        rendered = render_normal()
        self.assertEqual(rendered["services"]["captain-app"]["environment"][SETTING], REFERENCE)
        layout.validate_normal(rendered, POLICY)

    def test_only_the_approval_app_takes_the_setting(self):
        rendered = render_normal()
        for name, service in rendered["services"].items():
            with self.subTest(service=name):
                self.assertEqual(SETTING in service.get("environment", {}), name == "captain-app")

    def test_the_final_check_refuses_any_value_but_the_reference(self):
        for value in ("", "http://qd.example.invalid", "${QD_CARD_LINK_ORIGIN:-http://qd.example.invalid}", "${QD_UNSET_ORIGIN}"):
            with self.subTest(value=value):
                rendered = render_normal()
                rendered["services"]["captain-app"]["environment"][SETTING] = value
                with self.assertRaises(layout.LayoutError):
                    layout.validate_normal(rendered, POLICY)

    def test_a_missing_setting_is_refused(self):
        rendered = render_normal()
        del rendered["services"]["captain-app"]["environment"][SETTING]
        with self.assertRaises(layout.LayoutError):
            layout.validate_normal(rendered, POLICY)

    def test_the_command_line_writes_the_reference_never_a_host(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            manifest = work / "image-manifest.json"
            manifest.write_text(json.dumps(GOOD_MANIFEST), encoding="utf-8")
            policy = ROOT.parent / "door" / "door-policy.json"
            output = work / "compose.json"
            self.assertEqual(layout.main(["normal", str(manifest), str(policy), str(TEMPLATE), str(output)]), 0)
            written = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(written["services"]["captain-app"]["environment"][SETTING], REFERENCE)


if __name__ == "__main__":
    unittest.main()
