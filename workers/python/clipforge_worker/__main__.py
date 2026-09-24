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

    Ключ - имя модели: смена модели в настройках не должна требовать
    перезапуска воркера, но и выгружать предыдущую незачем, пока хватает
    памяти.
    """

    def __init__(self) -> None:
        self._whisper: dict[str, Any] = {}

    def whisper(self, name: str, ctx: Context):
        from clipforge_worker import speech

        if name not in self._whisper:
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


def op_transcribe(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    from clipforge_worker import speech

    audio = Path(params["audio"])
    if not audio.is_file():
        raise FileNotFoundError(f"нет файла: {audio}")

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


OPS: dict[str, Callable[[dict[str, Any], Context], dict[str, Any]]] = {
    "ping": op_ping,
    "transcribe": op_transcribe,
    "audioSignals": op_audio_signals,
    "facecam": op_facecam,
    "minimap": op_minimap,
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
