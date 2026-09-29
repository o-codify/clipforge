import json
from contextlib import nullcontext
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
from clipforge_worker.ad_profile import profile_ads, source_info, validate_vision, covered_by, persistent_regions, SAMPLES
from clipforge_worker.__main__ import op_prepare_media


class Reporter:
    def progress(self, *_): pass


class AdProfileTest(unittest.TestCase):
    def source(self, root):
        file = root/'source.avi'
        writer = cv2.VideoWriter(str(file),cv2.VideoWriter_fourcc(*'MJPG'),10,(640,360))
        for i in range(60):
            frame=np.full((360,640,3),20+i,np.uint8)
            # An overlay visible only later must still cover every derived clip.
            if i>25:cv2.rectangle(frame,(400,20),(600,100),(20,160,250),-1)
            writer.write(frame)
        writer.release()
        return file

    def test_source_map_reused_and_applied_to_earlier_clips(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);video=self.source(root)
            answers=[{'uncertain':False,'regions':[]} for _ in range(SAMPLES)]
            answers[-1]={'uncertain':False,'regions':[{'label':'Sponsor banner','box':[625,55,937,278]}]}
            answers[-2]=answers[-1]
            with patch('clipforge_worker.ad_profile.vision_server',return_value=nullcontext(1)),patch('clipforge_worker.ad_profile.analyze_frame',side_effect=answers) as ai,patch('clipforge_worker.ad_profile.detect_frame',return_value={'regions':[],'kinds':[],'evidence':[]}),patch('clipforge_worker.ad_profile.verify_region',return_value='ad') as reviewer:
                result=profile_ads(str(video),root/'ads')
                self.assertEqual(ai.call_count,SAMPLES)
                self.assertEqual(reviewer.call_count,1)
                self.assertEqual(len(result['regions']),1)
                self.assertEqual(profile_ads(str(video),root/'ads',result),result)
                self.assertEqual(ai.call_count,SAMPLES)
                # Rebuild from per-frame checkpoints after DB commit failure.
                self.assertEqual(profile_ads(str(video),root/'ads')['regions'],result['regions'])
                self.assertEqual(ai.call_count,SAMPLES)
                self.assertEqual(reviewer.call_count,1)
            with patch('clipforge_worker.ads.scan_ads',return_value={'reject':False}) as scanner:
                prepared=op_prepare_media(dict(video=str(video),start=0,end=1,adProfile=result),Reporter())
                self.assertEqual(scanner.call_args.args[-1],result['regions'])
                self.assertTrue(scanner.call_args.kwargs['verified_profile'])
                self.assertTrue(prepared['ads']['automatic'])
                self.assertFalse(prepared['ads']['requiresReview'])
                self.assertEqual(prepared['audio'],{'method':'original'})
            result['signature']='wrong-source'
            with self.assertRaisesRegex(ValueError,'исходнику'):
                op_prepare_media(dict(video=str(video),start=0,end=1,adProfile=result),Reporter())

    def test_uncertain_or_broken_vision_never_marks_source_clean(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);video=self.source(root)
            with patch('clipforge_worker.ad_profile.vision_server',return_value=nullcontext(1)),patch('clipforge_worker.ad_profile.analyze_frame',return_value={'uncertain':True,'regions':[]}),patch('clipforge_worker.ad_profile.detect_frame',return_value={'regions':[],'kinds':[],'evidence':[]}):
                with self.assertRaisesRegex(ValueError,'отложена'):profile_ads(str(video),root/'ads')
            self.assertFalse(list(root.rglob('profile.json')))
        for bad in [{},{'uncertain':False,'regions':[{'label':'ad','box':[900,10,100,20]}]}, {'uncertain':False,'regions':[{'label':'ad','box':[0,0,1001,20]}]}]:
            with self.assertRaises(ValueError):validate_vision(bad)

    def test_source_replacement_invalidates_profile(self):
        with tempfile.TemporaryDirectory() as d:
            video=self.source(Path(d));before=source_info(video)
            with video.open('ab') as stream:stream.write(b'changed')
            self.assertNotEqual(source_info(video)['signature'],before['signature'])

    def test_closeup_rejects_chat_before_merging_with_banner(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);video=self.source(root)
            answers=[{'uncertain':False,'regions':[]} for _ in range(SAMPLES)]
            answers[0]={'uncertain':False,'regions':[
                {'label':'banner','box':[625,55,937,278]},
                {'label':'possible promo','box':[625,280,937,780]}]}
            answers[1]={'uncertain':False,'regions':[answers[0]['regions'][0]]}
            with patch('clipforge_worker.ad_profile.vision_server',return_value=nullcontext(1)),patch('clipforge_worker.ad_profile.analyze_frame',side_effect=answers),patch('clipforge_worker.ad_profile.detect_frame',return_value={'regions':[],'kinds':[],'evidence':[]}),patch('clipforge_worker.ad_profile.verify_region',side_effect=['ad','chat']):
                result=profile_ads(str(video),root/'ads')
            self.assertEqual(len(result['regions']),1)
            self.assertLess(result['regions'][0]['y']+result['regions'][0]['h'],120)
            self.assertEqual(result['evidence'][0]['verified'][1]['kind'],'chat')

    def test_known_mask_cannot_expand_into_adjacent_content(self):
        masks=[dict(x=100,y=20,w=120,h=80)]
        self.assertTrue(covered_by(dict(x=110,y=25,w=100,h=70),masks))
        self.assertFalse(covered_by(dict(x=110,y=25,w=100,h=76),masks))
        self.assertFalse(covered_by(dict(x=90,y=20,w=120,h=80),masks))

    def test_repeated_banner_requires_only_one_closeup(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);video=self.source(root)
            answer={'uncertain':False,'regions':[{'label':'banner','box':[625,55,937,278]}]}
            with patch('clipforge_worker.ad_profile.vision_server',return_value=nullcontext(1)),patch('clipforge_worker.ad_profile.analyze_frame',return_value=answer),patch('clipforge_worker.ad_profile.detect_frame',return_value={'regions':[],'kinds':[],'evidence':[]}),patch('clipforge_worker.ad_profile.verify_region',return_value='ad') as reviewer:
                result=profile_ads(str(video),root/'ads')
            self.assertEqual(reviewer.call_count,1)
            self.assertTrue(result['evidence'][1]['verified'][0]['reused'])

    def test_profile_keeps_qr_scan_without_keyword_only_banner_masks(self):
        from clipforge_worker.ads import scan_ads
        with tempfile.TemporaryDirectory() as d:
            video=self.source(Path(d))
            with patch('clipforge_worker.ads.detect_frame',return_value={'regions':[],'kinds':[],'evidence':[]}) as detector:
                result=scan_ads(str(video),0,1,verified_profile=True)
            self.assertEqual(detector.call_count,4)
            self.assertTrue(all(call.kwargs['ocr'] is False for call in detector.call_args_list))
            self.assertEqual(result['ocrFps'],0)

    def test_single_frame_donation_is_not_a_full_stream_mask(self):
        banner=dict(x=520,y=20,w=110,h=60)
        donation=dict(x=250,y=100,w=150,h=40)
        frame=lambda regions,kinds=[]:dict(verified=[{'region':r,'kind':'ad'} for r in regions],detected={'regions':regions,'kinds':kinds})
        evidence=[frame([banner,donation,donation]),frame([banner])]
        self.assertEqual(persistent_regions(evidence),[banner])
        self.assertEqual(persistent_regions([frame([donation],['qr'])]),[donation])


if __name__=='__main__':unittest.main()
