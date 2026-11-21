import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PHONE_BLOCK = "@media (max-width: 36rem)"
WIDTHS = ("desktop", "phone")
VOID_TAGS = frozenset({"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"})
ICON_TAGS = frozenset({"svg", "line", "polyline"})
FORM_TAGS = frozenset({"form", "label", "textarea", "div", "button"}) | ICON_TAGS
COMPOSER_PARTS = ("form", "textarea", ".send-row", "#send", "label")
OUTSIDE_REFERENCES = ("href", "src", "xlink:href", "style")


class Node:
    def __init__(self, tag, attrs):
        self.tag = tag
        self.attrs = dict(attrs)
        self.children = []
        self.text = ""

    def walk(self):
        yield self
        for child in self.children:
            yield from child.walk()

    def visible_text(self):
        return "".join(node.text for node in self.walk()).strip()


class PageTree(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = Node("document", [])
        self.open = [self.root]

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs)
        self.open[-1].children.append(node)
        if tag not in VOID_TAGS:
            self.open.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.open) - 1, 0, -1):
            if self.open[index].tag == tag:
                del self.open[index:]
                return

    def handle_data(self, data):
        self.open[-1].text += data


def composer_form():
    tree = PageTree()
    tree.feed((ROOT / "chat.html").read_text(encoding="utf-8"))
    tree.close()
    forms = [node for node in tree.root.walk() if node.tag == "form"]
    if len(forms) != 1:
        raise AssertionError(f"expected one form, found {len(forms)}")
    return forms[0]


def points_up(icon):
    shaft = next((node for node in icon.walk() if node.tag == "line"), None)
    head = next((node for node in icon.walk() if node.tag == "polyline"), None)
    if shaft is None or head is None:
        return False
    x1, y1, x2, y2 = (float(shaft.attrs[name]) for name in ("x1", "y1", "x2", "y2"))
    values = [float(value) for value in re.findall(r"-?\d+(?:\.\d+)?", head.attrs["points"])]
    pairs = list(zip(values[0::2], values[1::2]))
    if len(pairs) != 3:
        return False
    left, apex, right = pairs
    return (
        x1 == x2
        and y2 < y1
        and apex == (x2, y2)
        and left[1] > apex[1]
        and right[1] > apex[1]
        and left[0] < apex[0] < right[0]
    )


def stylesheet():
    return (ROOT / "chat.css").read_text(encoding="utf-8")


def parse_blocks(text):
    blocks = []
    depth = 0
    prelude_start = 0
    prelude = ""
    body_start = 0
    for index, char in enumerate(text):
        if char == "{":
            if depth == 0:
                prelude = text[prelude_start:index].strip()
                body_start = index + 1
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                blocks.append((prelude, text[body_start:index]))
                prelude_start = index + 1
    return blocks


def declarations(body):
    pairs = (part.split(":", 1) for part in body.split(";") if ":" in part)
    return {name.strip(): value.strip() for name, value in pairs}


def flatten(text):
    rules = []
    for prelude, body in parse_blocks(text):
        if not prelude.startswith("@"):
            rules.extend((selector.strip(), declarations(body)) for selector in prelude.split(","))
    return rules


def phone_rules():
    inner = [body for prelude, body in parse_blocks(stylesheet()) if prelude == PHONE_BLOCK]
    if len(inner) != 1:
        raise AssertionError(f"expected one phone block, found {len(inner)}")
    return flatten(inner[0])


def style_at(selector, width):
    rules = flatten(stylesheet())
    if width == "phone":
        rules += phone_rules()
    merged = {}
    for name, declared in rules:
        if name == selector:
            merged.update(declared)
    return merged


class ComposerMarkupTests(unittest.TestCase):
    def test_the_form_holds_the_label_then_the_text_box_then_one_row(self):
        form = composer_form()

        self.assertEqual(form.attrs.get("id"), "composer")
        self.assertEqual([child.tag for child in form.children], ["label", "textarea", "div"])
        label, box, row = form.children
        self.assertEqual(label.attrs.get("for"), "message")
        self.assertEqual(label.visible_text(), "Message")
        self.assertEqual(box.attrs.get("id"), "message")
        self.assertEqual(row.attrs.get("class"), "send-row")

    def test_the_row_holds_only_the_send_key(self):
        row = composer_form().children[-1]

        self.assertEqual([child.tag for child in row.children], ["button"])
        self.assertEqual(row.text.strip(), "")
        self.assertEqual(row.children[0].attrs.get("id"), "send")

    def test_the_send_key_is_a_submit_key_named_send_with_no_word(self):
        send = next(node for node in composer_form().walk() if node.attrs.get("id") == "send")

        self.assertEqual(send.tag, "button")
        self.assertEqual(send.attrs.get("type"), "submit")
        self.assertEqual(send.attrs.get("aria-label"), "Send")
        self.assertEqual(send.visible_text(), "")

    def test_the_send_key_face_is_an_inline_up_arrow_with_nothing_fetched(self):
        send = next(node for node in composer_form().walk() if node.attrs.get("id") == "send")
        icon = [child for child in send.children if child.tag == "svg"]

        self.assertEqual(len(icon), 1)
        self.assertEqual(len(send.children), 1)
        self.assertIn("viewbox", icon[0].attrs)
        self.assertEqual(icon[0].attrs.get("aria-hidden"), "true")
        self.assertTrue({node.tag for node in icon[0].walk()} <= ICON_TAGS)
        self.assertTrue(points_up(icon[0]))
        for node in send.walk():
            for name in OUTSIDE_REFERENCES:
                self.assertNotIn(name, node.attrs)

    def test_the_form_has_no_plus_key_and_no_other_key(self):
        form = composer_form()
        keys = [node for node in form.walk() if node.tag in ("button", "input", "select", "a")]

        self.assertEqual([node.attrs.get("id") for node in keys], ["send"])
        self.assertTrue({node.tag for node in form.walk()} <= FORM_TAGS)
        self.assertNotIn("+", form.visible_text())

    def test_the_form_has_one_submit_key_and_no_handler_attributes(self):
        form = composer_form()
        submitting = [node for node in form.walk() if node.attrs.get("type") == "submit"]

        self.assertEqual(len(submitting), 1)
        for node in form.walk():
            self.assertFalse([name for name in node.attrs if name.startswith("on")])
        self.assertNotIn("action", form.attrs)


class ComposerStyleTests(unittest.TestCase):
    def test_the_form_stacks_its_rows_at_every_width(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                form = style_at("form", width)
                header = style_at("header", width)

                self.assertEqual(form.get("display"), "flex")
                self.assertEqual(form.get("flex-direction"), "column")
                self.assertEqual(form.get("align-items", "stretch"), "stretch")
                self.assertEqual(header.get("display"), "flex")
                self.assertEqual(header.get("flex-direction", "row"), "row")

    def test_the_text_box_takes_the_full_row_at_every_width(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                box = style_at("textarea", width)

                self.assertEqual(box.get("width"), "100%")
                self.assertEqual(box.get("box-sizing"), "border-box")
                self.assertEqual(box.get("min-width"), "0")

    def test_the_send_row_puts_the_key_at_the_right_end_at_every_width(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                row = style_at(".send-row", width)

                self.assertEqual(row.get("display"), "flex")
                self.assertIn(row.get("justify-content"), ("flex-end", "end"))
                self.assertEqual(row.get("flex-direction", "row"), "row")

    def test_the_label_is_hidden_for_the_eye_but_kept_for_screen_readers_at_every_width(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                label = style_at("form label", width)

                self.assertEqual(label.get("position"), "absolute")
                self.assertEqual(label.get("width"), "1px")
                self.assertEqual(label.get("height"), "1px")
                self.assertEqual(label.get("overflow"), "hidden")
                self.assertNotEqual(label.get("display"), "none")
                self.assertNotEqual(label.get("visibility"), "hidden")

    def test_the_phone_block_leaves_the_composer_layout_alone(self):
        touched = [
            selector
            for selector, _ in phone_rules()
            if any(part in selector for part in COMPOSER_PARTS)
        ]

        self.assertEqual(touched, [])

    def test_the_send_key_keeps_the_touch_size_and_the_border(self):
        for width in WIDTHS:
            with self.subTest(width=width):
                key = style_at("button", width)
                send = style_at("#send", width)

                self.assertEqual(key.get("min-height"), "44px")
                self.assertEqual(key.get("min-width"), "44px")
                self.assertEqual(key.get("border"), "1px solid currentColor")
                self.assertEqual(send.get("min-height", "44px"), "44px")
                self.assertEqual(send.get("min-width", "44px"), "44px")
                self.assertEqual(send.get("border", "1px solid currentColor"), "1px solid currentColor")


if __name__ == "__main__":
    unittest.main(verbosity=2)
