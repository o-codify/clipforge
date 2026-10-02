import hashlib
from pathlib import Path
import tempfile
import unittest
from clipforge_worker.ad_profile import reviewed_regions

class VisualReview(unittest.TestCase):
    def test_exact_frames_are_required_and_boxes_stay_inside_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            times = list(range(12))
            for i in times:
                (root / f'{i:02}.jpg').write_bytes(f'frame-{i}'.encode())
            info = dict(signature='source', width=1280, height=720)
            review = {**info, 'method':'assistant-visual-review',
                'frames':[dict(at=i,sha256=hashlib.sha256((root/f'{i:02}.jpg').read_bytes()).hexdigest()) for i in times],
                'regions':[dict(x=10,y=470,w=210,h=70)]}
            regions, coverage = reviewed_regions(review, info, root, times)
            self.assertEqual(regions, review['regions'])
            self.assertLess(coverage, .03)
            with self.assertRaisesRegex(ValueError, 'другому исходнику'):
                reviewed_regions({**review, 'signature':'different'}, info, root, times)
            with self.assertRaisesRegex(ValueError, 'вне кадра'):
                reviewed_regions({**review, 'regions':[dict(x=1200,y=0,w=100,h=20)]}, info, root, times)
            (root/'03.jpg').write_bytes(b'changed frame')
            with self.assertRaisesRegex(ValueError, 'не совпадают'):
                reviewed_regions(review, info, root, times)

if __name__ == '__main__':
    unittest.main()
