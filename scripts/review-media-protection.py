"""Build offline review artifacts from existing local clips, without a DB/job."""
import json
import hashlib
import os
from pathlib import Path
import sys
import time
import numpy as np
import cv2
import psutil
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'workers/python'))
from clipforge_worker.music import command
from clipforge_worker.ads import scan_ads,detect_frame
from clipforge_worker.__main__ import op_clean_clip

class Reporter:
    def progress(self,message,*args):print(message,flush=True)

def main():
    if os.name=='nt':psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    out=ROOT/'data/reviews/media-protection';out.mkdir(parents=True,exist_ok=True)
    clips=json.loads((ROOT/'data/reviews/active-clips.json').read_text(encoding='utf-8'))
    clip=next(c for c in clips if c['streamer']=='sany_jeweler')
    source=ROOT/'out/dota_2/sany_jeweler/v2859643784/20260923-205312-2e8f2a'/clip['file']
    with source.open('rb') as original:
        original_hash=hashlib.file_digest(original,'sha256').hexdigest()
    duration=float(command(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(source)]).stdout)
    prepared=op_clean_clip(dict(video=str(source),start=0,end=duration,out=str(out/'sany-ads-hidden.mp4'),
        transcript=clip.get('text','')),Reporter())
    (out/'sany-ads-hidden.json').write_text(json.dumps(prepared,ensure_ascii=False,indent=2),encoding='utf-8')
    def audio_hash(file):
        return command(['ffmpeg','-v','error','-i',str(file),'-map','0:a:0','-c:a','copy','-f','hash','-hash','sha256','-']).stdout
    assert audio_hash(source)==audio_hash(out/'sany-ads-hidden.mp4'), 'Original audio changed'
    # The QR/banner fixture goes through the exact cleanClip worker operation.
    fixture=out/'ads-fixture.mp4'
    command(['ffmpeg','-v','error','-y','-loop','1','-i',str(out/'ads-fixture-before.png'),'-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','2','-r','15','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac',str(fixture)])
    screened=op_clean_clip(dict(video=str(fixture),start=0,end=2,out=str(out/'ads-fixture-cleaned.mp4')),Reporter())
    cap=cv2.VideoCapture(str(out/'ads-fixture-cleaned.mp4'));count=0
    while True:
        ok,frame=cap.read()
        if not ok:break
        assert not cv2.QRCodeDetector().detectMulti(frame)[0], 'QR survived in final video'
        if count in (0,15):assert not detect_frame(frame)['regions'], 'Banner survived in final video'
        count+=1
    cap.release();assert count==30,count
    probe=json.loads(command(['ffprobe','-v','error','-show_streams','-of','json',str(out/'sany-ads-hidden.mp4')]).stdout)
    video=next(s for s in probe['streams'] if s['codec_type']=='video')
    audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
    assert abs(float(video['duration'])-float(audio['duration']))<.1, 'Audio/video drift'
    assert (video['width'],video['height'])==(1080,1920)
    with source.open('rb') as original:
        unchanged=original_hash==hashlib.file_digest(original,'sha256').hexdigest()
    assert unchanged, 'Original clip was modified'
    result=dict(adVideoFramesChecked=count,adRegions=screened['ads']['regions'],audioUnchanged=True,videoDuration=video['duration'],audioDuration=audio['duration'],originalUnchanged=unchanged,originalSha256=original_hash)
    (out/'ads-only-end-to-end.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)

if __name__=='__main__':main()
