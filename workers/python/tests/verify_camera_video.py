"""Opt-in local integration check using decoded video and the real YuNet model.
PYTHONPATH=workers/python python workers/python/tests/verify_camera_video.py VIDEO
Synthetic occlusion is a robustness check, not a real masked-person benchmark.
"""
import sys,json
from unittest.mock import patch
import numpy as np
from clipforge_worker.facecam import grab_frames,find_facecam,Rect
video=sys.argv[1]
reference=Rect(52,413,261,307)
results=[]
for start,end in [(1044.15,1109.99),(1158.2,1189.8),(2476.5,2507.1)]:
    frames=grab_frames(video,65,start=start,end=end)
    with patch('clipforge_worker.facecam.grab_frames',return_value=frames):
        result=find_facecam(video,65,1,start=start,end=end,reference_rect=reference)
    assert not result.found or result.rect==reference
    results.append({'case':f'real-{start}','found':result.found,'hits':result.hits,'samples':result.samples})
    if start!=1158.2:continue
    for mode in ['covered-mouth','camera-absent','camera-disappears','frozen','camera-moved']:
        changed=[f.copy() for f in frames]
        for i,f in enumerate(changed):
            if mode=='covered-mouth':f[525:620,110:245]=0
            elif mode=='camera-absent' or (mode=='camera-disappears' and 20<=i<=30):f[413:720,52:313]=0
            elif mode=='frozen':changed[i]=frames[0].copy()
            elif mode=='camera-moved':
                crop=f[413:720,52:313].copy();f[413:720,52:313]=0;f[413:720,700:961]=crop
        with patch('clipforge_worker.facecam.grab_frames',return_value=changed):
            r=find_facecam(video,65,1,start=start,end=end,reference_rect=reference)
        if mode!='covered-mouth':assert not r.found,(mode,r)
        assert not r.found or r.rect==reference
        results.append({'case':mode,'found':r.found,'hits':r.hits,'samples':r.samples})
print(json.dumps(results,indent=2))
