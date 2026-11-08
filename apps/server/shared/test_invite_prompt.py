from __future__ import annotations

import unittest

import invite_prompt


class InvitePromptTests(unittest.TestCase):
    def test_prompt_pins_release_then_uses_the_invite_only_as_an_mcp_tool_parameter(self):
        release = invite_prompt.ReleaseConfig(
            artifact_url="https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl",
            version="1.2.3",
            sha256="ab" * 32,
            join_address="https://approval.example.invalid",
        )
        invite = "abcdefghijklmnopqrstuv"
        code = bytearray(invite.encode("ascii"))

        prompt = invite_prompt.build_prompt(release, code)
        expected = (
            "Key commandment: keep your own Quarterdeck key safe in a file named quarterdeck-key-<your bot name> that only you may read. Never use, read, copy or ask for another bot's key, even on a shared computer.\n\n"
            "Step 1: install Quarterdeck QD MCP 1.2.3 from its pinned public release.\n"
            "curl --proto '=https' --tlsv1.2 --fail --location --output "
            "quarterdeck_mcp-1.2.3-py3-none-any.whl "
            "https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl "
            "&& printf '%s  %s\\n' "
            "abababababababababababababababababababababababababababababababab "
            "quarterdeck_mcp-1.2.3-py3-none-any.whl | sha256sum --check --strict "
            "&& python3 -m pip install --no-deps "
            "./quarterdeck_mcp-1.2.3-py3-none-any.whl\n\n"
            "Step 2: configure https://approval.example.invalid in QD_CONFIG and add "
            "Quarterdeck as an MCP server over stdio. The server command contains no "
            "invite.\n"
            'Command: qd-mcp --config "${QD_CONFIG:?set QD_CONFIG}"\n\n'
            "Step 3: call the `qd_join` MCP tool with this tool input over stdio "
            "(not a shell command or process argument):\n"
            '{"description":"Invited to Quarterdeck",'
            '"invite":"abcdefghijklmnopqrstuv"}\n\n'
            "Residual: this one-use, short-lived invite is present in the agent "
            "conversation until the tool consumes it, and joining still requires "
            "the Captain's approval."
        )

        self.assertEqual(prompt, expected)

        self.assertEqual(code, bytearray())
        self.assertIn("quarterdeck_mcp-1.2.3-py3-none-any.whl", prompt)
        self.assertIn("https://releases.example.invalid/", prompt)
        self.assertIn("ab" * 32, prompt)
        self.assertIn("sha256sum --check --strict", prompt)
        self.assertIn("python3 -m pip install --no-deps", prompt)
        self.assertIn("https://approval.example.invalid", prompt)
        self.assertIn("stdio", prompt)
        self.assertIn("qd-mcp --config", prompt)
        self.assertIn("`qd_join`", prompt)
        self.assertIn(f'"invite":"{invite}"', prompt)
        shell_text = "\n".join(
            line
            for line in prompt.splitlines()
            if line.startswith(("curl ", "Command: "))
        )
        self.assertNotIn(invite, shell_text)
        self.assertNotIn("| qd ", prompt)
        self.assertNotIn("--bot", prompt)
        self.assertNotIn("latest", prompt.lower())

    def test_unpublished_prompt_has_no_release_command_and_keeps_the_join_tool_contract(self):
        release = invite_prompt.ReleaseConfig(
            artifact_url=None,
            version=None,
            sha256=None,
            join_address="https://approval.example.invalid",
        )
        invite = "abcdefghijklmnopqrstuv"
        code = bytearray(invite.encode("ascii"))

        prompt = invite_prompt.build_prompt(release, code)

        self.assertEqual(code, bytearray())
        self.assertTrue(
            prompt.split("\n\n", 1)[1].startswith(
                "Step 1: this Quarterdeck has no public QD MCP release yet. "
                "Use the Quarterdeck client your operator installed for you; "
                "if you do not have it, stop and ask your operator."
            )
        )
        self.assertEqual(prompt.count(invite), 1)
        without_join_address = prompt.replace(release.join_address, "")
        for forbidden in ("curl", "pip", "sha256sum", "http"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, without_join_address.lower())
        self.assertIn("Step 2: configure https://approval.example.invalid", prompt)
        self.assertIn("Step 3: call the `qd_join` MCP tool", prompt)
        self.assertIn("Residual: this one-use, short-lived invite", prompt)

    def test_release_state_refuses_mixed_pinned_and_unpublished_values(self):
        for artifact_url, version, digest in (
            (None, "1.2.3", None),
            ("https://releases.example.invalid/tool-1.2.3.whl", None, None),
            (None, None, "ab" * 32),
        ):
            with self.subTest(
                artifact_url=artifact_url,
                version=version,
                digest=digest,
            ):
                with self.assertRaises(ValueError):
                    invite_prompt.ReleaseConfig(
                        artifact_url=artifact_url,
                        version=version,
                        sha256=digest,
                        join_address="https://approval.example.invalid",
                    )

    def test_prompt_refuses_unpinned_or_non_https_release(self):
        for url, version, digest in (
            ("http://releases.example.invalid/tool.whl", "1.2.3", "ab" * 32),
            ("https://releases.example.invalid/tool.whl", "latest", "ab" * 32),
            ("https://releases.example.invalid/tool.whl", "1.2.3", "unset"),
        ):
            with self.subTest(url=url, version=version, digest=digest):
                with self.assertRaises(ValueError):
                    invite_prompt.ReleaseConfig(
                        artifact_url=url,
                        version=version,
                        sha256=digest,
                        join_address="https://approval.example.invalid",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
