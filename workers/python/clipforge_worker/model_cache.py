"""Lazy, paced model provisioning for self-contained Docker workers."""
import json
import hashlib
import os
from pathlib import Path
import time
import urllib.request


def provision_model(name):
    if Path(name).is_dir():
        return name
    if name not in ('tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large-v2', 'large-v3'):
        raise ValueError('For this speech model, mount its CTranslate2 directory and set SPEECH_MODEL to that path')
    target = Path(os.getenv('MODELS_ROOT', '/storage/models')) / 'speech' / name
    complete = target / '.complete'
    if complete.exists():
        return str(target)
    target.mkdir(parents=True, exist_ok=True)
    repo = 'Systran/faster-whisper-' + name
    manifest = target / '.manifest.json'
    if manifest.exists():
        info = json.loads(manifest.read_text())
    else:
        with urllib.request.urlopen('https://huggingface.co/api/models/' + repo + '?blobs=true', timeout=30) as response:
            info = json.load(response)
        temporary_manifest = manifest.with_suffix('.tmp')
        temporary_manifest.write_text(json.dumps(info)); temporary_manifest.replace(manifest)
    # Resume the same immutable revision even if the upstream default changes.
    revision = info['sha']
    allowed = {'config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json', 'vocabulary.txt', 'preprocessor_config.json'}
    files = [s['rfilename'] for s in info['siblings'] if s['rfilename'] in allowed]
    if not {'config.json', 'model.bin', 'tokenizer.json'} <= set(files):
        raise RuntimeError('Incomplete speech model repository')
    for file in files:
        metadata = next(s for s in info['siblings'] if s['rfilename'] == file)
        expected_size = metadata.get('size') or metadata.get('lfs', {}).get('size')
        expected_sha = metadata.get('lfs', {}).get('sha256')
        destination = target / file
        if destination.exists():
            continue
        temporary = destination.with_suffix(destination.suffix + '.part')
        offset = temporary.stat().st_size if temporary.exists() else 0
        # A crash can occur after the final write but before the atomic rename.
        # Verify that completed partial instead of requesting an invalid Range.
        if expected_size and offset >= expected_size:
            valid = offset == expected_size
            if valid and expected_sha:
                with temporary.open('rb') as source:
                    valid = hashlib.file_digest(source, 'sha256').hexdigest() == expected_sha
            if valid:
                temporary.replace(destination)
                continue
            temporary.unlink()
            offset = 0
        request = urllib.request.Request(f'https://huggingface.co/{repo}/resolve/{revision}/{file}', headers={'Range': f'bytes={offset}-'} if offset else {})
        with urllib.request.urlopen(request, timeout=30) as response:
            resume = offset and response.status == 206
            if resume and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                raise RuntimeError('Model server returned an invalid resume offset')
            received = 0
            length = response.headers.get('Content-Length')
            with temporary.open('ab' if resume else 'wb') as output:
                while True:
                    state = {}
                    state_file = os.getenv('MEDIA_RESOURCE_STATE')
                    if state_file:
                        try: state = json.loads(Path(state_file).read_text())
                        except (ValueError, OSError): state = {'paused': True}
                        if state.get('paused') or time.time()*1000-state.get('at', 0)>10000:
                            time.sleep(.5)
                            continue
                    started = time.monotonic()
                    chunk = response.read(64*1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    received += len(chunk)
                    speed = min(float(os.getenv('MEDIA_DOWNLOAD_KBPS', '10000')), state.get('downloadKbps', 10000))*125
                    time.sleep(max(0, len(chunk)/max(12500, speed)-(time.monotonic()-started)))
            if length and received != int(length):
                raise RuntimeError('Speech model download was interrupted')
        if expected_size and temporary.stat().st_size != expected_size:
            raise RuntimeError('Speech model size mismatch')
        if expected_sha:
            with temporary.open('rb') as source:
                if hashlib.file_digest(source, 'sha256').hexdigest() != expected_sha:
                    temporary.unlink()
                    raise RuntimeError('Speech model checksum mismatch')
        temporary.replace(destination)
    complete.write_text(revision)
    return str(target)
