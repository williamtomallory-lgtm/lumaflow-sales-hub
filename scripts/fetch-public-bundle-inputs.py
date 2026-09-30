"""Reproduce public-source bundles on a release runner, without inference."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PRISM = 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10683-d8f26ee/'
SOURCES = {
    '.local-data/models/Ternary-Bonsai-2-27B-PTQ1_0.gguf': 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    '.local-data/models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf': 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/6ed5e12bf84b7a63069882c91dd9e9218647d17b/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    '.local-data/models/Muse-Glimmer-30B-Q1_0/Muse-Glimmer-30B-Q1_0.gguf': 'https://huggingface.co/NANI-Nithin/Muse-Glimmer-30B-GGUF/resolve/41bbbd5e5a815ad2274f9a123b80777eb462c8d2/Muse-Glimmer-30B-Q1_0.gguf',
    '.local-runtime/bonsai/llama-cuda-12.4.zip': PRISM + 'llama-prism-b10683-d8f26ee-bin-win-cuda-12.4-x64.zip',
    '.local-runtime/bonsai/cudart-12.4.zip': PRISM + 'cudart-llama-bin-win-cuda-12.4-x64.zip',
}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--bundles', nargs='+', default=['bonsai', 'muse', 'bonsai-runtime'])
    args = p.parse_args()
    manifest = json.loads((ROOT / 'config/local-model-bundle.json').read_text())
    for bundle in manifest['bundles']:
        if bundle['id'] not in args.bundles:
            continue
        for record in bundle['files']:
            url = SOURCES.get(record['path'])
            if not url:
                # Git normalizes NOTICE newlines. Reproduce the original Windows
                # bytes only when their exact checksum matches the pinned record.
                local = ROOT / record['path']
                content = local.read_bytes()
                if hashlib.sha256(content).hexdigest() != record['sha256']:
                    windows = content.replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
                    if hashlib.sha256(windows).hexdigest() != record['sha256']:
                        raise RuntimeError(f'License/notice mismatch: {local.name}')
                    local.write_bytes(windows)
                continue  # Licenses and notices are already in the checkout.
            path = ROOT / record['path']
            path.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with urllib.request.urlopen(url, timeout=120) as response, path.open('wb') as target:
                for block in iter(lambda: response.read(8 * 1024 * 1024), b''):
                    target.write(block)
                    digest.update(block)
            if path.stat().st_size != record['bytes'] or digest.hexdigest() != record['sha256']:
                raise RuntimeError(f'Public source checksum mismatch: {path.name}')
            print(f'Public source verified: {path.name}', flush=True)


if __name__ == '__main__':
    main()
