"""Offline reproducible comparison; never uploads anything."""
import json
import os
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'workers/python'))
from clipforge_worker.music import clean_music, command
import psutil
if os.name == 'nt':
    psutil.Process().nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
root = Path(__file__).resolve().parents[1]
out = root/'data/reviews/media-protection'
samples = {
    'sany': root/'out/dota_2/sany_jeweler/v2859643784/20260923-205312-2e8f2a/001_reaction_2496.mp4',
    'recrent': root/'out/pubg_battlegrounds/recrent/v2881047555/20260923-192342-d2bb10/001_visual_review.mp4',
}
results = {}
for name, video in samples.items():
    if not video.exists():
        raise FileNotFoundError(video)
    command(['ffmpeg','-v','error','-y','-i',str(video),'-t','20','-vn','-ac','1','-ar','48000',str(out/f'{name}-original.wav')])
    results[name] = {}
    for method in ['filter','dtln','deepfilter','mute']:
        result = clean_music(video,0,20,out/f'{name}-{method}.wav',method,root/'models')
        results[name][method] = result
        print(name, method, round(result['seconds'],2), flush=True)
(out/'comparison.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
