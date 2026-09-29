"""Bounded, local speech enhancement. This is NOT a copyright detector.

DTLN inference follows Nils L. Westhausen's MIT-licensed reference:
https://github.com/breizhn/DTLN/blob/master/real_time_processing_onnx.py
DeepFilterNet uses the project's official standalone CPU executable.
"""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile
import time
import wave
import numpy as np


def command(args):
    # communicate(timeout=600) would expire during a desktop suspension.
    # Temporary files also keep verbose third-party output out of RAM/pipes.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        child = subprocess.Popen(args, stdout=stdout, stderr=stderr,
            creationflags=0x08000000 if os.name == 'nt' else 0)
        remaining, previous = 600., time.monotonic()
        try:
            while child.poll() is None:
                time.sleep(.1)
                now = time.monotonic()
                state_file = os.getenv('MEDIA_RESOURCE_STATE')
                paused = False
                if state_file:
                    try:
                        state = json.loads(Path(state_file).read_text(encoding='utf-8'))
                        paused = state.get('paused', True) or time.time()*1000-state.get('at', 0)>10000
                    except (OSError, ValueError):
                        paused = True
                # A long gap means our own process was suspended as well.
                if not paused:
                    remaining -= min(now-previous, .5)
                previous = now
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(args, 600)
            stdout.seek(0); stderr.seek(0)
            result = subprocess.CompletedProcess(args, child.returncode, stdout.read(65536), stderr.read(65536))
            if result.returncode:
                raise RuntimeError(result.stderr.decode(errors='replace')[-1500:] or f'Audio command failed: {result.returncode}')
            return result
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()


def read_wav(file):
    with wave.open(str(file), 'rb') as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError('Expected mono PCM16')
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32)/32768, wav.getframerate()


def write_wav(file, samples, rate):
    with wave.open(str(file), 'wb') as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(rate)
        wav.writeframes((np.clip(samples, -1, 32767/32768)*32768).astype('<i2').tobytes())


def dtln(audio, model_root):
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1; options.inter_op_num_threads = 1
    sessions = [ort.InferenceSession(str(Path(model_root)/f'model_{n}.onnx'), options, providers=['CPUExecutionProvider']) for n in (1, 2)]
    names = [[i.name for i in session.get_inputs()] for session in sessions]
    states = [{i.name: np.zeros([d if isinstance(d, int) else 1 for d in i.shape], np.float32) for i in session.get_inputs()} for session in sessions]
    # 512-sample window, 128-sample hop; trim latency and flush the final tail.
    hop, window, latency = 128, 512, 384
    padded = np.pad(audio, (0, window+hop))
    in_buffer, out_buffer = np.zeros(window, np.float32), np.zeros(window, np.float32)
    result = np.zeros(len(padded), np.float32)
    for pos in range(0, len(padded)-hop, hop):
        in_buffer[:-hop] = in_buffer[hop:]; in_buffer[-hop:] = padded[pos:pos+hop]
        spectrum = np.fft.rfft(in_buffer)
        magnitude, phase = np.abs(spectrum).reshape(1, 1, -1).astype(np.float32), np.angle(spectrum)
        states[0][names[0][0]] = magnitude
        mask, states[0][names[0][1]] = sessions[0].run(None, states[0])
        states[1][names[1][0]] = np.fft.irfft(magnitude*mask*np.exp(1j*phase)).astype(np.float32)
        block, states[1][names[1][1]] = sessions[1].run(None, states[1])
        out_buffer[:-hop] = out_buffer[hop:]; out_buffer[-hop:] = 0
        out_buffer += block.reshape(-1)
        result[pos:pos+hop] = out_buffer[:hop]
    return result[latency:latency+len(audio)]


def speech_gate(samples, rate, spans):
    """Keep padded speech intervals; smooth edges instead of hard clicks.

    Times are relative to the extracted audio, supplied by the transcript.
    Missing alignment never silently mutes speech: no spans means no gate.
    """
    if not spans:
        return samples
    mask=np.zeros(len(samples),np.float32)
    fade=max(1,int(.025*rate))
    for a,b in spans:
        left=max(0,int((a-.12)*rate)); right=min(len(samples),int((b+.12)*rate))
        if right<=left:continue
        envelope=np.ones(right-left,np.float32)
        size=min(fade,(right-left)//2)
        if size:
            envelope[:size]=np.linspace(0,1,size);envelope[-size:]=np.linspace(1,0,size)
        mask[left:right]=np.maximum(mask[left:right],envelope)
    return samples*mask


def clean_music(video, start, end, out, method='deepfilter', models='models', speech_spans=None):
    if method not in ('deepfilter', 'dtln', 'filter', 'mute'):
        raise ValueError('Unknown audio cleanup method')
    if not 0 <= start < end or end-start > 180:
        raise ValueError('Audio cleanup accepts clips of at most 180 seconds')
    out = Path(out); out.parent.mkdir(parents=True, exist_ok=True)
    signature = hashlib.sha256(json.dumps([3, str(Path(video).resolve()), Path(video).stat().st_size,
        Path(video).stat().st_mtime_ns, start, end, method, str(Path(models).resolve()),speech_spans]).encode()).hexdigest()
    meta = out.with_suffix('.json')
    if out.exists() and meta.exists():
        saved = json.loads(meta.read_text(encoding='utf-8'))
        if saved.get('signature') == signature:
            return saved
    began = time.monotonic()
    rate = 16000 if method == 'dtln' else 48000
    with tempfile.TemporaryDirectory(prefix='clipforge-speech-') as temporary:
        source = Path(temporary)/'source.wav'
        command(['ffmpeg','-v','error','-nostdin','-y','-ss',str(start),'-i',str(video),'-t',str(end-start),
                 '-vn','-ac','1','-ar',str(rate),'-c:a','pcm_s16le',str(source)])
        audio, _ = read_wav(source)
        if method == 'dtln':
            cleaned = dtln(audio, Path(models)/'dtln')
        elif method == 'deepfilter':
            binary = Path(models)/'deepfilter'/('deep-filter.exe' if os.name == 'nt' else 'deep-filter')
            if not binary.is_file():
                raise RuntimeError('Модель очистки звука не установлена; исходный звук не будет использован вместо неё')
            destination = Path(temporary)/'enhanced'; destination.mkdir()
            command([str(binary.resolve()), '-D', '--pf', '-o', str(destination), str(source)])
            files = list(destination.glob('*.wav'))
            if len(files) != 1:
                raise RuntimeError('Speech enhancer did not produce exactly one WAV')
            normalized = Path(temporary)/'normalized.wav'
            command(['ffmpeg','-v','error','-y','-i',str(files[0]),'-ac','1','-ar',str(rate),'-c:a','pcm_s16le',str(normalized)])
            cleaned, _ = read_wav(normalized)
        elif method == 'filter':
            filtered = Path(temporary)/'filtered.wav'
            command(['ffmpeg','-v','error','-y','-i',str(source),'-af','highpass=f=180,lowpass=f=4200,afftdn=nf=-20',str(filtered)])
            cleaned, _ = read_wav(filtered)
        else:
            cleaned = np.zeros_like(audio)
        # Exact source length keeps subtitles and outro in sync.
        cleaned = np.pad(cleaned[:len(audio)], (0, max(0, len(audio)-len(cleaned))))
        if method != 'mute':
            cleaned=speech_gate(cleaned,rate,speech_spans)
        pending = out.with_suffix('.pending.wav')
        write_wav(pending, cleaned, rate)
        os.replace(pending, out)
    result = dict(file=str(out), method=method, duration=len(audio)/rate, seconds=time.monotonic()-began,
                  rmsBefore=float(np.sqrt(np.mean(audio**2))), rmsAfter=float(np.sqrt(np.mean(cleaned**2))),
                  requiresReview=method != 'mute', signature=signature, speechGated=bool(speech_spans),
                  note='Проверьте остатки музыки и разборчивость речи' if method != 'mute' else 'Исходный звук отключён')
    meta.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result
