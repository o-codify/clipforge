import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('vision_setup', Path(__file__).with_name('setup-vision-model.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class ModelInstallationTest(unittest.TestCase):
    def fixture(self, payload):
        digest = 'sha256:' + hashlib.sha256(payload).hexdigest()
        blob = {'digest': digest, 'size': len(payload)}
        return digest, json.dumps({'config': blob, 'layers': [blob]})

    def test_verified_cache_needs_no_network(self):
        data = b'model'; digest, manifest = self.fixture(data)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'blobs').mkdir()
            (root / 'blobs' / digest.replace(':', '-')).write_bytes(data)
            with patch.object(Path, 'read_text', return_value=manifest), patch.object(setup.urllib.request, 'urlopen') as request:
                setup.install(root, 10000)
                request.assert_not_called()
            self.assertTrue((root / 'manifests/registry.ollama.ai/library/qwen3-vl/2b-instruct').is_file())

    def test_corrupt_download_never_publishes_manifest(self):
        digest, manifest = self.fixture(b'valid')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(Path, 'read_text', return_value=manifest), patch.object(setup.urllib.request, 'urlopen', return_value=io.BytesIO(b'wrong')):
                with self.assertRaisesRegex(RuntimeError, 'checksum'):
                    setup.install(root, 10000)
            self.assertFalse((root / 'blobs' / digest.replace(':', '-')).exists())
            self.assertFalse((root / 'manifests').exists())

if __name__ == '__main__':
    unittest.main()
