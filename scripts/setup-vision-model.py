"""Install pinned vision weights on first visual review, at the worker's network cap."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.request

def install(root, kbps):
    manifest_text = Path(__file__).with_name('vision-model.json').read_text(encoding='utf-8')
    manifest = json.loads(manifest_text)
    (root / 'blobs').mkdir(parents=True, exist_ok=True)
    seen = set()
    for blob in [manifest['config'], *manifest['layers']]:
        digest, size = blob['digest'], blob['size']
        if digest in seen:
            continue
        seen.add(digest)
        target = root / 'blobs' / digest.replace(':', '-')
        if target.is_file() and target.stat().st_size == size:
            with target.open('rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() == digest.split(':')[1]:
                    continue
        pending = target.with_suffix('.part')
        print('Installing vision model component:', size, 'bytes', flush=True)
        started, count, sha = time.monotonic(), 0, hashlib.sha256()
        request = urllib.request.Request(f'https://registry.ollama.ai/v2/library/qwen3-vl/blobs/{digest}', headers={'User-Agent': 'ClipForge-worker-setup'})
        with urllib.request.urlopen(request, timeout=60) as source, pending.open('wb') as output:
            while chunk := source.read(16384):
                count += len(chunk)
                if count > size:
                    raise RuntimeError('Unexpected vision model size')
                sha.update(chunk)
                output.write(chunk)
                time.sleep(max(0, count / (kbps * 125) - (time.monotonic() - started)))
        if count != size or sha.hexdigest() != digest.split(':')[1]:
            raise RuntimeError('Vision model checksum mismatch')
        os.replace(pending, target)
    target = root / 'manifests/registry.ollama.ai/library/qwen3-vl/4b-instruct'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(manifest_text, encoding='utf-8')
    print('Vision model verified', flush=True)

if __name__ == '__main__':
    install(Path(sys.argv[1]), max(100, int(sys.argv[2])))
