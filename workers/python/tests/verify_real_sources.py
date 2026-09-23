"""Opt-in regression checks on cached, unmodified Twitch footage.

Run inspect-real-attempts.mjs first. Does not create clips or publish anything.
The one blank-frame case is explicitly a synthetic negative test, not a sample
presented to users as a real stream.
"""
import json
import math
from pathlib import Path
from unittest.mock import patch

from clipforge_worker.facecam import Rect, find_facecam, grab_frames

rows=json.loads(Path('data/reviews/active-clips.json').read_text(encoding='utf-8'))
sources={
    'sany_jeweler':'data/games/dota_2/sany_jeweler/v2859643784/video_720p60.mp4',
    'rostikfacekid':'data/games/dota_2/rostikfacekid/v2874996172/video_720p60.mp4',
    'just_ns':'data/reviews/just_ns/source.mp4',
    'recrent':'data/reviews/recrent/source.mp4',
}
results=[]
for row in rows:
    channel=row['streamer']
    if channel not in sources:continue
    video=sources[channel]
    offset=row['sourceWindow']['start']
    start,end=row['start']-offset,row['end']-offset
    reference=Rect(**row['verification']['camera']['rect'])
    samples=min(200,math.ceil((end-start)*2)+1)
    result=find_facecam(video,samples,1,start=start,end=end,reference_rect=reference)
    assert result.found and result.rect==reference,(channel,result)
    assert result.hits==result.samples
    results.append({'case':channel,'hits':result.hits,'samples':result.samples})
    if channel=='rostikfacekid':
        trim=row['verification']['trim']
        original_start,original_end=trim['originalStart'],trim['originalEnd']
        original=find_facecam(video,math.ceil((original_end-original_start)*2)+1,1,
                              start=original_start,end=original_end,reference_rect=reference)
        assert not original.found and original.safe_windows
        assert any(w['start']<=row['start'] and w['end']>=row['end'] for w in original.safe_windows)
        results.append({'case':'masked-source-automatic-trim','originalHits':original.hits,
                        'originalSamples':original.samples,'safeWindows':original.safe_windows})
        # Even a single genuinely empty camera frame must not be interpolated.
        frames=grab_frames(video,samples,start=start,end=end)
        frames[len(frames)//2][reference.y:reference.y+reference.h,reference.x:reference.x+reference.w]=0
        with patch('clipforge_worker.facecam.grab_frames',return_value=frames):
            absent=find_facecam(video,samples,1,start=start,end=end,reference_rect=reference)
        assert not absent.found
        results.append({'case':'synthetic-single-empty-frame','found':absent.found})
    if channel=='just_ns':
        profile=find_facecam(video,71,1,start=20,end=55,reference_rect=reference)
        assert profile.found and profile.hits==71,profile
        results.append({'case':'real-profile-previously-missed','hits':profile.hits,'samples':profile.samples})
assert set(sources).issubset({r['case'] for r in results})
print(json.dumps(results,indent=2))
