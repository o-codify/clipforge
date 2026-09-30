"""Долгоживущий python-воркер.

Читает задания построчно из stdin, пишет события и ответы в stdout - по
одному JSON на строку. Держит загруженные модели между заданиями: модель
large-v3 поднимается двадцать секунд и занимает пару гигабайт
видеопамяти, и перезапускать процесс на каждый эфир бессмысленно.

Воркер не ходит в базу и ничего не знает о доменной модели площадки. Он
получает пути к файлам и возвращает числа; что с ними делать, решает
бэкенд. Поэтому здесь нет ни очереди, ни расписания, ни состояния между
заданиями кроме кэша моделей.

Всё, что печатается не по протоколу (предупреждения библиотек, полоски
прогресса), уходит в stderr: одна посторонняя строка в stdout сломала бы
разбор на той стороне.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any, Callable

# Пути к соседним модулям пакета работают и при запуске файлом, и при
# запуске через -m.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

WORKER_VERSION = "0.1.0"

# Порядок рядов в бинарнике сигналов. Тот же список продублирован в
# packages/contracts/src/worker.ts - файл не самоописателен, и раскладка
# должна совпадать с точностью до порядка.
SIGNAL_SERIES = [
    "times", "rmsDb", "loudnessRel", "flux", "onsetRate",
    "hfRatio", "voiceRatio", "rhythm", "combat",
]


def emit(payload: dict[str, Any]) -> None:
    """Отправить строку протокола."""
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Context:
    """То, через что задание сообщает о ходе работы."""

    def __init__(self, request_id: str) -> None:
        self.id = request_id

    def log(self, message: str, level: str = "info") -> None:
        emit({"event": "log", "id": self.id, "level": level,
              "message": str(message)})

    def progress(self, stage: str, value: float | None = None) -> None:
        emit({"event": "progress", "id": self.id, "stage": stage,
              "value": value})


class Models:
    """Кэш загруженных моделей.

    При смене модели освобождаем предыдущую. Контроллер рабочего стола
    также выгружает процесс при длительной паузе или нехватке памяти.
    """

    def __init__(self) -> None:
        self._whisper: dict[str, Any] = {}

    def whisper(self, name: str, ctx: Context):
        from clipforge_worker import speech

        if name not in self._whisper:
            self._whisper.clear()
            import gc
            gc.collect()
            ctx.progress(f"загрузка модели {name}")
            self._whisper[name] = speech.load_model(name)
            ctx.log(f"модель {name} загружена")
        return self._whisper[name]

    def loaded(self) -> list[str]:
        return sorted(self._whisper)


MODELS = Models()


# --- операции --------------------------------------------------------

def op_ping(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    device = "cpu"
    cuda = False
    try:
        import ctranslate2

        cuda = ctranslate2.get_cuda_device_count() > 0
        device = "cuda" if cuda else "cpu"
    except Exception:
        pass
    return {
        "worker": WORKER_VERSION,
        "python": sys.version.split()[0],
        "torchCuda": cuda,
        "device": device,
        "loaded": MODELS.loaded(),
    }


def op_cached_transcript(params: dict[str, Any], ctx: Context):
    from clipforge_worker import speech
    result = speech.completed_checkpoint(params['audio'], model_name=params.get('model','large-v3'),
        language=params.get('language','ru'), batch_size=int(params.get('batchSize',1)),
        beam_size=int(params.get('beamSize',1)), glossary=list(params.get('glossary') or []))
    return transcript_result(result) if result is not None else None


def op_transcribe(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    from clipforge_worker import speech

    audio = Path(params["audio"])
    if not audio.is_file():
        raise FileNotFoundError(f"нет файла: {audio}")

    cached = op_cached_transcript(params, ctx)
    if cached is not None:
        return cached
    model_name = params.get("model", "large-v3")
    engine = MODELS.whisper(model_name, ctx)

    ctx.progress("распознавание", None)
    result = speech.transcribe(
        audio,
        engine=engine,
        on_progress=lambda seconds: ctx.progress(f"распознано {seconds / 60:.1f} мин"),
        model_name=model_name,
        language=params.get("language", "ru"),
        batch_size=int(params.get("batchSize", os.environ.get("SPEECH_BATCH_SIZE", "1"))),
        beam_size=int(params.get("beamSize", 1)),
        glossary=list(params.get("glossary") or []),
    )

    return transcript_result(result)


def transcript_result(result):
    return {
        "language": result.language,
        "duration": result.duration,
        "segments": [
            {
                "start": s.start, "end": s.end, "text": s.text,
                "words": [{"start": w.start, "end": w.end, "text": w.text}
                          for w in s.words],
            }
            for s in result.segments
        ],
        "droppedLoops": getattr(result, "dropped_loops", 0),
    }


def op_audio_signals(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    import numpy as np

    from clipforge_worker import audio as audio_mod

    source = Path(params["audio"])
    if not source.is_file():
        raise FileNotFoundError(f"нет файла: {source}")

    ctx.progress("декодирование", None)
    samples = audio_mod.decode_audio(source)

    ctx.progress("спектр и сигналы", None)
    signals = audio_mod.analyze(
        samples,
        hop_seconds=float(params.get("hopSeconds", 0.05)),
        baseline_seconds=float(params.get("baselineSeconds", 45.0)),
    )

    # Ряды пишутся в один бинарник подряд, float32 LE. JSON здесь не
    # годится: на часовом эфире это восемьдесят тысяч кадров на девять
    # рядов, то есть десятки мегабайт текста на разбор.
    attr = {
        "times": "times", "rmsDb": "rms_db", "loudnessRel": "loudness_rel",
        "flux": "flux", "onsetRate": "onset_rate", "hfRatio": "hf_ratio",
        "voiceRatio": "voice_ratio", "rhythm": "rhythm", "combat": "combat",
    }
    stacked = np.stack(
        [np.asarray(getattr(signals, attr[name]), dtype=np.float32)
         for name in SIGNAL_SERIES]
    )

    out = Path(params["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(stacked.astype("<f4").tobytes(order="C"))

    frames = int(stacked.shape[1])
    ctx.log(f"кадров {frames}, рядов {len(SIGNAL_SERIES)}, {out.name}")
    return {
        "file": str(out),
        "frames": frames,
        "hopSeconds": signals.hop_seconds,
        "duration": signals.duration,
        "series": SIGNAL_SERIES,
        "dtype": "float32",
    }


def op_facecam(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    from clipforge_worker import facecam as facecam_mod

    video = Path(params["video"])
    if not video.is_file():
        raise FileNotFoundError(f"нет файла: {video}")

    ctx.progress("поиск камеры", None)
    result = facecam_mod.find_facecam(
        video,
        int(params.get("samples", 40)),
        float(params.get("minHitRatio", 0.7)),
        model_path=params.get("modelPath") or None,
        game=params.get("game"),
        start=params.get("start"), end=params.get("end"),
        reference_rect=facecam_mod.Rect(**params["referenceRect"]) if params.get("referenceRect") else None,
    )
    ctx.log(result.note)

    def rect(value) -> dict[str, int] | None:
        if value is None:
            return None
        return {"x": value.x, "y": value.y, "w": value.w, "h": value.h}

    return {
        "found": result.found,
        "rect": rect(result.rect),
        "face": rect(result.face),
        "confidence": float(result.confidence),
        "samples": int(result.samples),
        "hits": int(result.hits),
        "tracked": int(result.tracked),
        "safeWindows": result.safe_windows,
        "note": result.note,
    }


def op_minimap(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    from dataclasses import asdict
    from clipforge_worker.minimap import find_minimap
    from clipforge_worker.facecam import Rect
    ctx.progress("поиск мини-карты", None)
    result=find_minimap(params["video"],params["game"],params["start"],params["end"],
                        int(params.get("samples",12)),
                        Rect(**params["excludeRect"]) if params.get("excludeRect") else None)
    ctx.log(result.note)
    return asdict(result)


def op_prepare_media(params, ctx):
    from clipforge_worker.ads import scan_ads
    enabled = params.get('adCheckEnabled', True)
    if enabled:
        ctx.progress('Проверяю рекламные вставки')
    profile = params.get('adProfile')
    regions = list(params.get('regions', []))
    if profile and enabled:
        from clipforge_worker.ad_profile import source_info, VERSION, REVIEW_VERSION
        info = source_info(params['video'])
        if profile.get('signature') != info['signature'] or profile.get('version') != VERSION or profile.get('reviewVersion') != REVIEW_VERSION or profile.get('complete') is not True:
            raise ValueError('Карта рекламы не соответствует исходнику')
        regions.extend(profile['regions'])
    ads = scan_ads(params['video'], params['start'], params['end'], params.get('transcript', ''), regions, verified_profile=bool(profile)) if enabled else dict(
        enabled=False, regions=[], qrHits=0, bannerHits=0, frames=0, coverage=0,
        reject=False, reason=None, requiresReview=False, sampleFps=0, ocrFps=0, automatic=False)
    if profile and enabled and not ads['reject']:
        ads.update(requiresReview=False, automatic=True, profileId=profile['signature'], profileFrames=profile['samples'])
    # Only the new explicit per-run option enables DTLN. Legacy method and
    # speechSpans never enable enhancement or gating for ordinary rendering.
    audio = {'method': 'original'}
    if params.get('audioMode') in ('dtln', 'dtln-gated') and not ads['reject']:
        from clipforge_worker.music import clean_music
        if not params.get('audioOut') or not params.get('models'):
            raise ValueError('Для DTLN нужны путь результата и каталог моделей')
        gated = params.get('audioMode') == 'dtln-gated'
        spans = params.get('speechSpans')
        if gated and not spans:
            raise ValueError('Для DTLN с паузами нужна расшифровка речи')
        ctx.progress('Обрабатываю звук: DTLN с паузами' if gated else 'Обрабатываю звук: DTLN')
        audio = clean_music(params['video'], params['start'], params['end'],
            params['audioOut'], 'dtln', params['models'], **({'speech_spans':spans} if gated else {}))
    return {'audio': audio, 'ads': ads}


def op_profile_ads(params, ctx):
    from clipforge_worker.ad_profile import profile_ads
    return profile_ads(params['video'], params['directory'], params.get('cached'), ctx.progress)


def op_clean_clip(params, ctx):
    from clipforge_worker.music import command
    result = op_prepare_media(params, ctx)
    if result['ads']['reject']:
        raise ValueError(result['ads']['reason'])
    masks = result['ads']['regions']
    filters = ','.join(f"drawbox=x={r['x']}:y={r['y']}:w={r['w']}:h={r['h']}:color=0x18161e:t=fill" for r in masks)
    pending = str(Path(params['out']).with_suffix('.pending.mp4'))
    Path(params['out']).parent.mkdir(parents=True, exist_ok=True)
    enhanced = result['audio']['method'] == 'dtln'
    command(['ffmpeg','-v','error','-nostdin','-y',
             *(['-ss',str(params['start'])] if params['start'] else []),'-i',params['video'],
             *(['-i',result['audio']['file']] if enhanced else []),
             '-map','0:v:0','-map','1:a:0' if enhanced else '0:a?',
             *(['-vf',filters,'-c:v','libx264','-preset','veryfast','-crf','20','-threads','2'] if filters else ['-c:v','copy']),
             '-c:a','aac' if enhanced else 'copy','-t',str(params['end']-params['start']),'-movflags','+faststart',pending])
    os.replace(pending,params['out'])
    return {**result,'file':params['out']}


OPS: dict[str, Callable[[dict[str, Any], Context], dict[str, Any]]] = {
    "profileAds": op_profile_ads,
    "ping": op_ping,
    "transcribe": op_transcribe,
    "cachedTranscript": op_cached_transcript,
    "audioSignals": op_audio_signals,
    "facecam": op_facecam,
    "minimap": op_minimap,
    "prepareMedia": op_prepare_media,
    "cleanClip": op_clean_clip,
}


# --- цикл ------------------------------------------------------------

def handle(line: str) -> None:
    try:
        request = json.loads(line)
    except ValueError as exc:
        emit({"id": "", "ok": False,
              "error": {"type": "BadRequest", "message": f"не JSON: {exc}"}})
        return

    request_id = str(request.get("id") or "")
    ctx = Context(request_id)
    op = request.get("op")

    handler = OPS.get(op)
    if handler is None:
        emit({"id": request_id, "ok": False,
              "error": {"type": "UnknownOp", "message": f"нет операции {op!r}"}})
        return

    try:
        result = handler(request.get("params") or {}, ctx)
        emit({"id": request_id, "ok": True, "result": result})
    except Exception as exc:
        emit({"id": request_id, "ok": False, "error": {
            "type": type(exc).__name__,
            "message": str(exc),
            "traceback": traceback.format_exc()[-4000:],
        }})


def main() -> int:
    # Библиотеки любят печатать в stdout; протоколу это смертельно.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    emit({"event": "log", "id": "", "level": "info",
          "message": f"воркер {WORKER_VERSION} готов"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line == "exit":
            break
        handle(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
