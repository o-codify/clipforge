"""Извлечение сигналов из аудиодорожки.

Задача: по звуку понять, где на стриме бой, где тишина, где реакция.

Ключевая мысль — считать всё **относительно скользящего фона**, а не по
абсолютным порогам. Абсолютное «-20 дБ» ничего не значит: у одного
стримера игра громче, у другого тише, у третьего фоновая музыка. А вот
«в 4 раза выше, чем обычно на этом участке» значит одно и то же везде.

Это же решает проблему затяжных боёв. Пятиминутный бой с боссом
интенсивен равномерно, и абсолютный порог выделил бы его целиком.
Скользящий фон поднимается вместе с боем, и на его фоне видны настоящие
пики: смерть, критическая фаза, добивание.

Все сигналы считаются по одной сетке кадров (hop), чтобы их можно было
складывать без пересчёта таймкодов.
"""
from __future__ import annotations

import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

SAMPLE_RATE = 16_000          # речь и транзиенты укладываются, лишнего не тянем
HOP_SECONDS = 0.05            # 20 кадров в секунду - хватает для очередей выстрелов
FFT_SIZE = 1024


def decode_audio(path: Path | str, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Прочитать любой медиафайл в моно float32 через ffmpeg.

    ffmpeg берёт на себя все контейнеры и кодеки, поэтому отдельная
    библиотека для декодирования не нужна.
    """
    cmd = [
        "ffmpeg", "-nostdin", "-loglevel", "error",
        "-i", str(path),
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(sample_rate),
        "-",
    ]
    with tempfile.TemporaryDirectory(prefix="clipforge-audio-") as temporary:
        decoded = Path(temporary) / "audio.f32"
        cmd[-1] = str(decoded)
        proc = subprocess.run(cmd, capture_output=True, check=False,
                              creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
        if proc.returncode != 0:
            raise RuntimeError(
                f"ffmpeg не смог прочитать {path}: {proc.stderr.decode(errors='replace')[:300]}"
            )
        return np.fromfile(decoded, dtype=np.float32)


def rolling_baseline(values: np.ndarray, window_frames: int, percentile: float = 50.0) -> np.ndarray:
    """Скользящий фон.

    Медиана, а не среднее: одиночный взрыв не должен поднимать фон,
    относительно которого мы же его и измеряем.

    Реализовано через прореженные опорные точки с линейной
    интерполяцией между ними. Честная скользящая медиана по каждому кадру
    для четырёхчасового стрима считалась бы неприлично долго, а фон по
    определению меняется медленно - разницы в результате нет.
    """
    n = len(values)
    if n == 0:
        return values.copy()

    window_frames = max(1, window_frames)
    step = max(1, window_frames // 4)
    anchors = np.arange(0, n, step)

    base = np.empty(len(anchors), dtype=np.float32)
    half = window_frames // 2
    for i, centre in enumerate(anchors):
        lo = max(0, centre - half)
        hi = min(n, centre + half + 1)
        base[i] = np.percentile(values[lo:hi], percentile)

    if len(anchors) == 1:
        return np.full(n, base[0], dtype=np.float32)
    return np.interp(np.arange(n), anchors, base).astype(np.float32)


@dataclass(slots=True)
class AudioSignals:
    """Сигналы по единой сетке кадров. Все массивы одной длины."""

    hop_seconds: float
    times: np.ndarray          # секунда начала каждого кадра
    rms_db: np.ndarray         # громкость, дБ
    loudness_rel: np.ndarray   # громкость минус скользящий фон, дБ
    flux: np.ndarray           # спектральный поток - резкость изменений
    onset_rate: np.ndarray     # плотность атак в секунду
    hf_ratio: np.ndarray       # доля энергии в 2-8 кГц
    voice_ratio: np.ndarray    # доля энергии в 80-400 Гц (основной тон речи)
    rhythm: np.ndarray         # ритмичность атак, 0..1 (высокая = музыка)
    combat: np.ndarray         # сводная интенсивность боя, 0..1

    def __len__(self) -> int:
        return len(self.times)

    @property
    def duration(self) -> float:
        return float(len(self.times) * self.hop_seconds)


def _stft_magnitudes(samples: np.ndarray, hop: int) -> np.ndarray:
    """Магнитудный спектр по кадрам. Окно Ханна, без лишних зависимостей."""
    n_frames = max(1, 1 + (len(samples) - FFT_SIZE) // hop) if len(samples) >= FFT_SIZE else 1

    padded = samples
    needed = (n_frames - 1) * hop + FFT_SIZE
    if len(padded) < needed:
        padded = np.pad(padded, (0, needed - len(padded)))

    # Матрица кадров без копирования данных.
    frames = np.lib.stride_tricks.as_strided(
        padded,
        shape=(n_frames, FFT_SIZE),
        strides=(padded.strides[0] * hop, padded.strides[0]),
        writeable=False,
    )
    window = np.hanning(FFT_SIZE).astype(np.float32)
    result = np.empty((n_frames, FFT_SIZE // 2 + 1), dtype=np.float32)
    for start in range(0, n_frames, 4096):
        block = frames[start:start + 4096]
        result[start:start + len(block)] = np.abs(np.fft.rfft(block * window, axis=1)).astype(np.float32)
    return result


def analyze(
    source: Path | str | np.ndarray,
    sample_rate: int = SAMPLE_RATE,
    hop_seconds: float = HOP_SECONDS,
    baseline_seconds: float = 45.0,
) -> AudioSignals:
    """Посчитать все аудиосигналы.

    baseline_seconds - окно скользящего фона. Слишком короткое окно
    съедает сам бой (фон догоняет пик), слишком длинное перестаёт
    учитывать смену обстановки. 45 секунд - разумная середина.
    """
    samples = source if isinstance(source, np.ndarray) else decode_audio(source, sample_rate)
    if len(samples) == 0:
        empty = np.zeros(0, dtype=np.float32)
        return AudioSignals(hop_seconds, *(empty.copy() for _ in range(9)))

    hop = max(1, int(sample_rate * hop_seconds))
    mags = _stft_magnitudes(samples, hop)
    n_frames = len(mags)
    times = (np.arange(n_frames) * hop_seconds).astype(np.float32)

    freqs = np.fft.rfftfreq(FFT_SIZE, 1.0 / sample_rate)
    total = mags.sum(axis=1) + 1e-9

    # --- громкость -------------------------------------------------
    energy = (mags ** 2).sum(axis=1)
    rms_db = (10.0 * np.log10(energy + 1e-10)).astype(np.float32)
    loudness_rel = rms_db - rolling_baseline(rms_db, int(baseline_seconds / hop_seconds))

    # --- спектральный поток ----------------------------------------
    # Только положительные приращения: интересует появление звука,
    # а не его затухание. Это классический детектор атак.
    diff = np.diff(mags, axis=0, prepend=mags[:1])
    flux = np.maximum(diff, 0).sum(axis=1).astype(np.float32)

    # --- полосы частот ---------------------------------------------
    # 2-8 кГц: выстрелы, попадания, звон металла, разбитое стекло.
    hf_band = (freqs >= 2000) & (freqs <= 8000)
    hf_ratio = (mags[:, hf_band].sum(axis=1) / total).astype(np.float32)

    # 80-400 Гц: основной тон человеческого голоса.
    voice_band = (freqs >= 80) & (freqs <= 400)
    voice_ratio = (mags[:, voice_band].sum(axis=1) / total).astype(np.float32)

    # --- плотность атак --------------------------------------------
    onset_rate = _onset_rate(flux, hop_seconds)

    # --- ритмичность (детектор фоновой музыки) ---------------------
    rhythm = periodicity(flux, hop_seconds)

    # --- сводная интенсивность боя ---------------------------------
    combat = _combat_score(
        loudness_rel, onset_rate, hf_ratio, hop_seconds, baseline_seconds, rhythm
    )

    return AudioSignals(
        hop_seconds=hop_seconds,
        times=times,
        rms_db=rms_db,
        loudness_rel=loudness_rel,
        flux=flux,
        onset_rate=onset_rate,
        hf_ratio=hf_ratio,
        voice_ratio=voice_ratio,
        rhythm=rhythm,
        combat=combat,
    )


def _onset_rate(flux: np.ndarray, hop_seconds: float, window_seconds: float = 1.0) -> np.ndarray:
    """Сколько атак в секунду.

    Атакой считается локальный максимум потока, заметно превышающий
    свой скользящий фон. Очередь выстрелов даёт много атак подряд,
    ровный гул или тишина - почти ни одной.
    """
    if len(flux) == 0:
        return flux.copy()

    base = rolling_baseline(flux, int(5.0 / hop_seconds), percentile=60.0)
    spread = np.maximum(base, np.percentile(flux, 60) * 0.5) + 1e-6
    is_peak = flux > base + spread

    # Убираем дребезг: соседние кадры одного удара считаем одной атакой.
    is_peak[1:] &= ~is_peak[:-1]

    window = max(1, int(window_seconds / hop_seconds))
    kernel = np.ones(window, dtype=np.float32)
    counts = np.convolve(is_peak.astype(np.float32), kernel, mode="same")
    return (counts / window_seconds).astype(np.float32)


def periodicity(flux: np.ndarray, hop_seconds: float, window_seconds: float = 4.0) -> np.ndarray:
    """Насколько ритмичны атаки, 0..1. Детектор фоновой музыки.

    У музыки удары идут по сетке: автокорреляция потока атак даёт
    выраженный пик на периоде бита. У боя атаки нерегулярны -
    автокорреляция плоская.

    Это единственный признак, который надёжно отделяет громкую музыку от
    боя. По громкости они неразличимы, а по высоким частотам совпадают,
    если музыка с тарелками и гитарой.

    Ищем период в диапазоне 0.3-2 с, что покрывает 30-200 ударов в минуту.
    Считаем с прореживанием и интерполируем: ритм меняется медленно,
    поэтому считать в каждом кадре незачем.
    """
    n = len(flux)
    if n < 8:
        return np.zeros(n, dtype=np.float32)

    window = max(8, int(window_seconds / hop_seconds))
    stride = max(1, window // 4)
    min_lag = max(1, int(0.3 / hop_seconds))
    max_lag = min(window - 2, int(2.0 / hop_seconds))
    if max_lag <= min_lag:
        return np.zeros(n, dtype=np.float32)

    anchors = np.arange(0, n, stride)
    values = np.zeros(len(anchors), dtype=np.float32)

    for i, centre in enumerate(anchors):
        lo = max(0, centre - window // 2)
        chunk = flux[lo:lo + window]
        if len(chunk) < max_lag + 2:
            continue
        chunk = chunk - chunk.mean()
        norm = float(chunk @ chunk)
        if norm < 1e-9:
            continue
        # Автокорреляция только на интересующих задержках.
        lags = np.arange(min_lag, max_lag)
        corr = np.array([chunk[:-lag] @ chunk[lag:] for lag in lags], dtype=np.float32)
        values[i] = float(np.clip(corr.max() / norm, 0.0, 1.0))

    if len(anchors) == 1:
        return np.full(n, values[0], dtype=np.float32)
    return np.interp(np.arange(n), anchors, values).astype(np.float32)


def _combat_score(
    loudness_rel: np.ndarray,
    onset_rate: np.ndarray,
    hf_ratio: np.ndarray,
    hop_seconds: float,
    baseline_seconds: float,
    rhythm: np.ndarray | None = None,
) -> np.ndarray:
    """Сводная оценка «сейчас идёт бой», 0..1.

    Ни один признак сам по себе не годится:
      - громкость поднимает и музыка, и крик;
      - плотность атак поднимает ритмичная музыка;
      - высокие частоты поднимает шипение и шум.

    А вот вместе они разделяют ситуации: бой это одновременно громко,
    часто и звонко. Поэтому признаки перемножаются, а не складываются -
    у сложения высокий балл по одному признаку вытягивает всю оценку,
    и ровная громкая музыка объявляется боем.

    Веса не равны, и полом отличаются намеренно. Признаки разной
    надёжности:

      громкость (0.50) - самый устойчивый;
      плотность атак (0.35) - хорошо отделяет очереди от гула;
      высокие частоты (0.15) - самый шумный, и в некоторых играх звук
          широкополосный настолько, что признак не различает вообще
          ничего.

    Отсюда пол 0.05 у каждого множителя. При обычном геометрическом
    среднем неразличающий признак с нулём утягивал бы оценку в пол
    независимо от остальных: замер на синтетике давал 0.08 там, где
    по громкости и атакам был очевидный бой. С полом и весами
    бесполезный признак лишь слегка снижает оценку.
    """
    if len(loudness_rel) == 0:
        return loudness_rel.copy()

    def squash(x: np.ndarray, lo: float, hi: float) -> np.ndarray:
        return np.clip((x - lo) / max(hi - lo, 1e-6), 0.0, 1.0)

    window = int(baseline_seconds / hop_seconds)

    loud = squash(loudness_rel, 1.0, 10.0)          # дБ над фоном

    onset_base = rolling_baseline(onset_rate, window, 50.0)
    onset = squash(onset_rate - onset_base, 0.5, 4.0)

    hf_base = rolling_baseline(hf_ratio, window, 50.0)
    hf = squash(hf_ratio - hf_base, 0.005, 0.10)

    floor = 0.05
    score = (
        np.maximum(loud, floor) ** 0.45
        * np.maximum(onset, floor) ** 0.30
        * np.maximum(hf, floor) ** 0.25
    )

    # Штраф за ритмичность. Не множитель в общем ряду, а отдельный
    # гаситель: ровный бит - это признак «здесь музыка, а не бой»,
    # и он должен уметь обнулить оценку, даже когда громко и часто.
    if rhythm is not None and len(rhythm) == len(score):
        score = score * (1.0 - 0.85 * np.clip(rhythm, 0.0, 1.0))

    return score.astype(np.float32)


def smooth(values: np.ndarray, seconds: float, hop_seconds: float) -> np.ndarray:
    """Сгладить сигнал скользящим средним."""
    window = max(1, int(seconds / hop_seconds))
    if window <= 1 or len(values) == 0:
        return values.copy()
    kernel = np.ones(window, dtype=np.float32) / window
    return np.convolve(values, kernel, mode="same").astype(np.float32)
