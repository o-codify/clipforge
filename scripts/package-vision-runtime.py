"""Build-time only: package the pinned official CPU runtime, without GPU libraries."""
import hashlib
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

VERSION = '0.35.0'
SHA256 = '1c114a6b220c5efca2ef2b1e5f01d1e535e26f6cd6d1678c8489325d2835e525'
archive = pathlib.Path('/tmp/ollama.tar.zst')
urllib.request.urlretrieve(f'https://github.com/ollama/ollama/releases/download/v{VERSION}/ollama-linux-amd64.tar.zst', archive)
with archive.open('rb') as source:
    if hashlib.file_digest(source, 'sha256').hexdigest() != SHA256:
        raise RuntimeError('Ollama archive checksum mismatch')
root = pathlib.Path('/vision')
with subprocess.Popen(['zstd', '-dc', str(archive)], stdout=subprocess.PIPE) as process:
    with tarfile.open(fileobj=process.stdout, mode='r|') as contents:
        for member in contents:
            name = pathlib.PurePosixPath(member.name.removeprefix('./'))
            selected = name == pathlib.PurePosixPath('bin/ollama') or (
                name.parent == pathlib.PurePosixPath('lib/ollama') and
                (name.name.startswith(('libggml', 'libmtmd')) or name.name == 'ollama'))
            if not selected or not member.isfile():
                continue
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with contents.extractfile(member) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755)
            print(name, member.size, flush=True)
    if process.wait() != 0:
        raise RuntimeError('Ollama archive extraction failed')
if not (root / 'bin/ollama').is_file() or not list((root / 'lib/ollama').glob('libggml-cpu*')):
    raise RuntimeError('CPU runtime missing from official archive')
archive.unlink()
