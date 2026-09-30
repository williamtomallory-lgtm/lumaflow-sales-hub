"""Download and verify release weights; never import Torch or run inference."""
from __future__ import annotations
import argparse
import json
import shutil
import subprocess
import urllib.parse
from pathlib import Path
import zipfile
from importlib.util import spec_from_file_location, module_from_spec

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('bundle_packager', Path(__file__).with_name('package-local-models.py'))
packager = module_from_spec(spec)
spec.loader.exec_module(packager)


def contained(root, relative):
    relative = str(relative).replace('\\', '/')
    if relative.startswith('/') or ':' in relative or '..' in Path(relative).parts:
        raise ValueError(f'Unsafe bundle path: {relative}')
    target = (root / relative).resolve()
    if not target.is_relative_to(root.resolve()):
        raise ValueError('Bundle path escapes installation root')
    return target


def file_matches(path, record):
    return path.is_file() and path.stat().st_size == record['bytes'] and packager.sha256(path) == record['sha256']


def install(bundle, manifest, root, cache, offline=False, verify_only=False):
    files = bundle['files']
    if all(file_matches(contained(root, f['path']), f) for f in files):
        print(f"Verified installed bundle: {bundle['id']}", flush=True)
        return
    if verify_only:
        raise RuntimeError(f"Missing or corrupt bundle: {bundle['id']}")
    assembled = cache / (bundle['id'] + '.zip.partial')
    for part in bundle['parts']:
        path = contained(cache, part['name'])
        if not file_matches(path, part):
            if offline:
                raise RuntimeError(f"Offline part missing/corrupt: {part['name']}")
            partial = path.with_suffix(path.suffix + '.partial')
            # Resume incomplete downloads; exact size and hash are checked before use.
            url = f"https://github.com/{manifest['repository']}/releases/download/{manifest['tag']}/{urllib.parse.quote(part['name'])}"
            subprocess.run(['curl.exe' if __import__('os').name == 'nt' else 'curl',
                            '--fail', '--location', '--retry', '3', '--continue-at', '-',
                            '--output', str(partial), url], check=True)
            if not file_matches(partial, part):
                raise RuntimeError(f"Downloaded part failed checksum: {part['name']}")
            partial.replace(path)
    with assembled.open('wb') as target:
        for part in bundle['parts']:
            with contained(cache, part['name']).open('rb') as source:
                shutil.copyfileobj(source, target, 8 * 1024 * 1024)
    expected = {f['path']: f for f in files}
    with zipfile.ZipFile(assembled) as archive:
        members = archive.infolist()
        if len(members) != len(expected) or len({m.filename for m in members}) != len(members):
            raise RuntimeError('Unexpected/duplicate archive members')
        for member in members:
            if member.filename not in expected or member.file_size != expected[member.filename]['bytes']:
                raise RuntimeError('Archive differs from pinned manifest')
            target = contained(root, member.filename)
            if target.exists():
                if file_matches(target, expected[member.filename]):
                    continue
                raise RuntimeError(f'Existing file differs; it was not overwritten: {target}')
            target.parent.mkdir(parents=True, exist_ok=True)
            pending = target.with_name(target.name + '.installing')
            with archive.open(member) as source, pending.open('wb') as dest:
                shutil.copyfileobj(source, dest, 8 * 1024 * 1024)
            if not file_matches(pending, expected[member.filename]):
                raise RuntimeError(f'Extracted file failed checksum: {member.filename}')
            pending.replace(target)
    assembled.unlink()
    print(f"Installed and verified: {bundle['id']} (model not started)", flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--models', nargs='+', choices=['all', 'bonsai', 'image', 'naive', 'muse', 'bonsai-runtime'], default=['all'])
    p.add_argument('--root', type=Path, default=ROOT)
    p.add_argument('--cache', type=Path)
    p.add_argument('--manifest', type=Path, default=ROOT / 'config/local-model-bundle.json')
    p.add_argument('--offline', action='store_true')
    p.add_argument('--verify-only', action='store_true')
    a = p.parse_args()
    manifest = json.loads(a.manifest.read_text(encoding='utf-8'))
    if manifest.get('schemaVersion') != 1:
        raise ValueError('Unsupported bundle manifest')
    cache = a.cache or a.root / '.local-data/downloads'
    cache.mkdir(parents=True, exist_ok=True)
    chosen = set(a.models)
    if 'bonsai' in chosen:
        chosen.add('bonsai-runtime')
    for bundle in manifest['bundles']:
        if 'all' in chosen or bundle['id'] in chosen:
            install(bundle, manifest, a.root.resolve(), cache.resolve(), a.offline, a.verify_only)


if __name__ == '__main__':
    main()
