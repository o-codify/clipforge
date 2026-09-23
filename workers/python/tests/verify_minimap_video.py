"""Opt-in integration checks on real cached Twitch footage; creates no clips."""
import json,math
from dataclasses import asdict
from pathlib import Path
import cv2
from clipforge_worker.minimap import find_minimap,detect_minimap
from clipforge_worker.facecam import Rect,grab_frames

cases={
 'sany_jeweler':('data/games/dota_2/sany_jeweler/v2859643784/video_720p60.mp4','dota2',False,None),
 'rostikfacekid':('data/games/dota_2/rostikfacekid/v2874996172/video_720p60.mp4','dota2',True,Rect(0,551,155,169)),
 'just_ns':('data/reviews/just_ns/source.mp4','dota2',True,Rect(0,535,185,185)),
 'recrent':('data/reviews/recrent/source.mp4','pubg',True,Rect(1063,528,193,174)),
}
rows=json.loads(Path('data/reviews/active-clips.json').read_text(encoding='utf-8'))
results=[]
for row in rows:
    channel=row['streamer']
    if channel not in cases:continue
    video,game,expected,annotation=cases[channel]
    start=row['start']-row['sourceWindow']['start'];end=row['end']-row['sourceWindow']['start']
    result=find_minimap(video,game,start,end,math.ceil((end-start)*2)+1,Rect(**row['verification']['camera']['rect']))
    print(channel,result.found,result.rect,result.hits,result.samples,flush=True)
    results.append({'channel':channel,'found':result.found,'rect':asdict(result.rect) if result.rect else None,
                    'hits':result.hits,'samples':result.samples})
    assert result.found==expected,(channel,result)
    if result.rect:
        a,b=result.rect,annotation
        intersection=max(0,min(a.x+a.w,b.x+b.w)-max(a.x,b.x))*max(0,min(a.y+a.h,b.y+b.h)-max(a.y,b.y))
        assert intersection/(a.w*a.h+b.w*b.h-intersection)>.85,(channel,a,b)
        cap=cv2.VideoCapture(video);cap.set(cv2.CAP_PROP_POS_MSEC,(start+end)*500)
        ok,frame=cap.read();cap.release();assert ok
        cv2.imwrite(f'data/reviews/minimap/detected-{channel}.jpg',frame[a.y:a.y+a.h,a.x:a.x+a.w])
Path('data/reviews/minimap/validation.json').write_text(json.dumps(results,indent=2),encoding='utf-8')

# Explicit robustness tests; these altered frames are never made into clips.
frames=grab_frames('data/reviews/just_ns/source.mp4',5,start=6,end=30)
for mode in ['absent','one-empty-frame','partial-cover','camera-instead','moved-right','resized','unsupported']:
    changed=[f.copy() for f in frames]
    for i,frame in enumerate(changed):
        if mode=='absent' or (mode=='one-empty-frame' and i==2):frame[534:720,0:186]=0
        elif mode=='partial-cover' and i==2:frame[534:720,0:75]=0
        elif mode=='camera-instead':frame[534:720,0:186]=cv2.resize(frame[566:720,220:460],(186,186))
        elif mode=='moved-right':
            frame[534:720,1094:1280]=frame[534:720,0:186].copy();frame[534:720,0:186]=0
        elif mode=='resized':changed[i]=cv2.resize(frame,(1920,1080))
    result=detect_minimap(changed,'unknown' if mode=='unsupported' else 'dota2')
    print('robustness',mode,result.found,result.rect,flush=True)
    assert result.found==(mode in ['moved-right','resized']),(mode,result)
    if mode=='moved-right':assert result.rect.x>1000
    if mode=='resized':assert result.rect.y>790 and result.rect.w>260
