import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from io import BytesIO

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('container_resources', ROOT / 'scripts/container-resources.py')
resources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resources)


class ContainerResources(unittest.TestCase):
    def test_cgroup_allocation_not_host_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'memory.max').write_text(str(8*1024**3))
            (root/'cpu.max').write_text('150000 100000')
            self.assertEqual(resources.limits(directory, 32*1024**3, 16), (8*1024**3, 1.5))
            (root/'memory.max').unlink(); (root/'cpu.max').unlink()
            (root/'memory').mkdir(); (root/'cpu').mkdir()
            (root/'memory/memory.limit_in_bytes').write_text(str(4*1024**3))
            (root/'cpu/cpu.cfs_quota_us').write_text('200000')
            (root/'cpu/cpu.cfs_period_us').write_text('100000')
            self.assertEqual(resources.limits(directory, 32*1024**3, 16), (4*1024**3, 2))

    def test_other_work_reclaims_cpu_immediately(self):
        self.assertAlmostEqual(resources.cpu_allowance(4, 8, 0, 0), 3.6)
        self.assertAlmostEqual(resources.cpu_allowance(4, 8, 90, 1), 1)
        self.assertEqual(resources.cpu_allowance(4, 8, 100, 0), 0)

    def test_cache_is_reclaimable_but_host_reserve_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'memory.current').write_text(str(7*1024**3))
            (root/'memory.stat').write_text('inactive_file '+str(2*1024**3))
            free=resources.memory_available(8*1024**3, 4*1024**3, directory, 32*1024**3)
            self.assertAlmostEqual(free, 1.6*1024**3, delta=1)

    def test_model_resume_uses_persisted_revision_and_checks_length(self):
        from clipforge_worker.model_cache import provision_model
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'speech/tiny';target.mkdir(parents=True)
            (target/'.manifest.json').write_text(json.dumps({'sha':'pinned','siblings':[
                {'rfilename':'config.json','size':2},{'rfilename':'model.bin','size':6},{'rfilename':'tokenizer.json','size':2}]}))
            (target/'config.json').write_text('{}');(target/'tokenizer.json').write_text('{}')
            (target/'model.bin.part').write_bytes(b'abc')
            response=BytesIO(b'def');response.status=206;response.headers={'Content-Length':'3','Content-Range':'bytes 3-5/6'}
            def open_url(request, **kwargs):
                self.assertIn('/pinned/model.bin',request.full_url)
                self.assertEqual(request.headers['Range'],'bytes=3-')
                return response
            with patch.dict('os.environ',{'MODELS_ROOT':directory,'MEDIA_RESOURCE_STATE':''}),patch('urllib.request.urlopen',open_url),patch('time.sleep'):
                self.assertEqual(provision_model('tiny'),str(target))
                self.assertEqual((target/'model.bin').read_bytes(),b'abcdef')

    def test_complete_partial_survives_interrupted_rename_without_network(self):
        import hashlib
        from clipforge_worker.model_cache import provision_model
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'speech/tiny';target.mkdir(parents=True)
            (target/'.manifest.json').write_text(json.dumps({'sha':'pinned','siblings':[
                {'rfilename':'config.json','size':2},
                {'rfilename':'model.bin','size':6,'lfs':{'sha256':hashlib.sha256(b'abcdef').hexdigest()}},
                {'rfilename':'tokenizer.json','size':2}]}))
            (target/'config.json').write_text('{}');(target/'tokenizer.json').write_text('{}')
            (target/'model.bin.part').write_bytes(b'abcdef')
            with patch.dict('os.environ',{'MODELS_ROOT':directory}),patch('urllib.request.urlopen',side_effect=AssertionError('No network expected')):
                provision_model('tiny')
                self.assertEqual((target/'model.bin').read_bytes(),b'abcdef')


if __name__ == '__main__':
    unittest.main()
