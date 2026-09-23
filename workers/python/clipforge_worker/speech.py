"""Расшифровка речи через faster-whisper.

Транскрипт даёт сразу четыре вещи, и все нужны:

  1. точки реза - клип не должен обрываться на полуслове;
  2. триггеры по словам - реакции стримера и реплики диктора игры;
  3. темп речи - косвенный признак возбуждения;
  4. субтитры для будущего рендера.

Модель тяжёлая (large-v3), потому что обработка идёт после стрима, когда
игра закрыта и видеокарта свободна целиком. turbo быстрее втрое, но чаще
срывается в петлю повторов на игровом звуке - на тестовом VOD выдал 210
одинаковых слов подряд.

Параметры декодера и постфильтр против таких срывов - см. transcribe()
и drop_repetition_loops(). Замеры в DECISIONS.md.
"""
from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from clipforge_worker import cuda_setup  # noqa: F401  - регистрирует CUDA DLL до ctranslate2

log = logging.getLogger(__name__)

DEFAULT_MODEL = "large-v3"
DEFAULT_BATCH = 32


@dataclass(slots=True)
class Word:
    start: float
    end: float
    text: str


@dataclass(slots=True)
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass(slots=True)
class Transcript:
    language: str
    duration: float
    segments: list[Segment]
    # Сколько слов выкинул фильтр зацикливания. Диагностика, а не данные:
    # в файл не пишется, но воркер отдаёт её наверх.
    dropped_loops: int = 0

    @property
    def words(self) -> list[Word]:
        return [w for s in self.segments for w in s.words]

    def speech_seconds(self) -> float:
        return sum(s.end - s.start for s in self.segments)

    def save(self, path: Path | str) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "language": self.language,
            "duration": self.duration,
            "segments": [asdict(s) for s in self.segments],
        }
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    @classmethod
    def load(cls, path: Path | str) -> "Transcript":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        segments = [
            Segment(
                start=s["start"], end=s["end"], text=s["text"],
                words=[Word(**w) for w in s.get("words", [])],
            )
            for s in data["segments"]
        ]
        return cls(data["language"], data["duration"], segments)


def drop_repetition_loops(
    segments: list[Segment], max_repeats: int = 4
) -> tuple[list[Segment], int]:
    """Вырезать зацикленные повторы слов.

    Whisper иногда срывается в петлю и выдаёт одно слово сотни раз
    подряд. На этом VOD было 210 повторов «вашу» начиная с 18.6 минуты -
    расшифровка целого куска стрима превращалась в мусор, а вместе с ней
    и субтитры, и триггеры по словам.

    Параметры декодера такие срывы подавляют, но не гарантированно,
    поэтому здесь стоит страховка на уровне кода: подряд идущие
    одинаковые слова схлопываются. Живая речь тоже бывает повторяющейся
    («нет нет нет», «давай давай»), поэтому несколько повторов
    разрешено - режется только явная патология.

    Возвращает очищенные сегменты и число выброшенных слов.
    """
    removed = 0
    cleaned: list[Segment] = []

    for segment in segments:
        kept: list[Word] = []
        streak = 0
        previous = ""

        for word in segment.words:
            plain = re.sub(r"[^\w]", "", word.text.lower())
            streak = streak + 1 if plain and plain == previous else 1
            previous = plain
            if streak > max_repeats:
                removed += 1
                continue
            kept.append(word)

        if not kept:
            removed += 0
            continue

        text = " ".join(w.text for w in kept).strip() if len(kept) != len(segment.words) \
            else segment.text
        cleaned.append(Segment(
            start=kept[0].start, end=kept[-1].end, text=text, words=kept,
        ))

    return cleaned, removed


def load_model(model_name: str = DEFAULT_MODEL):
    """Поднять модель и обёртку пакетного вывода.

    Вынесено из transcribe, чтобы долгоживущий воркер грузил её один раз:
    large-v3 поднимается около двадцати секунд и занимает пару гигабайт
    видеопамяти, и на каждый эфир это чистая потеря.
    """
    from faster_whisper import BatchedInferencePipeline, WhisperModel
    import ctranslate2

    device = os.environ.get("SPEECH_DEVICE", "auto")
    if device not in ("auto", "cpu", "cuda"):
        raise ValueError("SPEECH_DEVICE must be auto, cpu or cuda")
    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    compute = os.environ.get("SPEECH_COMPUTE_TYPE") or ("float16" if device == "cuda" else "int8")
    model = WhisperModel(model_name, device=device, compute_type=compute,
                         cpu_threads=int(os.environ.get("SPEECH_CPU_THREADS", "2")))
    return BatchedInferencePipeline(model=model)


def transcribe(
    audio_path: Path | str,
    model_name: str = DEFAULT_MODEL,
    language: str = "ru",
    batch_size: int = DEFAULT_BATCH,
    beam_size: int = 1,
    glossary: list[str] | None = None,
    on_progress=None,
    engine=None,
) -> Transcript:
    """Расшифровать аудио целиком.

    Параметры декодера подобраны против зацикливания. Ключевой -
    condition_on_previous_text=False: с включённым условием модель
    подаёт себе на вход собственный повтор и укрепляется в нём, отсюда и
    берутся сотни одинаковых слов подряд.
    """
    # Готовую модель передаёт воркер; отдельный запуск поднимает свою.
    own_engine = engine is None
    if own_engine:
        engine = load_model(model_name)

    raw_segments, info = engine.transcribe(
        str(audio_path),
        language=language,
        word_timestamps=True,       # нужны и для субтитров, и для точек реза
        beam_size=beam_size,
        batch_size=batch_size,
        # Словарь терминов игры. Замер на доте: без него «Аганим»
        # слышалось как «за ним», а «Дагон» - как «догон».
        hotwords=", ".join(glossary) if glossary else None,
        vad_filter=True,            # не скармливать модели тишину и шум
        condition_on_previous_text=False,
        no_repeat_ngram_size=3,     # запрет повторять тройки слов
        repetition_penalty=1.1,
        compression_ratio_threshold=2.4,   # отсев вырожденного текста
        log_prob_threshold=-1.0,
        no_speech_threshold=0.6,
        # Перебор температур при срыве: на нуле модель залипает,
        # подъём температуры выводит её из петли.
        temperature=[0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    )

    segments: list[Segment] = []
    for s in raw_segments:
        segments.append(Segment(
            start=float(s.start),
            end=float(s.end),
            text=s.text.strip(),
            words=[Word(float(w.start), float(w.end), w.word.strip())
                   for w in (s.words or [])],
        ))
        if on_progress and len(segments) % 50 == 0:
            on_progress(segments[-1].end)

    segments, removed = drop_repetition_loops(segments)
    if removed:
        log.warning("вырезано зацикленных повторов: %d слов", removed)

    if own_engine:
        del engine
    return Transcript(
        language=info.language,
        duration=float(info.duration),
        segments=segments,
        dropped_loops=removed,
    )
