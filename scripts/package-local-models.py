"""Create checksummed, split ZIP assets without loading any model.

All bundles are stored without compression. Each part is below GitHub's 2 GiB
asset limit. The manifest is consumed by install-local-models.py.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PART_SIZE = 1_500_000_000


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


class SplitWriter:
    def __init__(self, folder, name):
        self.folder, self.name = folder, name
        self.position = self.part_bytes = 0
        self.parts = []
        self.stream = None
        self.digest = None

    def tell(self):
        return self.position

    def seek(self, *args):
        raise OSError('stream is not seekable')

    def flush(self):
        if self.stream:
            self.stream.flush()

    def finish_part(self):
        if self.stream:
            self.stream.close()
            self.parts.append({'name': self.part_path.name, 'bytes': self.part_bytes,
                               'sha256': self.digest.hexdigest()})
            self.stream = None

    def write(self, data):
        original_size = len(data)
        data = memoryview(data)
        while data:
            if self.stream is None:
                self.part_path = self.folder / f'{self.name}.zip.part{len(self.parts) + 1:03d}'
                self.stream = self.part_path.open('wb')
                self.digest, self.part_bytes = hashlib.sha256(), 0
            n = min(len(data), PART_SIZE - self.part_bytes)
            block = data[:n]
            self.stream.write(block)
            self.digest.update(block)
            self.position += n
            self.part_bytes += n
            data = data[n:]
            if self.part_bytes == PART_SIZE:
                self.finish_part()
        return original_size


def package(name, sources, output):
    writer = SplitWriter(output, name)
    files = []
    with zipfile.ZipFile(writer, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
        for path, relative in sources:
            digest = hashlib.sha256()
            info = zipfile.ZipInfo(relative)
            info.create_system = 0  # Match the original Windows archive on Linux runners.
            with archive.open(info, 'w', force_zip64=True) as target, path.open('rb') as source:
                for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
                    target.write(block)
                    digest.update(block)
            files.append({'path': relative, 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()})
    writer.finish_part()
    print(f'{name}: {len(files)} files, {writer.position:,} bytes, {len(writer.parts)} parts', flush=True)
    return {'id': name, 'archiveBytes': writer.position, 'parts': writer.parts, 'files': files}


def tree(folder):
    return [(p, p.relative_to(ROOT).as_posix()) for p in sorted(folder.rglob('*'))
            if p.is_file() and not p.name.endswith(('.partial', '.pyc')) and '__pycache__' not in p.parts]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tag', default='local-bundle-20260929')
    parser.add_argument('--bundles', nargs='+', default=['all'])
    parser.add_argument('--verify-manifest', action='store_true')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    models = ROOT / '.local-data/models'
    plans = [
        ('bonsai', [(models / name, f'.local-data/models/{name}') for name in
                    ['Ternary-Bonsai-2-27B-PTQ1_0.gguf', 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf']]),
        ('image', tree(models / 'Qwen-Image-2.1-3GB')),
        ('naive', tree(models / 'Naive-N0.5-Flash-int4-48L-1E')),
        ('muse', tree(models / 'Muse-Glimmer-30B-Q1_0')),
        ('bonsai-runtime', [(ROOT / '.local-runtime/bonsai' / name,
                             f'.local-runtime/bonsai/{name}') for name in ['llama-cuda-12.4.zip', 'cudart-12.4.zip']]),
    ]
    bundles = []
    for name, sources in plans:
        if 'all' not in args.bundles and name not in args.bundles:
            continue
        if not sources:
            raise RuntimeError(f'Missing files for {name}')
        for source, _ in sources:
            if not source.is_file():
                raise FileNotFoundError(source)
        # Notices and licenses accompany every independently downloadable model.
        for extra in sorted((ROOT / 'model-licenses' / name).glob('*')):
            if extra.is_file():
                sources.append((extra, f'model-licenses/{name}/{extra.name}'))
        bundles.append(package(name, sources, args.output))
    manifest = {'schemaVersion': 1, 'repository': 'williamtomallory-lgtm/lumaflow-sales-hub',
                'tag': args.tag, 'partSizeLimit': PART_SIZE, 'bundles': bundles}
    destination = ROOT / 'config/local-model-bundle.json'
    if args.verify_manifest:
        expected = json.loads(destination.read_text(encoding='utf-8'))
        for bundle in bundles:
            pinned = next(b for b in expected['bundles'] if b['id'] == bundle['id'])
            if bundle != pinned:
                raise RuntimeError(f"Reproduced bundle differs from pinned manifest: {bundle['id']}")
        (args.output / destination.name).write_bytes(destination.read_bytes())
        print('Reproduced bundles match every pinned hash.', flush=True)
        return
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    (args.output / destination.name).write_bytes(destination.read_bytes())


if __name__ == '__main__':
    main()
