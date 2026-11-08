import copy
import json
import tempfile
import unittest
from pathlib import Path

import layout
from test_layout import GOOD_MANIFEST, POLICY

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "compose.template.json"
SUBNET_REFERENCE = "${QD_EGRESS_SUBNET}"
EXAMPLE_VALUE = "203.0.113.0/29"


def render_normal():
    template = json.loads(TEMPLATE.read_text(encoding="utf-8"))
    return layout.render(template, copy.deepcopy(GOOD_MANIFEST), POLICY)


def egress_config(document):
    return document["networks"]["egress"]["ipam"]["config"]


class EgressSubnetFailsClosedTests(unittest.TestCase):
    def test_render_keeps_the_deploy_time_reference_and_never_a_default(self):
        rendered = render_normal()
        self.assertEqual(egress_config(rendered), [{"subnet": SUBNET_REFERENCE}])
        self.assertNotIn("203.0.113.", json.dumps(rendered))
        layout.validate_normal(rendered, POLICY)

    def test_the_template_and_the_layout_code_carry_no_default_subnet(self):
        for path in (TEMPLATE, ROOT / "layout.py"):
            with self.subTest(path=path.name):
                self.assertNotIn("203.0.113.", path.read_text(encoding="utf-8"))

    def test_the_final_check_refuses_any_value_but_the_reference(self):
        for value in ("", EXAMPLE_VALUE, "${QD_EGRESS_SUBNET:-" + EXAMPLE_VALUE + "}", "${QD_UNSET_SUBNET}", "198.51.100.0/29"):
            with self.subTest(value=value):
                rendered = render_normal()
                egress_config(rendered)[0]["subnet"] = value
                with self.assertRaises(layout.LayoutError):
                    layout.validate_normal(rendered, POLICY)

    def test_a_missing_subnet_entry_is_refused(self):
        rendered = render_normal()
        egress_config(rendered).clear()
        with self.assertRaises(layout.LayoutError):
            layout.validate_normal(rendered, POLICY)
        rendered = render_normal()
        del rendered["networks"]["egress"]["ipam"]
        with self.assertRaises(layout.LayoutError):
            layout.validate_normal(rendered, POLICY)

    def test_the_command_line_writes_the_reference_never_a_default(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            manifest = work / "image-manifest.json"
            manifest.write_text(json.dumps(GOOD_MANIFEST), encoding="utf-8")
            policy = ROOT.parent / "door" / "door-policy.json"
            output = work / "compose.json"
            self.assertEqual(layout.main(["normal", str(manifest), str(policy), str(TEMPLATE), str(output)]), 0)
            written = output.read_text(encoding="utf-8")
            self.assertEqual(egress_config(json.loads(written)), [{"subnet": SUBNET_REFERENCE}])
            self.assertNotIn("203.0.113.", written)


if __name__ == "__main__":
    unittest.main()
