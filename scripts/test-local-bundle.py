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
qwen_installer = module('install-qwen-image-gguf.py')


class BundleTests(unittest.TestCase):
    def test_qwen_image_uses_the_separate_gguf_manifest(self):
        root = Path(__file__).resolve().parents[1]
        local_manifest = json.loads((root / 'config/local-model-bundle.json').read_text(encoding='utf-8'))
        gguf_manifest = json.loads((root / 'config/qwen-image-gguf-manifest.json').read_text(encoding='utf-8'))
        self.assertNotIn('image', {bundle['id'] for bundle in local_manifest['bundles']})
        self.assertEqual(gguf_manifest['quantization'], 'gguf-q4_k')
        self.assertEqual(len(gguf_manifest['files']), 4)
        self.assertEqual(len(gguf_manifest['archives']), 2)
        self.assertEqual(qwen_installer.load_manifest(root / 'config/qwen-image-gguf-manifest.json')['model'], 'Qwen/Qwen-Image-2.1')

    def test_qwen_runtime_extracts_only_safe_members_and_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            safe = root / 'safe.zip'
            with zipfile.ZipFile(safe, 'w') as archive:
                archive.writestr('release/bin/sd-cli.exe', b'cli')
                archive.writestr('release/bin/README.md', b'readme')
                archive.writestr('release/bin/ignored.json', b'ignored')
            runtime = {'extractTo': '.local-runtime/qwen-image/bin', 'flatten': True,
                       'includeExtensions': ['.exe', '.dll', '.txt', '.md']}
            qwen_installer.extract_runtime(safe, root, runtime, verify_only=False)
            self.assertEqual((root / '.local-runtime/qwen-image/bin/sd-cli.exe').read_bytes(), b'cli')
            self.assertFalse((root / '.local-runtime/qwen-image/bin/ignored.json').exists())

            unsafe = root / 'unsafe.zip'
            with zipfile.ZipFile(unsafe, 'w') as archive:
                archive.writestr('../outside.dll', b'escape')
            with self.assertRaises(ValueError):
                qwen_installer.extract_runtime(unsafe, root, runtime, verify_only=True)

    def test_qwen_installer_verifies_a_custom_root_without_starting_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cache = root / 'cache'
            model_path = root / '.local-data/models/image.gguf'
            model_path.parent.mkdir(parents=True)
            model_path.write_bytes(b'gguf-fixture')
            archive = cache / 'runtime.zip'
            archive.parent.mkdir(parents=True)
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr('bin/sd-cli.exe', b'cli-fixture')
            digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
            manifest = {
                'schemaVersion': 1,
                'model': 'Qwen/Qwen-Image-2.1',
                'files': [{'path': '.local-data/models/image.gguf', 'bytes': model_path.stat().st_size, 'sha256': digest(model_path), 'url': 'https://example.invalid/image.gguf'}],
                'archives': [{'name': 'runtime.zip', 'bytes': archive.stat().st_size, 'sha256': digest(archive), 'url': 'https://example.invalid/runtime.zip'}],
                'runtime': {'extractTo': '.local-runtime/qwen-image/bin', 'flatten': True, 'includeExtensions': ['.exe'], 'required': ['.local-runtime/qwen-image/bin/sd-cli.exe']},
                'required': ['.local-data/models/image.gguf'],
            }
            manifest_path = root / 'manifest.json'
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            qwen_installer.install(root, manifest_path, cache, offline=True)
            self.assertEqual((root / '.local-runtime/qwen-image/bin/sd-cli.exe').read_bytes(), b'cli-fixture')

    def test_qwen_download_resumes_range_and_verifies_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / 'asset.gguf'
            target.with_name(target.name + '.part').write_bytes(b'abc')
            content = b'abcdef'
            record = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(), 'url': 'https://example.invalid/asset.gguf'}

            class Response:
                status = 206
                headers = {'Content-Range': 'bytes 3-5/6'}

                def getcode(self):
                    return self.status

                def read(self, size=-1):
                    value, self._sent = content[3:], True
                    if getattr(self, '_sent_before', False):
                        return b''
                    self._sent_before = True
                    return value

                def __enter__(self):
                    return self

                def __exit__(self, *_args):
                    return False

            original = qwen_installer.urllib.request.urlopen
            qwen_installer.urllib.request.urlopen = lambda request, timeout=0: Response()
            try:
                qwen_installer.download(record, target, offline=False, verify_only=False)
            finally:
                qwen_installer.urllib.request.urlopen = original
            self.assertEqual(target.read_bytes(), content)

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
