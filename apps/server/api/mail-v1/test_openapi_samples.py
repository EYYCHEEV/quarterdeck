import copy
import hashlib
import json
import os
import re
import sys
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
SAMPLES = HERE / "samples"
QD_WEB = Path(os.environ.get("QD_WEB") or HERE.parent)
sys.path.insert(0, str(QD_WEB))
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(SAMPLES))

import openapi_check as check

SPEC = check.load((HERE / "openapi.yaml").read_text(encoding="utf-8"))
VALIDATOR = check.Validator(SPEC)
LIST = "/captain/mail"
THREAD = "/captain/mail/{ref}"
EXPECTED = {
    "list-5-threads.json": (LIST, "200"),
    "list-not-modified-304.json": (LIST, "304"),
    "list-empty.json": (LIST, "200"),
    "list-truncated-200-threads.json": (LIST, "200"),
    "thread-with-attachments-and-refs.json": (THREAD, "200"),
    "thread-html-only.json": (THREAD, "200"),
    "thread-sent-and-received.json": (THREAD, "200"),
    "thread-cut-long-body.json": (THREAD, "200"),
    "thread-omitted-older-mails.json": (THREAD, "200"),
    "error-400-bad-ref.json": (THREAD, "400"),
    "error-401-sign-in-required.json": (LIST, "401"),
    "error-403-session-refused.json": (LIST, "403"),
    "error-404-no-thread.json": (THREAD, "404"),
    "error-503-request-unavailable.json": (LIST, "503"),
}
THREAD_SAMPLES = {
    "MT-1": "thread-with-attachments-and-refs.json",
    "MT-2": "thread-html-only.json",
    "MT-3": "thread-sent-and-received.json",
    "MT-4": "thread-cut-long-body.json",
    "MT-5": "thread-omitted-older-mails.json",
}
SUMMARY_FIELDS = ["ref", "subject", "project", "lane", "card", "bots", "lastAt", "count", "days"]
THREAD_FIELDS = ["ref", "subject", "project", "lane", "card", "bots", "lastAt", "count", "omitted", "mails"]
MAIL_FIELDS = ["ref", "from", "to", "cc", "at", "text", "cut", "refs", "attachments"]
HTML_TEXT = "Weekly build summary\n\nAll 12 builds passed.\n\nFleet: 5 builds\nWeb: 7 builds\n\nDetails: build page."


def sample(name):
    return json.loads((SAMPLES / name).read_text(encoding="utf-8"))


def response_spec(path, status):
    found = SPEC["paths"][path]["get"]["responses"][status]
    if "$ref" in found:
        return VALIDATOR.resolve(found["$ref"])
    return found


def response_spec_text(response):
    return response.get("description") or VALIDATOR.resolve(response["$ref"]).get("description")


def walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


class ParserTests(unittest.TestCase):
    def test_maps_lists_scalars_and_flow_values(self):
        text = (
            "a: 1\n"
            "b:\n"
            "  - x\n"
            "  - y: 2.5\n"
            "    z: [1, \"two\", true, null]\n"
            "  - \"quoted: text # here\"\n"
            "c: {k: v, n: false}\n"
            "d: []\n"
            "\"200\": plain text; with semicolon\n"
        )
        self.assertEqual(
            check.load(text),
            {
                "a": 1,
                "b": ["x", {"y": 2.5, "z": [1, "two", True, None]}, "quoted: text # here"],
                "c": {"k": "v", "n": False},
                "d": [],
                "200": "plain text; with semicolon",
            },
        )

    def test_a_dotted_version_stays_text_and_escapes_work(self):
        self.assertEqual(check.load('v: 3.1.0\ns: "a\\"b\\\\c\\nd"\n'), {"v": "3.1.0", "s": 'a"b\\c\nd'})

    def test_unsupported_syntax_is_refused_not_guessed(self):
        for text in (
            "# comment\na: 1\n",
            "a: 1\n\tb: 2\n",
            "a: 1\na: 2\n",
            "a: [1, [2]]\n",
            "a: 'single'\n",
            "a: \"open\n",
            "a: 1\n   b: 2\n",
            "- 1\nb: 2\n",
            "a: \"bad \\q escape\"\n",
            "",
        ):
            with self.subTest(text=text), self.assertRaises(check.YamlError):
                check.load(text)

    def test_the_spec_file_parses_to_a_map_with_the_two_paths(self):
        self.assertEqual(SPEC["openapi"], "3.1.0")
        self.assertEqual(set(SPEC["paths"]), {LIST, THREAD})


class ValidatorTests(unittest.TestCase):
    def errors(self, value, schema):
        return check.Validator({"components": {"schemas": {}}}).errors(value, schema)

    def test_types_are_strict_about_booleans_and_numbers(self):
        self.assertEqual(self.errors(1, {"type": "integer"}), [])
        self.assertTrue(self.errors(True, {"type": "integer"}))
        self.assertTrue(self.errors(1.5, {"type": "integer"}))
        self.assertEqual(self.errors(0, {"type": "number"}), [])
        self.assertTrue(self.errors(True, {"type": "number"}))
        self.assertEqual(self.errors(None, {"type": ["string", "null"]}), [])
        self.assertTrue(self.errors(7, {"type": ["string", "null"]}))

    def test_objects_need_every_required_field_and_allow_no_extra_one(self):
        schema = {"type": "object", "additionalProperties": False, "required": ["a"], "properties": {"a": {"type": "string"}}}
        self.assertEqual(self.errors({"a": "x"}, schema), [])
        self.assertTrue(self.errors({}, schema))
        self.assertTrue(self.errors({"a": "x", "b": 1}, schema))
        self.assertTrue(self.errors({"a": 1}, schema))

    def test_const_enum_one_of_and_minimum_compare_types_too(self):
        self.assertTrue(self.errors(0, {"const": False}))
        self.assertEqual(self.errors(False, {"const": False}), [])
        self.assertTrue(self.errors("Z", {"enum": ["A", "B"]}))
        self.assertTrue(self.errors(1, {"oneOf": [{"type": "integer"}, {"type": "number"}]}))
        self.assertEqual(self.errors("x", {"oneOf": [{"type": "integer"}, {"type": "string"}]}), [])
        self.assertTrue(self.errors(1, {"minimum": 2}))

    def test_arrays_strings_and_dates(self):
        self.assertTrue(self.errors([1], {"type": "array", "minItems": 2}))
        self.assertTrue(self.errors([1, 2, 3], {"type": "array", "maxItems": 2}))
        self.assertTrue(self.errors("", {"type": "string", "minLength": 1}))
        self.assertTrue(self.errors("abc", {"type": "string", "pattern": "^[0-9]+$"}))
        self.assertEqual(self.errors("2026-11-02T09:00:00-05:00", {"type": "string", "format": "date-time"}), [])
        for bad in ("2026-11-02", "2026-11-02T09:00:00", "yesterday"):
            self.assertTrue(self.errors(bad, {"type": "string", "format": "date-time"}), bad)

    def test_unknown_keywords_and_formats_are_errors_not_silence(self):
        with self.assertRaises(ValueError):
            self.errors(1, {"multipleOf": 2})
        with self.assertRaises(ValueError):
            self.errors("x", {"format": "uuid"})
        with self.assertRaises(ValueError):
            self.errors(1, {"$ref": "#/x", "type": "integer"})


class SpecTests(unittest.TestCase):
    def test_each_path_has_one_get_with_the_documented_statuses(self):
        statuses = {
            LIST: {"200", "304", "400", "401", "403", "405", "429", "503"},
            THREAD: {"200", "400", "401", "403", "404", "405", "429", "503"},
        }
        for path, expected in statuses.items():
            with self.subTest(path=path):
                self.assertEqual(set(SPEC["paths"][path]), {"get"})
                self.assertEqual(set(SPEC["paths"][path]["get"]["responses"]), expected)

    def test_every_error_body_text_is_the_one_in_the_note(self):
        texts = {
            "401": "sign in required",
            "400": "request refused",
            "403": "request refused",
            "404": "not found",
            "405": "method not allowed",
            "429": "request refused",
            "503": "request unavailable",
        }
        for status, text in texts.items():
            with self.subTest(status=status):
                path = THREAD if status == "404" else LIST
                schema = response_spec(path, status)["content"]["application/json"]["schema"]
                self.assertEqual(VALIDATOR.errors({"error": text}, schema), [])
                self.assertTrue(VALIDATOR.errors({"error": text + "."}, schema))

    def test_every_reference_resolves_and_every_response_has_a_description(self):
        for node in walk(SPEC):
            if isinstance(node, dict) and "$ref" in node:
                VALIDATOR.resolve(node["$ref"])
        for path in SPEC["paths"].values():
            for status, response in path["get"]["responses"].items():
                with self.subTest(status=status):
                    self.assertTrue(response_spec_text(response))
        for name, response in SPEC["components"]["responses"].items():
            self.assertIn("description", response, name)

    def test_every_object_schema_with_properties_forbids_extra_fields(self):
        for name, schema in SPEC["components"]["schemas"].items():
            if "properties" in schema:
                with self.subTest(schema=name):
                    self.assertIs(schema.get("additionalProperties"), False)
                    self.assertEqual(set(schema.get("required", [])), set(schema["properties"]))

    def test_the_schemas_document_exactly_the_fields_of_the_note(self):
        schemas = SPEC["components"]["schemas"]
        self.assertEqual(list(schemas["ThreadSummary"]["properties"]), SUMMARY_FIELDS)
        self.assertEqual(list(schemas["MailThread"]["properties"]), THREAD_FIELDS)
        self.assertEqual(list(schemas["Mail"]["properties"]), MAIL_FIELDS)
        self.assertEqual(list(schemas["Attachment"]["properties"]), ["name", "size"])
        self.assertEqual(list(schemas["MailList"]["properties"]), ["threads", "truncated", "csrf", "freshUntil"])
        self.assertEqual(list(schemas["MailThreadAnswer"]["properties"]), ["thread", "csrf", "freshUntil"])

    def test_the_limits_of_the_note_are_in_the_schemas(self):
        schemas = SPEC["components"]["schemas"]
        self.assertEqual(schemas["MailList"]["properties"]["threads"]["maxItems"], 200)
        self.assertEqual(schemas["ThreadSummary"]["properties"]["days"]["maxItems"], 31)
        self.assertEqual(schemas["MailThread"]["properties"]["mails"]["maxItems"], 50)
        self.assertEqual(schemas["Mail"]["properties"]["to"]["maxItems"], 20)
        self.assertEqual(schemas["Mail"]["properties"]["attachments"]["maxItems"], 50)
        thread = SPEC["paths"][THREAD]["get"]["description"]
        for text in ("16384 bytes", "1 MiB", "newest 50", "omitted"):
            self.assertIn(text, thread)

    def test_names_are_one_line_of_1_to_255_characters_and_a_thread_has_at_most_50_bots(self):
        schemas = SPEC["components"]["schemas"]
        validator = check.Validator(SPEC)
        bots = [schemas["ThreadSummary"]["properties"]["bots"], schemas["MailThread"]["properties"]["bots"]]
        for schema in bots:
            self.assertEqual(schema["maxItems"], 50)
            self.assertEqual(validator.errors(["bot-a"] * 50, schema), [])
            self.assertTrue(validator.errors(["bot-a"] * 51, schema))
        mail = schemas["Mail"]["properties"]
        names = [bots[0]["items"], bots[1]["items"], mail["from"], mail["to"]["items"], mail["cc"]["items"]]
        for schema in names:
            self.assertEqual(validator.errors("n" * 255, schema), [])
            for bad in ("", "n" * 256, "two\nlines"):
                self.assertTrue(validator.errors(bad, schema), repr(bad))

    def test_the_list_documents_the_etag_the_304_and_no_query(self):
        listing = SPEC["paths"][LIST]["get"]
        self.assertIn("ETag", listing["responses"]["200"]["headers"])
        self.assertIn("ETag", listing["responses"]["304"]["headers"])
        self.assertNotIn("content", listing["responses"]["304"])
        self.assertIn("No query parameters", listing["description"])
        self.assertIn("200 threads", listing["summary"] + listing["description"])

    def test_the_thread_ref_pattern_is_the_one_in_the_note(self):
        pattern = SPEC["paths"][THREAD]["get"]["parameters"][0]["schema"]["pattern"]
        for good in ("MT-1", "MT-123456789"):
            self.assertRegex(good, pattern)
        for bad in ("MT-0", "MT-01", "MT-1234567890", "MT-1.2", "mt-1", "MT-"):
            self.assertNotRegex(bad, pattern)

    def test_403_is_documented_as_session_missing_expired_or_refused_on_every_route(self):
        for path in SPEC["paths"]:
            with self.subTest(path=path):
                text = response_spec_text(SPEC["paths"][path]["get"]["responses"]["403"])
                self.assertIn("session missing, expired or refused", text)
                self.assertIn("cannot be reached", text)

    def test_401_and_403_both_mean_sign_in_again_and_neither_is_the_only_one(self):
        overview = SPEC["info"]["description"]
        self.assertIn("401 and 403", overview)
        self.assertIn("sign in again", overview)
        self.assertNotIn("only 401", overview)
        for path in SPEC["paths"]:
            with self.subTest(path=path):
                text = response_spec_text(SPEC["paths"][path]["get"]["responses"]["401"])
                self.assertIn("403", text)
                self.assertIn("sign in again", text)

    def test_local_data_is_kept_on_401_and_403_and_cleared_only_when_the_server_says_so(self):
        overview = SPEC["info"]["description"]
        self.assertIn("keep local data", overview)
        self.assertIn("only when the server says so", overview)
        self.assertIn("Clear-Site-Data", overview)
        self.assertIn("the client never clears on its own", overview)
        for path in SPEC["paths"]:
            for status in ("401", "403"):
                with self.subTest(path=path, status=status):
                    text = response_spec_text(SPEC["paths"][path]["get"]["responses"][status])
                    self.assertIn("keep local data", text)
        for node in walk(SPEC):
            if isinstance(node, str):
                self.assertNotIn("clear local data", node.lower())

    def test_a_403_can_also_mean_the_sign_in_connection_failed(self):
        self.assertIn("a 403 can also mean that connection failed", SPEC["info"]["description"])
        for path in SPEC["paths"]:
            with self.subTest(path=path):
                text = response_spec_text(SPEC["paths"][path]["get"]["responses"]["403"])
                self.assertIn("sign-in connection fails", text)

    def test_the_overview_states_the_line_end_rule_the_excluded_mail_and_the_events_text(self):
        overview = SPEC["info"]["description"]
        self.assertIn("LF line ends only", overview)
        self.assertIn("lone CR", overview)
        for prefix in ("CARD: ", "UPDATE: ", "ANSWER: ", "COMMENT: ", "WITHDRAW: ", "CHAT: "):
            self.assertIn(prefix, overview)
        self.assertIn('{"cards":true,"chats":true,"mail":true}', overview)
        self.assertIn("at most once every 5 seconds", overview)


class SampleTests(unittest.TestCase):
    def test_the_folder_holds_exactly_the_expected_samples(self):
        self.assertEqual({path.name for path in SAMPLES.glob("*.json")}, set(EXPECTED))

    def test_each_sample_is_status_headers_and_body_only(self):
        for name in EXPECTED:
            with self.subTest(sample=name):
                self.assertEqual(list(sample(name)), ["status", "headers", "body"])

    def test_each_sample_is_a_documented_response_with_exactly_the_documented_fields_and_types(self):
        for name, (path, status) in EXPECTED.items():
            with self.subTest(sample=name):
                data = sample(name)
                spec = response_spec(path, status)
                self.assertEqual(str(data["status"]), status)
                if data["body"] is None:
                    self.assertNotIn("content", spec)
                    self.assertEqual(data["headers"]["Content-Length"], "0")
                    continue
                (media, content), = spec["content"].items()
                self.assertEqual(data["headers"]["Content-Type"].split(";")[0], media)
                self.assertEqual(VALIDATOR.errors(data["body"], content["schema"]), [])

    def test_documented_response_headers_are_present_in_the_samples(self):
        for name, (path, status) in EXPECTED.items():
            for header in response_spec(path, status).get("headers", {}):
                with self.subTest(sample=name, header=header):
                    self.assertIn(header, sample(name)["headers"])

    def test_content_length_matches_the_compact_body(self):
        for name in EXPECTED:
            data = sample(name)
            if data["body"] is not None:
                with self.subTest(sample=name):
                    self.assertEqual(data["headers"]["Content-Length"], str(len(compact(data["body"]).encode("utf-8"))))

    def test_csrf_and_fresh_until_are_the_fixed_placeholders_in_every_json_200(self):
        for name, (_, status) in EXPECTED.items():
            if status == "200":
                with self.subTest(sample=name):
                    body = sample(name)["body"]
                    self.assertEqual(body["csrf"], "csrf-placeholder")
                    self.assertIs(type(body["freshUntil"]), int)
                    self.assertEqual(body["freshUntil"], 0)

    def test_the_cards_headers_are_reused_byte_for_byte(self):
        reference = sample("error-403-session-refused.json")["headers"]
        for name in EXPECTED:
            if name.startswith("error-") or name.startswith("list-not") or name.startswith("list-") or name.startswith("thread-"):
                with self.subTest(sample=name):
                    shown = {key: value for key, value in sample(name)["headers"].items() if key not in ("Content-Length", "ETag")}
                    expected = {key: value for key, value in reference.items() if key != "Content-Length"}
                    self.assertEqual(shown, expected)

    def test_no_carriage_return_is_in_any_sample(self):
        for name in EXPECTED:
            with self.subTest(sample=name):
                raw = (SAMPLES / name).read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertNotIn(b"\\r", raw)

    def test_the_validator_catches_each_kind_of_drift_in_a_real_list_sample(self):
        listing = sample("list-5-threads.json")["body"]
        schema = response_spec(LIST, "200")["content"]["application/json"]["schema"]
        cases = {
            "a field removed": lambda item: item.pop("days"),
            "a field added": lambda item: item.update({"extra": 1}),
            "ref below one": lambda item: item.update({"ref": "MT-0"}),
            "ref as a number": lambda item: item.update({"ref": 5}),
            "subject empty": lambda item: item.update({"subject": ""}),
            "subject over two lines": lambda item: item.update({"subject": "a\nb"}),
            "subject over 200": lambda item: item.update({"subject": "a" * 201}),
            "lastAt without an offset": lambda item: item.update({"lastAt": "2026-11-02T09:00:00"}),
            "count zero": lambda item: item.update({"count": 0}),
            "count as text": lambda item: item.update({"count": "1"}),
            "a bad day": lambda item: item.update({"days": ["2026-11-4"]}),
            "no bots": lambda item: item.update({"bots": []}),
            "project as a number": lambda item: item.update({"project": 3}),
        }
        self.assertEqual(VALIDATOR.errors(listing, schema), [])
        for label, mutate in cases.items():
            with self.subTest(drift=label):
                body = copy.deepcopy(listing)
                mutate(body["threads"][0])
                self.assertTrue(VALIDATOR.errors(body, schema))
        too_many = copy.deepcopy(listing)
        too_many["threads"] = too_many["threads"] * 41
        self.assertTrue(VALIDATOR.errors(too_many, schema))

    def test_the_validator_catches_each_kind_of_drift_in_a_real_thread_sample(self):
        answer = sample("thread-with-attachments-and-refs.json")["body"]
        schema = response_spec(THREAD, "200")["content"]["application/json"]["schema"]
        cases = {
            "omitted negative": lambda body: body["thread"].update({"omitted": -1}),
            "a mail field removed": lambda body: body["thread"]["mails"][0].pop("cut"),
            "a mail field added": lambda body: body["thread"]["mails"][0].update({"html": "x"}),
            "attachment type leaked": lambda body: body["thread"]["mails"][1]["attachments"][0].update({"type": "application/pdf"}),
            "attachment size as text": lambda body: body["thread"]["mails"][1]["attachments"][0].update({"size": "1"}),
            "text with a carriage return": lambda body: body["thread"]["mails"][0].update({"text": "a\rb"}),
            "bad ref code": lambda body: body["thread"]["mails"][1].update({"refs": ["AR-0"]}),
            "bad mail ref": lambda body: body["thread"]["mails"][0].update({"ref": "MT-1"}),
            "no recipients": lambda body: body["thread"]["mails"][0].update({"to": []}),
            "cc item not text": lambda body: body["thread"]["mails"][0].update({"cc": [1]}),
            "cut as text": lambda body: body["thread"]["mails"][0].update({"cut": "no"}),
            "unknown thread field": lambda body: body["thread"].update({"days": ["2026-11-02"]}),
        }
        self.assertEqual(VALIDATOR.errors(answer, schema), [])
        for label, mutate in cases.items():
            with self.subTest(drift=label):
                body = copy.deepcopy(answer)
                mutate(body)
                self.assertTrue(VALIDATOR.errors(body, schema))
        crowded = copy.deepcopy(answer)
        crowded["thread"]["mails"] = crowded["thread"]["mails"] * 13
        self.assertTrue(VALIDATOR.errors(crowded, schema))


class ListSampleTests(unittest.TestCase):
    def setUp(self):
        self.listing = sample("list-5-threads.json")
        self.threads = self.listing["body"]["threads"]

    def test_it_is_five_threads_newest_first_with_the_documented_fields(self):
        self.assertEqual([item["ref"] for item in self.threads], ["MT-5", "MT-4", "MT-3", "MT-2", "MT-1"])
        self.assertEqual([list(item) for item in self.threads], [SUMMARY_FIELDS] * 5)
        self.assertEqual([item["count"] for item in self.threads], [60, 1, 3, 1, 4])
        last = [item["lastAt"] for item in self.threads]
        self.assertEqual(last, sorted(last, reverse=True))

    def test_project_lane_and_card_are_null_in_v1(self):
        for item in self.threads:
            with self.subTest(ref=item["ref"]):
                self.assertEqual((item["project"], item["lane"], item["card"]), (None, None, None))

    def test_card_and_chat_mail_in_the_stand_in_mailbox_is_not_listed(self):
        subjects = " ".join(item["subject"] for item in self.threads)
        self.assertNotIn("CARD", subjects)
        self.assertNotIn("CHAT", subjects)
        self.assertEqual(sum(item["count"] for item in self.threads), 69)

    def test_a_reply_that_names_a_message_joins_its_thread_even_with_another_subject(self):
        first = self.threads[-1]
        self.assertEqual(first["subject"], "Search group limit: how many rows per group?")
        self.assertEqual(first["count"], 4)
        mails = sample("thread-with-attachments-and-refs.json")["body"]["thread"]["mails"]
        self.assertEqual(len(mails), 4)
        self.assertIn("Closing this out", mails[-1]["text"])

    def test_bots_have_no_repeats_and_days_are_new_york_days_newest_first(self):
        for item in self.threads:
            with self.subTest(ref=item["ref"]):
                self.assertEqual(len(item["bots"]), len(set(item["bots"])))
                self.assertEqual(item["days"], sorted(item["days"], reverse=True))
                self.assertEqual(item["days"][0], item["lastAt"][:10])

    def test_the_etag_is_the_sha256_of_the_list_content_and_the_304_repeats_it(self):
        content = {key: value for key, value in self.listing["body"].items() if key not in ("csrf", "freshUntil")}
        etag = '"' + hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest() + '"'
        self.assertEqual(self.listing["headers"]["ETag"], etag)
        self.assertEqual(sample("list-not-modified-304.json")["headers"]["ETag"], etag)

    def test_the_empty_list_and_the_truncated_list(self):
        empty = sample("list-empty.json")["body"]
        self.assertEqual((empty["threads"], empty["truncated"]), ([], False))
        crowded = sample("list-truncated-200-threads.json")["body"]
        refs = [item["ref"] for item in crowded["threads"]]
        self.assertEqual((len(refs), crowded["truncated"], refs[0], refs[-1]), (200, True, "MT-205", "MT-6"))

    def test_each_thread_sample_agrees_with_its_summary(self):
        by_ref = {item["ref"]: item for item in self.threads}
        for ref, name in THREAD_SAMPLES.items():
            thread = sample(name)["body"]["thread"]
            summary = by_ref[ref]
            with self.subTest(sample=name):
                self.assertEqual(list(thread), THREAD_FIELDS)
                for key in ("ref", "subject", "project", "lane", "card", "bots", "lastAt", "count"):
                    self.assertEqual(thread[key], summary[key], key)
                self.assertEqual(thread["omitted"], thread["count"] - len(thread["mails"]))


class ThreadSampleTests(unittest.TestCase):
    def mails(self, name):
        return sample(name)["body"]["thread"]["mails"]

    def test_mail_refs_name_their_thread_and_run_oldest_first(self):
        for ref, name in THREAD_SAMPLES.items():
            mails = self.mails(name)
            numbers = [int(mail["ref"].rsplit(".", 1)[1]) for mail in mails]
            with self.subTest(sample=name):
                self.assertTrue(all(mail["ref"].startswith(ref + ".") for mail in mails))
                self.assertEqual(numbers, sorted(numbers))
                self.assertEqual([list(mail) for mail in mails], [MAIL_FIELDS] * len(mails))
                self.assertEqual([mail["at"] for mail in mails], sorted(mail["at"] for mail in mails))
                self.assertTrue(all(mail["cc"] == [] for mail in mails))

    def test_attachments_are_names_and_sizes_only(self):
        mails = self.mails("thread-with-attachments-and-refs.json")
        self.assertEqual(mails[1]["attachments"], [{"name": "search-notes.pdf", "size": 48213}, {"name": "layout.png", "size": 20480}])
        self.assertEqual([mail["attachments"] for mail in (mails[0], mails[2], mails[3])], [[], [], []])

    def test_refs_are_ar_codes_then_pg_codes(self):
        mails = self.mails("thread-with-attachments-and-refs.json")
        self.assertEqual([mail["refs"] for mail in mails], [[], ["AR-4", "PG-2"], ["AR-4"], []])
        self.assertEqual(self.mails("thread-sent-and-received.json")[2]["refs"], ["AR-12", "PG-7"])

    def test_an_html_only_message_is_shown_as_plain_text(self):
        (mail,) = self.mails("thread-html-only.json")
        self.assertEqual(mail["text"], HTML_TEXT)
        self.assertNotIn("<", mail["text"])
        self.assertNotIn("track", mail["text"])

    def test_a_crlf_message_arrives_with_lf_line_ends(self):
        mails = self.mails("thread-sent-and-received.json")
        self.assertEqual(mails[1]["text"], "Thursday works.\nPlease confirm the build is green first.\nThanks.")
        self.assertEqual((mails[1]["from"], mails[1]["to"]), ("account-user", ["bot-b"]))

    def test_a_long_body_is_cut_on_a_line_of_16384_bytes_or_less(self):
        (mail,) = self.mails("thread-cut-long-body.json")
        size = len(mail["text"].encode("utf-8"))
        self.assertTrue(mail["cut"])
        self.assertLessEqual(size, 16384)
        self.assertGreater(size, 16384 - 4)

    def test_an_old_thread_returns_the_newest_50_and_counts_the_rest_as_omitted(self):
        thread = sample("thread-omitted-older-mails.json")["body"]["thread"]
        refs = [mail["ref"] for mail in thread["mails"]]
        self.assertEqual((thread["count"], thread["omitted"], len(refs)), (60, 10, 50))
        self.assertEqual((refs[0], refs[-1]), ("MT-5.11", "MT-5.60"))

    def test_the_largest_thread_sample_is_under_one_mib(self):
        for name in THREAD_SAMPLES.values():
            with self.subTest(sample=name):
                self.assertLess(int(sample(name)["headers"]["Content-Length"]), 1_048_576)


class ReadmeTests(unittest.TestCase):
    def setUp(self):
        self.text = (SAMPLES / "README.md").read_text(encoding="utf-8")

    def test_it_names_every_sample_file(self):
        for name in EXPECTED:
            self.assertIn(f"`{name}`", self.text)

    def test_it_states_the_placeholders_and_the_real_sizes(self):
        self.assertIn("csrf-placeholder", self.text)
        for name in ("list-5-threads.json", "list-truncated-200-threads.json", "thread-cut-long-body.json"):
            size = sample(name)["headers"]["Content-Length"]
            with self.subTest(sample=name):
                self.assertIn(f"{size} bytes", self.text)

    def test_it_says_which_sign_in_path_each_error_sample_comes_from(self):
        section = self.text.split("## Which sign-in path each error comes from", 1)[1].split("\n## ", 1)[0]
        names = ("error-401-sign-in-required.json", "error-403-session-refused.json")
        lines = {name: line for line in section.splitlines() for name in names if name in line}
        self.assertEqual(set(lines), set(names))
        self.assertIn("in-process", lines["error-401-sign-in-required.json"])
        self.assertIn("SocketApprovalGate", lines["error-403-session-refused.json"])
        self.assertIn("401 and 403", section)

    def test_it_says_to_sign_in_again_keep_local_data_and_when_data_is_cleared(self):
        section = self.text.split("## Which sign-in path each error comes from", 1)[1].split("\n## ", 1)[0]
        self.assertIn("sign in again", section)
        self.assertIn("keep local data", section)
        self.assertIn("Clear-Site-Data", section)
        self.assertNotIn("clear local data", self.text.lower())

    def test_it_names_the_story_the_mailbox_tells(self):
        for text in ("MT-1", "MT-5", "Search group, final answer", "CARD: Pick the release day", "CHAT: bot-a"):
            self.assertIn(text, self.text)


class IntegrityTests(unittest.TestCase):
    def test_sha256sums_lists_every_file_in_the_folder_except_itself(self):
        lines = (SAMPLES / "SHA256SUMS.txt").read_text(encoding="ascii").splitlines()
        listed = {}
        for line in lines:
            digest, name = line.split("  ", 1)
            self.assertRegex(digest, r"^[0-9a-f]{64}$")
            listed[name] = digest
        present = {path.name for path in SAMPLES.iterdir() if path.is_file() and path.name != "SHA256SUMS.txt"}
        self.assertEqual(set(listed), present)
        for name, digest in listed.items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((SAMPLES / name).read_bytes()).hexdigest(), digest)
        self.assertEqual([line.split("  ", 1)[1] for line in lines], sorted(listed, key=lambda item: item.encode("utf-8")))

    def test_every_sample_is_exactly_what_the_module_records_now(self):
        import make_samples

        built = make_samples.build()
        self.assertEqual(set(built), set(EXPECTED))
        for name, data in built.items():
            with self.subTest(sample=name):
                self.assertEqual((SAMPLES / name).read_bytes(), data)

    def test_samples_hold_no_address_or_secret_shaped_text(self):
        for name in EXPECTED:
            data = sample(name)
            shown = {"headers": {key: value for key, value in data["headers"].items() if key != "ETag"}, "body": data["body"]}
            text = json.dumps(shown, ensure_ascii=False)
            with self.subTest(sample=name):
                self.assertNotRegex(text, r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
                self.assertNotRegex(text, r"[0-9A-Fa-f]{32,}")
                self.assertNotRegex(text, r"@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
                for host in re.findall(r"https?://([A-Za-z0-9.-]+)", text):
                    self.assertRegex(host, r"(?:\.invalid|^example\.(?:com|org|net))$")


class RealGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import make_samples
        import tempfile

        cls.make = make_samples
        cls.folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.folder.cleanup)

    def through(self, reply, path, **options):
        import mail_standins as standins

        server = standins.StandInStalwart(self.make.story())
        return self.make.through_real_gate(server, self.folder.name, reply, path, **options)

    def test_a_signed_in_session_through_the_same_gate_is_answered(self):
        answer, owner = self.through(self.make.SIGNED_IN_REPLY, "/captain/mail")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(owner.operations(), ["authenticate"])
        self.assertIs(self.make.approval_security.requires_fresh("GET", "/captain/mail"), False)

    def test_a_refused_session_answers_403_and_the_owner_is_asked_once_to_authenticate(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                answer, owner = self.through(self.make.REFUSAL_REPLY, path)
                self.assertEqual((answer["status"], answer["body"]), (403, {"error": "request refused"}))
                self.assertEqual(owner.operations(), ["authenticate"])

    def test_no_session_cookie_answers_403_without_asking_the_owner(self):
        for path in ("/captain/mail", "/captain/mail/MT-1"):
            with self.subTest(path=path):
                answer, owner = self.through(self.make.REFUSAL_REPLY, path, cookie=False)
                self.assertEqual((answer["status"], answer["body"]), (403, {"error": "request refused"}))
                self.assertEqual(owner.opened, 0)

    def test_an_unreachable_or_confused_owner_answers_403_too(self):
        cases = (
            ("unreachable", b"", ConnectionRefusedError()),
            ("not json", b"not json\n", None),
            ("empty", b"", None),
        )
        for label, reply, error in cases:
            with self.subTest(case=label):
                answer, owner = self.through(reply, "/captain/mail", connect_error=error)
                self.assertEqual((answer["status"], answer["body"]), (403, {"error": "request refused"}))
                self.assertEqual(owner.opened, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
