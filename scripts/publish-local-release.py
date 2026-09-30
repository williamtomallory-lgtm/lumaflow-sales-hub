"""Upload verified bundle parts to a draft Release using existing Git credentials.

Credentials stay in memory. This script never runs a model or prints credentials.
Publishing is explicit (--publish) after all asset hashes have been checked.
"""
from __future__ import annotations
import argparse
import http.client
import json
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPOSITORY = 'williamtomallory-lgtm/lumaflow-sales-hub'


def credential():
    result = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                            capture_output=True, text=True, check=True)
    values = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    token = values.get('password')
    if not token:
        raise RuntimeError('Existing GitHub write credentials are unavailable')
    return token


def api(token, path, method='GET', payload=None):
    request = urllib.request.Request('https://api.github.com' + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method, headers={'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json', 'User-Agent': 'LumaFlow-release',
        'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read()
        return json.loads(data) if data else None


def upload(token, release, path):
    address = urllib.parse.urlsplit(release['upload_url'].split('{')[0] + '?name=' + urllib.parse.quote(path.name))
    connection = http.client.HTTPSConnection(address.hostname, timeout=120)
    connection.putrequest('POST', address.path + '?' + address.query)
    connection.putheader('Authorization', 'Bearer ' + token)
    connection.putheader('User-Agent', 'LumaFlow-release')
    connection.putheader('Content-Type', 'application/octet-stream')
    connection.putheader('Content-Length', str(path.stat().st_size))
    connection.endheaders()
    sent, last_report = 0, time.monotonic()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            connection.send(block)
            sent += len(block)
            if time.monotonic() - last_report > 25:
                print(f'{path.name}: uploaded {sent:,}/{path.stat().st_size:,} bytes', flush=True)
                last_report = time.monotonic()
    response = connection.getresponse()
    data = response.read()
    connection.close()
    if response.status not in (200, 201):
        raise RuntimeError(f'Asset upload failed: HTTP {response.status}')
    return json.loads(data)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--tag', default='local-bundle-20260929')
    p.add_argument('--target', default='main')
    p.add_argument('--publish', action='store_true')
    args = p.parse_args()
    token = credential()
    permissions = api(token, f'/repos/{REPOSITORY}').get('permissions', {})
    if not permissions.get('push'):
        raise RuntimeError('GitHub credential has no write permission')
    # The tag endpoint does not consistently return drafts; find drafts in the
    # authenticated list so resumptions never create a duplicate Release.
    release = next((r for r in api(token, f'/repos/{REPOSITORY}/releases?per_page=100')
                    if r['tag_name'] == args.tag), None)
    if release is None:
        release = api(token, f'/repos/{REPOSITORY}/releases', 'POST', {
            'tag_name': args.tag, 'target_commitish': args.target,
            'name': 'LumaFlow complete local bundle · 2026-09-29', 'draft': True,
            'body': (args.directory / 'release-notes.md').read_text(encoding='utf-8')})
    print(f"Release {release['id']} draft={release['draft']}", flush=True)
    manifest = json.loads((args.directory / 'local-model-bundle.json').read_text(encoding='utf-8'))
    records = [part for bundle in manifest['bundles'] for part in bundle['parts']]
    from importlib.util import spec_from_file_location, module_from_spec
    spec = spec_from_file_location('packager', Path(__file__).with_name('package-local-models.py'))
    packager = module_from_spec(spec)
    spec.loader.exec_module(packager)
    for name in ['local-model-bundle.json', 'release-notes.md']:
        path = args.directory / name
        records.append({'name': name, 'bytes': path.stat().st_size, 'sha256': packager.sha256(path)})
    assets = {x['name']: x for x in api(token, f"/repos/{REPOSITORY}/releases/{release['id']}/assets?per_page=100")}
    def publish_asset(record):
        path = args.directory / record['name']
        if path.stat().st_size != record['bytes'] or packager.sha256(path) != record['sha256']:
            raise RuntimeError(f"Local asset checksum mismatch: {record['name']}")
        expected_digest = 'sha256:' + record['sha256']
        existing = assets.get(record['name'])
        if existing and existing['size'] == record['bytes'] and existing.get('digest') == expected_digest:
            print(f"Remote checksum verified: {record['name']}", flush=True)
            return
        if existing and existing.get('state') != 'starter':
            raise RuntimeError(f"Existing remote asset differs; it was not overwritten: {record['name']}")
        for attempt in range(4):
            if existing:
                api(token, f"/repos/{REPOSITORY}/releases/assets/{existing['id']}", 'DELETE')
                existing = None
            try:
                result = upload(token, release, path)
                if result['size'] != record['bytes'] or result.get('digest') != expected_digest:
                    raise RuntimeError('Remote asset checksum did not match')
                print(f"Remote checksum verified: {record['name']}", flush=True)
                break
            except (OSError, RuntimeError) as exc:
                print(f"Upload retry {attempt + 1}: {record['name']} ({type(exc).__name__})", flush=True)
                refreshed = api(token, f"/repos/{REPOSITORY}/releases/{release['id']}/assets?per_page=100")
                existing = next((x for x in refreshed if x['name'] == record['name']), None)
                if existing and existing.get('digest') == expected_digest:
                    break
                if attempt == 3:
                    raise
                time.sleep(3)
    # Three independent asset streams; model files stay on disk, buffers are small.
    with ThreadPoolExecutor(max_workers=3) as executor:
        list(executor.map(publish_asset, records))
    if args.publish:
        api(token, f"/repos/{REPOSITORY}/releases/{release['id']}", 'PATCH', {
            'draft': False, 'target_commitish': args.target,
            'body': (args.directory / 'release-notes.md').read_text(encoding='utf-8')})
        print(f"Published: https://github.com/{REPOSITORY}/releases/tag/{args.tag}", flush=True)
    else:
        print('All assets uploaded and verified; release remains draft.', flush=True)


if __name__ == '__main__':
    main()
