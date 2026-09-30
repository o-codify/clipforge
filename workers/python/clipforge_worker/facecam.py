"""Conservative camera detection. Per-clip verification takes precedence over VOD hints.
Eye landmarks are checked without requiring a visible mouth (masks may obscure it).
Uncertain or missing detections disable the separate camera panel.
"""
from __future__ import annotations

import logging
import tempfile
from collections.abc import Sequence
from functools import lru_cache
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

# Путь к модели задаёт вызывающая сторона. Воркер не должен угадывать
# раскладку проекта по своему расположению: он получает пути и возвращает
# числа, а где что лежит - знает бэкенд.
MODEL_ENV = "CLIPFORGE_YUNET_MODEL"
MODEL_NAME = "face_detection_yunet_2023mar.onnx"


def default_model_path() -> Path:
    """Модель из переменной окружения, иначе из каталога models проекта."""
    import os

    override = os.environ.get(MODEL_ENV)
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[3] / "models" / MODEL_NAME


@dataclass(slots=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def clamped(self, width: int, height: int) -> "Rect":
        x = max(0, min(self.x, width - 1))
        y = max(0, min(self.y, height - 1))
        return Rect(x, y, min(self.w, width - x), min(self.h, height - y))

    def as_crop(self) -> str:
        return f"crop={self.w}:{self.h}:{self.x}:{self.y}"


@dataclass(slots=True)
class FacecamResult:
    """Итог поиска. found=False - камеры нет или её не удалось найти."""

    found: bool
    rect: Rect | None = None
    face: Rect | None = None
    confidence: float = 0.0
    samples: int = 0
    hits: int = 0
    tracked: int = 0
    safe_windows: list[dict[str, float]] = field(default_factory=list)
    note: str = ""


class SampleFrames(Sequence):
    """Lossless scratch storage: hundreds of 1080p frames do not live in RAM.

    Keep source pixels and sample indices unchanged (small masked faces matter).
    The temporary file is removed on close, including an exception during decode.
    """
    def __init__(self):
        self.file = tempfile.TemporaryFile(prefix='clipforge-frames-')
        self.offsets = []

    def append(self, frame):
        self.file.seek(0, 2)
        self.offsets.append(self.file.tell())
        np.save(self.file, frame, allow_pickle=False)

    def __len__(self):
        return len(self.offsets)

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[i] for i in range(*index.indices(len(self))) ]
        self.file.seek(self.offsets[index])
        return np.load(self.file, allow_pickle=False)

    def close(self):
        self.file.close()


def grab_frames(
    video: Path | str, count: int = 40, skip_edges: float = 0.04, start: float | None = None, end: float | None = None
) -> SampleFrames:
    """Достать кадры, равномерно раскиданные по всей длине файла.

    Края пропускаются: в начале и конце стрима обычно заставка, стартовый
    экран или «спасибо за просмотр», и камеры там может не быть.
    """
    import cv2

    capture = cv2.VideoCapture(str(video))
    if not capture.isOpened():
        raise RuntimeError(f"не удалось открыть видео: {video}")

    total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    frames = SampleFrames()

    try:
        if total <= 0:
            # Некоторые контейнеры не отдают число кадров - читаем подряд.
            for _ in range(count):
                ok, frame = capture.read()
                if not ok: break
                frames.append(frame)
            return frames
        fps = float(capture.get(cv2.CAP_PROP_FPS))
        if start is not None and end is not None:
            if fps <= 0 or end <= start: return frames
            lo, hi = max(0, int(start * fps)), min(total - 1, int(end * fps) - 1)
            if hi < lo: return frames
        else:
            lo, hi = int(total * skip_edges), int(total * (1 - skip_edges))
        for position in np.linspace(lo, hi, count).astype(int):
            capture.set(cv2.CAP_PROP_POS_FRAMES, int(position))
            ok, frame = capture.read()
            if ok: frames.append(frame)
        return frames
    except BaseException:
        frames.close()
        raise
    finally:
        capture.release()


def _detect_faces(frames: Sequence, min_score: float = 0.75,
                  model_path: Path | str | None = None) -> list[tuple[Rect, float, int]]:
    """Прогнать детектор по кадрам. Возвращает найденные лица с оценками."""
    import cv2

    model = Path(model_path) if model_path else default_model_path()
    if not model.exists():
        raise FileNotFoundError(
            f"нет модели детектора лиц: {model}\n"
            "скачай её командой:\n"
            "  curl -L -o models/face_detection_yunet_2023mar.onnx "
            "https://github.com/opencv/opencv_zoo/raw/main/models/"
            "face_detection_yunet/face_detection_yunet_2023mar.onnx"
        )

    found: list[tuple[Rect, float, int]] = []
    detector = None

    for frame_index, frame in enumerate(frames):
        height, width = frame.shape[:2]
        if detector is None:
            detector = cv2.FaceDetectorYN.create(
                str(model), "", (width, height), score_threshold=min_score
            )
            detector.setInputSize((width, height))

        try:
            _, faces = detector.detect(frame)
        except cv2.error:
            continue
        if faces is None:
            continue

        for face in faces:
            x, y, w, h, *_rest = face[:14]
            score = float(face[-1])
            if w < 16 or h < 20 or not valid_eye_landmarks(face):
                continue
            found.append((Rect(int(x), int(y), int(w), int(h)), score, frame_index))
    return found


def valid_eye_landmarks(face) -> bool:
    """Use paired eyes and head geometry; a mouth/nose may be covered."""
    x, y, w, h = map(float, face[:4])
    left, right = sorted([face[4:6], face[6:8]], key=lambda p: p[0])
    return (w > 0 and h > 0 and 0.45 < w / h < 1.8
            and x <= left[0] < right[0] <= x + w
            and y <= left[1] <= y + h * .72
            and y <= right[1] <= y + h * .72
            and .18 * w <= right[0] - left[0] <= .8 * w
            and abs(right[1] - left[1]) < .3 * h)


def _dominant_cluster(detections, tolerance: float = .06, frame_w: int = 1280):
    """Count distinct sampled frames, never multiple faces in one frame."""
    best, best_score = [], 0.0
    for anchor, _, _ in detections:
        per_frame = {}
        for rect, score, frame_index in detections:
            if (abs(rect.cx-anchor.cx) < frame_w*tolerance
                    and abs(rect.cy-anchor.cy) < frame_w*tolerance
                    and .6 < rect.w/anchor.w < 1.65):
                if frame_index not in per_frame or score > per_frame[frame_index][1]:
                    per_frame[frame_index] = (rect, score)
        if len(per_frame) > len(best):
            best = [r for r, _ in per_frame.values()]
            best_score = float(np.mean([score for _, score in per_frame.values()]))
    return best, best_score


def _cam_rect_from_face(face: Rect, frame_w: int, frame_h: int) -> Rect:
    """Границы вебки по пропорциям лица.

    Числа взяты из типичной посадки человека перед камерой: немного
    места над головой, заметно больше под ней (плечи), около одной
    ширины лица по бокам. Пропорции «лицо - торс» у людей устойчивы,
    поэтому оценка переносится с одного стримера на другого.

    Пробовал вместо этого искать настоящие границы по временнОй
    изменчивости пикселей: игровая сцена между далёкими кадрами меняется
    целиком, а фон вебки нет. На практике не разделяется - замер на этом
    VOD дал разброс 27.5 в зоне камеры против 34.5 в зоне игры, всего
    25% разницы, и связная область расползается на весь кадр. Подробности
    в DECISIONS.md.
    """
    x = int(face.x - face.w * 0.85)
    y = int(face.y - face.h * 0.30)
    w = int(face.w * 2.7)
    h = int(face.h * 2.3)

    x, y = max(0, x), max(0, y)
    return Rect(x, y, min(w, frame_w - x), min(h, frame_h - y))


def _recover_small_faces(frames, detections, group, model_path=None):
    """Re-examine the established camera region at higher resolution.

    A 35px profile can disappear in the full-frame detector for one frame.
    Recovery still requires an actual face with eye landmarks in that frame;
    neither interpolation nor a cached VOD rectangle counts as a detection.
    """
    import cv2
    anchor = Rect(*(int(np.median([getattr(r, key) for r in group])) for key in ('x','y','w','h')))
    height, width = frames[0].shape[:2]
    roi = Rect(max(0, anchor.x-anchor.w*2), max(0, anchor.y-anchor.h),
               anchor.w*5, anchor.h*3).clamped(width, height)
    matches = lambda r: (abs(r.cx-anchor.cx)<anchor.w*1.2 and abs(r.cy-anchor.cy)<anchor.h
                         and .6<r.w/anchor.w<1.65)
    covered = {i for r,_,i in detections if matches(r)}
    recovered = list(detections)
    for i,frame in enumerate(frames):
        if i in covered:
            continue
        patch = frame[roi.y:roi.y+roi.h,roi.x:roi.x+roi.w]
        luma=cv2.cvtColor(patch,cv2.COLOR_BGR2LAB)
        luma[:,:,0]=cv2.createCLAHE(clipLimit=2.0,tileGridSize=(4,4)).apply(luma[:,:,0])
        normalized=cv2.cvtColor(luma,cv2.COLOR_LAB2BGR)
        for image,scale in ((patch,2),(patch,3),(normalized,2),(normalized,3)):
            enlarged = cv2.resize(image,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC)
            # Local search is constrained by the established head location and
            # size; masked faces need a lower model score than a full-frame scan.
            found = _detect_faces([enlarged],min_score=.6,model_path=model_path)
            candidates = [(Rect(roi.x+int(r.x/scale),roi.y+int(r.y/scale),
                                int(r.w/scale),int(r.h/scale)),score) for r,score,_ in found]
            candidates = [(r,score) for r,score in candidates if matches(r)]
            if candidates:
                r,score=max(candidates,key=lambda item:item[1])
                recovered.append((r,score,i))
                break
    return recovered


def _track_short_gaps(frames, detections, group, max_gap_frames):
    """Verify brief detector misses by matching the head from BOTH neighbours.

    This examines the missing frame itself. Long absences, a scene change or
    a blank camera cannot be filled by copying the last known rectangle.
    """
    import cv2
    by_frame={}
    for rect,score,i in detections:
        if any(rect==r for r in group) and (i not in by_frame or score>by_frame[i][1]):
            by_frame[i]=(rect,score)
    @lru_cache(maxsize=3)
    def gray(index):
        return cv2.cvtColor(frames[index],cv2.COLOR_BGR2GRAY)
    height,width=gray(0).shape
    recovered=list(detections)
    tracked=0
    for i in range(len(frames)):
        if i in by_frame:continue
        left=max((n for n in by_frame if n<i),default=-1)
        right=min((n for n in by_frame if n>i),default=len(frames))
        if left<0 or right==len(frames) or right-left-1>max_gap_frames:continue
        matches=[]
        for neighbour in (left,right):
            r,_=by_frame[neighbour]
            face_rect=r
            # Track the head silhouette as well as the visible face. Hair and
            # mask remain useful features while a hand briefly covers the eyes.
            r=Rect(max(0,r.x-r.w//4),max(0,r.y-r.h//2),int(r.w*1.5),int(r.h*1.5)).clamped(width,height)
            template=gray(neighbour)[r.y:r.y+r.h,r.x:r.x+r.w]
            if template.size==0 or np.std(template)<8:break
            roi=Rect(max(0,r.x-r.w//2),max(0,r.y-r.h//2),r.w*2,r.h*2).clamped(width,height)
            area=gray(i)[roi.y:roi.y+roi.h,roi.x:roi.x+roi.w]
            if area.shape[0]<r.h or area.shape[1]<r.w:break
            _,correlation,_,location=cv2.minMaxLoc(cv2.matchTemplate(area,template,cv2.TM_CCOEFF_NORMED))
            if correlation>=.8:
                matches.append((Rect(face_rect.x+roi.x+location[0]-r.x,face_rect.y+roi.y+location[1]-r.y,face_rect.w,face_rect.h),correlation))
                continue
            # A hand can obscure part of a masked face. Require surviving head
            # features to agree forward AND backward, plus image similarity.
            if correlation<.5:break
            corners=cv2.goodFeaturesToTrack(template,40,.01,3)
            if corners is None or len(corners)<8:break
            points=corners+np.array([r.x,r.y],dtype=np.float32)
            moved,status,error=cv2.calcOpticalFlowPyrLK(gray(neighbour),gray(i),points,None,winSize=(15,15),maxLevel=2)
            if moved is None:break
            returned,back_status,_=cv2.calcOpticalFlowPyrLK(gray(i),gray(neighbour),moved,None,winSize=(15,15),maxLevel=2)
            if returned is None:break
            good=(status.ravel()==1)&(back_status.ravel()==1)&(error.ravel()<20)&(np.linalg.norm(returned-points,axis=2).ravel()<1.5)
            if np.count_nonzero(good)<6 or np.mean(good)<.5:break
            original=points[good,0]; delta=moved[good,0]-original
            translation=np.median(delta,axis=0)
            if np.median(np.linalg.norm(delta-translation,axis=1))>3:break
            if np.ptp(original[:,0])<r.w*.25 or np.ptp(original[:,1])<r.h*.25:break
            matches.append((Rect(int(face_rect.x+translation[0]),int(face_rect.y+translation[1]),face_rect.w,face_rect.h),float(np.mean(good))))
        if len(matches)!=2:continue
        a,b=matches[0][0],matches[1][0]
        if abs(a.cx-b.cx)>a.w*.3 or abs(a.cy-b.cy)>a.h*.3:continue
        recovered.append((a,min(score for _,score in matches),i));tracked+=1
    return recovered,tracked


def find_facecam(
    video: Path | str,
    samples: int = 40,
    min_hit_ratio: float = 0.7,
    model_path: Path | str | None = None,
    start: float | None = None, end: float | None = None,
    reference_rect: Rect | None = None,
    game: str | None = None,
) -> FacecamResult:
    """Найти вебку в видео.

    min_hit_ratio - какая доля кадров должна дать согласованное лицо,
    чтобы считать камеру найденной.Низкий порог даст ложную камеру на
    случайных срабатываниях, слишком высокий - отвергнет камеру у
    стримера, который часто отходит от экрана.
    """
    frames = grab_frames(video, samples, start=start, end=end)
    try:
        return _find_facecam_frames(frames,samples,min_hit_ratio,model_path,start,end,reference_rect,game)
    finally:
        if hasattr(frames,'close'): frames.close()


def _find_facecam_frames(frames,samples,min_hit_ratio,model_path,start,end,reference_rect,game):
    if not frames:
        return FacecamResult(False, note="не удалось прочитать кадры")

    frame_h, frame_w = frames[0].shape[:2]
    detections = _detect_faces(frames, model_path=model_path)
    if reference_rect is not None:
        # A video watched inside a stream may contain another, clearer face.
        # Follow the persistent source camera, not the largest secondary face.
        roi=reference_rect.clamped(frame_w,frame_h)
        detections=[(r,s,i) for r,s,i in detections if roi.x<=r.cx<=roi.x+roi.w and roi.y<=r.cy<=roi.y+roi.h]
        # The reference only limits the search; every recovered frame still
        # needs fresh detector evidence inside it.
        hint=Rect(int(roi.x+roi.w*.315),int(roi.y+roi.h*.13),max(16,int(roi.w/2.7)),max(20,int(roi.h/2.3)))
        detections=_recover_small_faces(frames,detections,[hint],model_path)
        detections=[(r,s,i) for r,s,i in detections if roi.x<=r.cx<=roi.x+roi.w and roi.y<=r.cy<=roi.y+roi.h]

    if (game or '').lower().replace('_', ' ') == 'dota 2':
        # Animated hero portraits in the top scoreboard pass face/eye and motion
        # checks. Their tiny boxes inside the HUD strip are not a webcam.
        detections = [(r, s, i) for r, s, i in detections
                      if not (r.cy < frame_h * .06 and r.h < frame_h * .06)]
    if not detections:
        return FacecamResult(
            False, samples=len(frames), note="лиц не найдено - вероятно, камеры нет"
        )

    group, score = _dominant_cluster(detections, frame_w=frame_w)
    initial_hits = len(group)
    if len(group) >= 3 and .1 <= len(group)/len(frames) < 1:
        detections = _recover_small_faces(frames,detections,group,model_path)
        group, score = _dominant_cluster(detections, frame_w=frame_w)
    tracked=0
    if start is not None and end is not None and len(frames)>1 and len(group)/len(frames)>=.7:
        interval=(end-start)/(len(frames)-1)
        max_gap_frames=int(1.05/interval)
        if max_gap_frames:
            detections,tracked=_track_short_gaps(frames,detections,group,max_gap_frames)
            group,score=_dominant_cluster(detections,frame_w=frame_w)
    ratio = len(group) / len(frames)
    safe_windows=[]
    if start is not None and end is not None and len(frames)==samples and len(frames)>1:
        covered={i for r,_,i in detections if any(r==g for g in group)}
        step=(end-start)/(len(frames)-1)
        first=None
        for i in range(len(frames)+1):
            if i in covered:
                if first is None:first=i
            elif first is not None:
                # Leave half a sample at each edge; only offer useful, stable
                # footage, not isolated detections that happen to be adjacent.
                lo=start+(first+.5)*step
                hi=start+(i-1-.5)*step
                if hi-lo>=12:safe_windows.append({'start':lo,'end':hi})
                first=None

    if ratio < min_hit_ratio or (start is not None and len(frames) != samples):
        return FacecamResult(
            False, samples=len(frames), hits=len(group), tracked=tracked, confidence=score,
            safe_windows=safe_windows,
            note=f"находки неустойчивы ({len(group)}/{len(frames)} кадров) - похоже на ложные срабатывания",
        )

    # Медиана устойчивее среднего: одно случайное попадание внутрь группы
    # не сдвинет результат.
    face = Rect(
        int(np.median([r.x for r in group])),
        int(np.median([r.y for r in group])),
        int(np.median([r.w for r in group])),
        int(np.median([r.h for r in group])),
    )
    # Reject a static portrait/HUD. Check head movement, not unrelated gameplay.
    import cv2
    patches = [cv2.resize(f[max(0,face.y):min(frame_h,face.y+face.h), max(0,face.x):min(frame_w,face.x+face.w)], (32,32)).astype(float) for f in frames]
    motion = float(np.mean(np.std(np.stack(patches), axis=0)))
    if motion < 2.0:
        return FacecamResult(False, samples=len(frames), hits=len(group), note="область неподвижна — отдельный блок камеры отключён")
    # Verification must not enlarge the composition. Preserve the established
    # camera crop, or use the median head, never a union of all head positions.
    cam = (reference_rect or _cam_rect_from_face(face, frame_w, frame_h)).clamped(frame_w, frame_h)
    if start is not None and any(r.x < cam.x or r.y < cam.y or r.x+r.w > cam.x+cam.w
           or r.y+r.h > cam.y+cam.h for r in group):
        return FacecamResult(False, samples=len(frames), hits=len(group),
                             note="лицо выходит за границы камеры — отдельный блок отключён")

    return FacecamResult(
        found=True, rect=cam, face=face, confidence=score,
        samples=len(frames), hits=len(group),
        tracked=tracked,
        note=f"Камера подтверждена в {len(group)} из {len(frames)} кадров; повторный поиск: {len(group)-initial_hits-tracked}, отслеживание между соседними находками: {tracked}",
    )
