import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import cv2
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from clipforge_worker.ads import detect_frame, scan_ads, merge_regions
from clipforge_worker.music import speech_gate, prevent_gain, clean_music, read_wav, write_wav, command
from clipforge_worker.__main__ import op_clean_clip, op_prepare_media


class Reporter:
    def progress(self, *_): pass


class ProtectionTest(unittest.TestCase):
    def test_disabled_ad_check_never_loads_detectors_or_claims_verification(self):
        with patch('clipforge_worker.ads.scan_ads',side_effect=AssertionError('Detector must not run')):
            result=op_prepare_media(dict(video='missing.mp4',start=0,end=10,adCheckEnabled=False),Reporter())
        self.assertFalse(result['ads']['enabled'])
        self.assertFalse(result['ads']['automatic'])
        self.assertEqual(result['ads']['regions'],[])
        self.assertEqual(result['ads']['frames'],0)
        self.assertEqual(result['audio'],{'method':'original'})

    def test_pause_gate_is_explicit_and_requires_alignment(self):
        with patch('clipforge_worker.music.clean_music',return_value={'method':'dtln','speechGated':True}) as clean:
            params=dict(video='source.mp4',start=4,end=20,audioMode='dtln-gated',models='models',audioOut='speech.wav',adCheckEnabled=False)
            with self.assertRaisesRegex(ValueError,'речи'):op_prepare_media(params,Reporter())
            params['speechSpans']=[[1,2]]
            self.assertTrue(op_prepare_media(params,Reporter())['audio']['speechGated'])
            clean.assert_called_once_with('source.mp4',4,20,'speech.wav','dtln','models',speech_spans=[[1,2]])

    def test_dtln_cannot_boost_quiet_windows_or_peak(self):
        rng=np.random.default_rng(17);rate=16000;hop=320
        source=rng.normal(0,.04,rate*2+17).astype(np.float32)
        source[hop:hop*2]=0
        enhanced=rng.normal(0,.4,len(source)).astype(np.float32)
        result=prevent_gain(source,enhanced,rate)
        for at in range(0,len(source),hop):
            before,after=source[at:at+hop],result[at:at+hop]
            self.assertLessEqual(float(np.mean(after**2)),float(np.mean(before**2))+1e-9)
            self.assertLessEqual(float(np.max(np.abs(after))),float(np.max(np.abs(before)))+1e-7)
        np.testing.assert_array_equal(prevent_gain(source,source,rate),source)

    def test_dtln_requires_explicit_selection_and_never_gates_speech_pauses(self):
        ads={'reject':False}
        with patch('clipforge_worker.ads.scan_ads',return_value=ads), patch('clipforge_worker.music.clean_music',return_value={'method':'dtln','file':'speech.wav'}) as clean:
            params=dict(video='source.mp4',start=4,end=20,audioMode='dtln',models='models',audioOut='speech.wav',speechSpans=[[1,2]])
            self.assertEqual(op_prepare_media(params,Reporter())['audio']['method'],'dtln')
            clean.assert_called_once_with('source.mp4',4,20,'speech.wav','dtln','models')
            del params['audioOut']
            with self.assertRaisesRegex(ValueError,'DTLN'):op_prepare_media(params,Reporter())

    def test_ad_masking_preserves_stereo_audio_even_with_legacy_cleanup_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'source.mp4';out=root/'masked.mp4';image=root/'frame.png'
            frame=np.full((720,1280,3),35,np.uint8)
            code=cv2.QRCodeEncoder_create().encode('https://example.org/fixture')
            code=cv2.copyMakeBorder(code,4,4,4,4,cv2.BORDER_CONSTANT,value=255)
            code=cv2.resize(code,(180,180),interpolation=cv2.INTER_NEAREST)
            frame[20:200,1050:1230]=cv2.cvtColor(code,cv2.COLOR_GRAY2BGR)
            cv2.rectangle(frame,(50,540),(610,665),(0,140,250),-1)
            cv2.putText(frame,'WINLINE',(80,590),cv2.FONT_HERSHEY_SIMPLEX,1.3,(0,0,0),3)
            cv2.putText(frame,'PROMOCODE TEST',(80,637),cv2.FONT_HERSHEY_SIMPLEX,.9,(0,0,0),2)
            cv2.imwrite(str(image),frame)
            # Distinct stereo signals throughout the clip, including speech gaps.
            command(['ffmpeg','-v','error','-y','-loop','1','-i',str(image),'-f','lavfi','-i',
                'aevalsrc=0.1*sin(2*PI*440*t)|0.1*sin(2*PI*880*t):s=48000:d=2',
                '-t','2','-r','15','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',str(source)])
            before=source.read_bytes()
            with patch('clipforge_worker.music.clean_music',side_effect=AssertionError('Audio cleanup must stay disabled')):
                result=op_clean_clip(dict(video=str(source),start=0,end=2,out=str(out),
                    method='dtln',speechSpans=[[.4,.7]],models='missing'),Reporter())
            self.assertEqual(result['audio'],{'method':'original'})
            self.assertEqual(len(result['ads']['regions']),2)
            def audio_hash(file,codec):
                return command(['ffmpeg','-v','error','-i',str(file),'-map','0:a:0','-c:a',codec,
                    '-f','hash','-hash','sha256','-']).stdout
            self.assertEqual(audio_hash(source,'copy'),audio_hash(out,'copy'))
            self.assertEqual(audio_hash(source,'pcm_s16le'),audio_hash(out,'pcm_s16le'))
            self.assertEqual(before,source.read_bytes())
            cap=cv2.VideoCapture(str(out));count=0
            try:
                while True:
                    ok,frame=cap.read()
                    if not ok:break
                    self.assertFalse(cv2.QRCodeDetector().detectMulti(frame)[0])
                    if count in (0,15):self.assertEqual(detect_frame(frame)['regions'],[])
                    count+=1
            finally:cap.release()
            self.assertEqual(count,30)

    def test_ad_masking_accepts_video_without_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'silent.mp4';out=root/'masked.mp4'
            command(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=320x180:r=15:d=1',
                '-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',str(source)])
            result=op_clean_clip(dict(video=str(source),start=0,end=1,out=str(out)),Reporter())
            self.assertEqual(result['ads']['regions'],[])
            probe=json.loads(command(['ffprobe','-v','error','-show_streams','-of','json',str(out)]).stdout)
            self.assertEqual([s['codec_type'] for s in probe['streams']],['video'])

    def test_qr_and_banner_removed_without_covering_unrelated_gameplay(self):
        image=np.full((720,1280,3),35,np.uint8)
        code=cv2.QRCodeEncoder_create().encode('https://example.org/advertising-fixture')
        code=cv2.copyMakeBorder(code,4,4,4,4,cv2.BORDER_CONSTANT,value=255)
        code=cv2.resize(code,(180,180),interpolation=cv2.INTER_NEAREST)
        image[20:200,1050:1230]=cv2.cvtColor(code,cv2.COLOR_GRAY2BGR)
        cv2.rectangle(image,(50,540),(610,665),(0,140,250),-1)
        cv2.putText(image,'WINLINE',(80,590),cv2.FONT_HERSHEY_SIMPLEX,1.3,(0,0,0),3)
        cv2.putText(image,'PROMOCODE TEST',(80,637),cv2.FONT_HERSHEY_SIMPLEX,.9,(0,0,0),2)
        detected=detect_frame(image)
        self.assertIn('qr',detected['kinds']); self.assertIn('banner',detected['kinds'])
        output=image.copy()
        for r in detected['regions']:
            output[r['y']:r['y']+r['h'],r['x']:r['x']+r['w']]=[24,22,30]
        self.assertFalse(cv2.QRCodeDetector().detectMulti(output)[0])
        self.assertNotIn('banner',detect_frame(output)['kinds'])
        self.assertTrue(np.array_equal(image[220:400,400:800],output[220:400,400:800]))
        target=Path(__file__).resolve().parents[3]/'data/reviews/media-protection'
        target.mkdir(parents=True,exist_ok=True)
        cv2.imwrite(str(target/'ads-fixture-before.png'),image);cv2.imwrite(str(target/'ads-fixture-after.png'),output)
        (target/'ads-fixture.json').write_text(json.dumps(detected),encoding='utf-8')

    def test_gameplay_terms_are_not_advertisements(self):
        image=np.full((360,640,3),30,np.uint8)
        cv2.putText(image,'EARTH SPIRIT',(30,100),cv2.FONT_HERSHEY_SIMPLEX,1,(255,255,255),2)
        cv2.putText(image,'DOTA 2  LEVEL 25',(30,180),cv2.FONT_HERSHEY_SIMPLEX,.8,(255,255,255),2)
        self.assertEqual(detect_frame(image)['regions'],[])

    def test_gate_keeps_words_and_mutes_music_between_phrases(self):
        audio=np.ones(48000*4,np.float32)
        result=speech_gate(audio,48000,[[1,2]])
        self.assertTrue(np.all(result[:40000]==0))
        self.assertTrue(np.all(result[48000:96000]==1))
        self.assertTrue(np.all(result[105000:]==0))
        self.assertLess(float(np.max(np.abs(np.diff(result)))),.01)

    def test_missing_model_fails_instead_of_silently_copying_original(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.wav';out=Path(directory)/'out.wav'
            write_wav(source,np.ones(16000,np.float32)*.1,16000)
            with self.assertRaisesRegex(RuntimeError,'не установлена'):
                clean_music(source,0,1,out,'deepfilter',Path(directory)/'missing')
            self.assertFalse(out.exists())
            result=clean_music(source,0,1,out,'mute')
            data,rate=read_wav(out)
            self.assertEqual(len(data),rate);self.assertTrue(np.all(data==0))


if __name__=='__main__':unittest.main()
