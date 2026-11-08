import json
import unittest

import management_transport


NOT_A_REAL_SECRET = bytearray(b"fixed-nonfunctional-placeholder")
USING = [
    "urn:ietf:params:jmap:core",
    "urn:stalwart:jmap",
]



class Reader:
    def __init__(self):
        self.values = []

    def read(self):
        value = bytearray(NOT_A_REAL_SECRET)
        self.values.append(value)
        return value


class Response:
    status = 200

    def read(self, amount):
        return json.dumps({"methodResponses": [["x:Thing/get", {"list": []}, "test-1"]]}).encode()


class Connection:
    def __init__(self):
        self.requests = []
        self.closed = False

    def request(self, method, path, body, headers):
        document = json.loads(body)
        if document.get("using") != USING:
            raise AssertionError("live management stand-in requires using")
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return Response()

    def close(self):
        self.closed = True


class ManagementTransportTests(unittest.TestCase):
    def test_loopback_call_uses_basic_only_in_header_and_clears_source(self):
        reader = Reader()
        connection = Connection()
        transport = management_transport.ManagementTransport("captain-admin", reader, lambda: connection)
        result = transport.call("x:Thing/get", {"ids": []}, "test-1")

        self.assertEqual(result, {"list": []})
        self.assertEqual(len(connection.requests), 1)
        method, path, body, headers = connection.requests[0]
        self.assertEqual((method, path), ("POST", "/jmap"))
        self.assertEqual(json.loads(body)["methodCalls"], [["x:Thing/get", {"ids": []}, "test-1"]])
        self.assertEqual(set(headers), {"Authorization", "Content-Type"})
        self.assertTrue(headers["Authorization"].startswith(b"Basic "))
        self.assertNotIn(bytes(NOT_A_REAL_SECRET), body)
        self.assertEqual(reader.values[0], bytearray())
        self.assertTrue(connection.closed)

    def test_request_carries_exact_stalwart_capability_list(self):
        connection = Connection()
        management_transport.ManagementTransport(
            "captain-admin",
            Reader(),
            lambda: connection,
        ).call("x:Thing/get", {"ids": []}, "test-1")

        body = json.loads(connection.requests[0][2])
        self.assertEqual(body["using"], USING)
        self.assertEqual(set(body), {"using", "methodCalls"})

    def test_non_200_or_mismatched_response_is_generic_refusal(self):
        class BadResponse(Response):
            status = 503

        class BadConnection(Connection):
            def getresponse(self):
                return BadResponse()

        with self.assertRaises(management_transport.ManagementRefused):
            management_transport.ManagementTransport("captain-admin", Reader(), BadConnection).call(
                "x:Thing/get", {}, "test-1"
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
