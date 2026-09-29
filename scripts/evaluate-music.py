"""Known-source benchmark, complementing actual-stream ASR comparisons.

The soundtrack here is synthesized test data, not a commercial song. Scores
do not predict Content ID and cannot establish separation of a singing voice.
"""
import json
from pathlib import Path
import sys
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'workers/python'))
from clipforge_worker.music import clean_music,command,read_wav,write_wav
root=Path(__file__).resolve().parents[1]; out=root/'data/reviews/media-protection'
command(['ffmpeg','-v','error','-y','-i',str(out/'reference-speech.wav'),'-ac','1','-ar','48000','-c:a','pcm_s16le',str(out/'reference.wav')])
speech,rate=read_wav(out/'reference.wav')
speech=np.pad(speech,(rate*2,rate*2))
t=np.arange(len(speech))/rate
notes=np.array([130.81,164.81,196.,261.63,220.,196.,164.81,146.83])
freq=notes[(t*3).astype(int)%len(notes)]
phase=2*np.pi*np.cumsum(freq)/rate
music=.6*np.sin(phase)+.23*np.sin(phase*2)+.17*np.sin(phase*3)
music*=.7+.3*np.cos(2*np.pi*3*t)
music+=.25*np.sin(2*np.pi*55*t)*np.exp(-((t*2)%1)*15)
music*=np.sqrt(np.mean(speech**2))/np.sqrt(np.mean(music**2))
mixture=speech+music
write_wav(out/'known-mixture.wav',mixture,rate)
def sisdr(reference,estimate):
    target=np.dot(reference,estimate)/(np.dot(reference,reference)+1e-12)*reference
    return float(10*np.log10((np.sum(target**2)+1e-12)/(np.sum((estimate-target)**2)+1e-12)))
results={'baselineSisdr':sisdr(speech,mixture),'duration':len(speech)/rate,'methods':{}}
for label in ['filter','dtln','deepfilter','dtln-gated','deepfilter-gated']:
    method=label.split('-')[0]
    spans=[[2,len(speech)/rate-2]] if label.endswith('-gated') else None
    result=clean_music(out/'known-mixture.wav',0,len(mixture)/rate,out/f'known-{label}.wav',method,root/'models',spans)
    command(['ffmpeg','-v','error','-y','-i',str(out/f'known-{label}.wav'),'-ar',str(rate),'-c:a','pcm_s16le',str(out/'metric.wav')])
    enhanced,_=read_wav(out/'metric.wav'); enhanced=enhanced[:len(speech)]
    # Leading/trailing 1.5 seconds contain the music source alone.
    silence=np.r_[0:int(rate*1.5),len(speech)-int(rate*1.5):len(speech)]
    reduction=float(10*np.log10((np.mean(mixture[silence]**2)+1e-12)/(np.mean(enhanced[silence]**2)+1e-12)))
    results['methods'][label]={'sisdr':sisdr(speech,enhanced),'musicOnlyAttenuationDb':reduction,'seconds':result['seconds'],
                             'musicOnlyRms':float(np.sqrt(np.mean(enhanced[silence]**2)))}
print(json.dumps(results,indent=2))
(out/'known-mixture-metrics.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
