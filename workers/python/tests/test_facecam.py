import unittest
from unittest.mock import patch
import numpy as np
from clipforge_worker.facecam import Rect, _dominant_cluster, valid_eye_landmarks, find_facecam

class CameraChecks(unittest.TestCase):
    def test_duplicate_faces_do_not_inflate_coverage(self):
        group, _ = _dominant_cluster([(Rect(10,10,40,50),.9,0)]*20)
        self.assertEqual(len(group),1)
    def test_mask_does_not_require_mouth_landmarks(self):
        self.assertTrue(valid_eye_landmarks([10,10,40,50,20,25,40,25,0,0,0,0,0,0,.9]))
    def test_impossible_eye_geometry_rejected(self):
        self.assertFalse(valid_eye_landmarks([10,10,40,50,20,25,21,25,0,0,0,0,0,0,.9]))
    def verify(self, frames, detections):
        with patch('clipforge_worker.facecam.grab_frames',return_value=frames), patch('clipforge_worker.facecam._detect_faces',return_value=detections):
            return find_facecam('fixture',samples=8,min_hit_ratio=1,start=0,end=4)
    def test_camera_missing_during_clip_disables_panel(self):
        frames=[np.zeros((240,320,3),dtype=np.uint8)]*8
        result=self.verify(frames,[(Rect(10,10,40,50),.9,i) for i in range(7)])
        self.assertFalse(result.found)
        self.assertIsNone(result.rect)
    def test_static_portrait_disables_panel(self):
        result=self.verify([np.zeros((240,320,3),dtype=np.uint8)]*8,[(Rect(10,10,40,50),.9,i) for i in range(8)])
        self.assertFalse(result.found)
    def test_consistent_moving_head_enables_panel(self):
        frames=[np.full((240,320,3),i*10,dtype=np.uint8) for i in range(8)]
        result=self.verify(frames,[(Rect(10+i,10,40,50),.9,i) for i in range(8)])
        self.assertTrue(result.found)
        self.assertEqual(result.hits,8)
    def test_scene_change_disables_panel(self):
        frames=[np.full((240,320,3),i*10,dtype=np.uint8) for i in range(8)]
        result=self.verify(frames,[(Rect(10 if i<4 else 230,10,40,50),.9,i) for i in range(8)])
        self.assertFalse(result.found)
    def test_incomplete_decode_does_not_offer_mistimed_safe_windows(self):
        frames=[np.full((240,320,3),i*5,dtype=np.uint8) for i in range(39)]
        detections=[(Rect(10,10,40,50),.9,i) for i in range(39)]
        with patch('clipforge_worker.facecam.grab_frames',return_value=frames), patch('clipforge_worker.facecam._detect_faces',return_value=detections):
            result=find_facecam('fixture',samples=40,min_hit_ratio=1,start=0,end=20)
        self.assertFalse(result.found)
        self.assertEqual(result.safe_windows,[])
if __name__=='__main__': unittest.main()
