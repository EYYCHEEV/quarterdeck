import hashlib
import unittest

import test_layout


def synthetic(label):
    return hashlib.sha256(('quarterdeck-synthetic-' + label).encode()).hexdigest()


class SyntheticRuntimeTests(unittest.TestCase):
    def test_runtime_reference_and_configuration_are_synthetic(self):
        self.assertTrue(test_layout.RUNTIME_REFERENCE == 'sha256:' + synthetic('runtime-reference'), 'runtime reference must be synthetic')
        self.assertTrue(test_layout.RUNTIME_CONFIG_DIGEST == 'sha256:' + synthetic('runtime-config'), 'runtime configuration must be synthetic')

    def test_all_fifteen_layers_are_synthetic(self):
        expected = ['sha256:' + synthetic(f'layer-{number:02d}') for number in range(1, 16)]
        self.assertTrue(test_layout.RUNTIME_DIFF_IDS == expected, 'all fifteen layer identities must be synthetic')

    def test_all_seven_copied_file_digests_are_synthetic(self):
        self.assertEqual(len(test_layout.RUNTIME_COPY_SHA256), 7)
        for path, value in test_layout.RUNTIME_COPY_SHA256.items():
            self.assertTrue(value == synthetic('copy-' + path), 'copied-file digest must be synthetic')
