from __future__ import annotations

import unittest

import invite_prompt


class CommandmentBytesTests(unittest.TestCase):
    def test_prompt_starts_with_the_exact_commandment_bytes_and_a_blank_line(self):
        expected = b"Key commandment: keep your own Quarterdeck key safe in a file named quarterdeck-key-<your bot name> that only you may read. Never use, read, copy or ask for another bot's key, even on a shared computer."
        for release in (
            invite_prompt.ReleaseConfig(None, None, None, 'https://approval.example.invalid'),
            invite_prompt.ReleaseConfig('https://releases.example.invalid/quarterdeck_mcp-1.2.3-py3-none-any.whl', '1.2.3', 'ab' * 32, 'https://approval.example.invalid'),
        ):
            with self.subTest(published=release.published):
                prompt = invite_prompt.build_prompt(release, bytearray(b'abcdefghijklmnopqrstuv')).encode('utf-8')
                self.assertEqual(prompt.partition(b'\n\n')[0], expected)
                self.assertTrue(prompt.startswith(expected + b'\n\nStep 1:'))
