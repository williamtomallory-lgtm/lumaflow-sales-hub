"""Small offline tests for the release protocol; no model imports/inference."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


def module(filename):
    spec = importlib.util.spec_from_file_location(filename.replace('-', '_'), Path(__file__).with_name(filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


installer = module('install-local-models.py')
packager = module('package-local-models.py')


class BundleTests(unittest.TestCase):
    def test_split_roundtrip_and_preserve_mismatched_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'source.bin'
            source.write_bytes(bytes(range(256)) * 20)
            parts = root / 'parts'
            parts.mkdir()
            packager.PART_SIZE = 1024
            bundle = packager.package('fixture', [(source, '.local-data/models/fixture.bin')], parts)
            self.assertGreater(len(bundle['parts']), 1)
            self.assertTrue(all(p['bytes'] <= 1024 for p in bundle['parts']))
            destination = root / 'new computer with spaces'
            destination.mkdir()
            installer.install(bundle, {}, destination, parts, offline=True)
            self.assertEqual((destination / '.local-data/models/fixture.bin').read_bytes(), source.read_bytes())
            installer.install(bundle, {}, destination, parts, verify_only=True)
            (destination / '.local-data/models/fixture.bin').write_bytes(b'preserve this user file')
            with self.assertRaises(RuntimeError):
                installer.install(bundle, {}, destination, parts, offline=True)
            self.assertEqual((destination / '.local-data/models/fixture.bin').read_bytes(), b'preserve this user file')

    def test_unsafe_paths_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for value in ['../outside', 'a/../../outside', '/outside', 'C:/outside', 'a\\..\\..\\outside']:
                with self.subTest(value=value), self.assertRaises(ValueError):
                    installer.contained(Path(directory), value)

    def test_corrupt_offline_part_never_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'bad.part001'
            path.write_bytes(b'corrupt')
            bundle = {'id': 'bad', 'files': [{'path': 'file.bin', 'bytes': 8, 'sha256': '0' * 64}],
                      'parts': [{'name': path.name, 'bytes': 7, 'sha256': '0' * 64}]}
            with self.assertRaises(RuntimeError):
                installer.install(bundle, {}, root, root, offline=True)
            self.assertFalse((root / 'file.bin').exists())


if __name__ == '__main__':
    unittest.main()
