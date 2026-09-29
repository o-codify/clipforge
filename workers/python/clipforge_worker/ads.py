"""QR and text-banner screening, with conservative review of unknown artwork.

We cover detected regions with opaque pixels BEFORE crop/scale/background.
No model can establish absence of every possible advertisement from a stream.
"""
import re
import math
from pathlib import Path
import cv2
import numpy as np

AD_WORDS = re.compile(r'(?i)(?:winline|win\s*line|bet\s*boom|1\s*x\s*bet|1win|pari\.?ru|gg\.?bet|fonbet|f[o0]n\s*bet|free\s*bet|promo\s*(?:code|код)|промокод|фрибет|казино|casino|stake\.com|[+]?\d+\s*%\s*(?:bonus|бонус))')
SPOKEN_AD = re.compile(r'(?i)(?:по\s+(?:моему|нашему)\s+промокоду|регистрируйтесь\s+по\s+(?:моей\s+)?ссылке|(?:забирай|получи|получите)\s+(?:свой\s+)?фрибет)')
_ocr = None


def text_engine():
    global _ocr
    if _ocr is None:
        from rapidocr import RapidOCR
        _ocr = RapidOCR(params={'EngineConfig.onnxruntime.intra_op_num_threads': 2,
                               'EngineConfig.onnxruntime.inter_op_num_threads': 1,
                               'Global.log_level': 'error'})
    return _ocr


def rectangle(points, width, height, pad=12):
    points = np.asarray(points).reshape(-1, 2)
    x = max(0, int(np.floor(points[:, 0].min()))-pad)
    y = max(0, int(np.floor(points[:, 1].min()))-pad)
    right = min(width, int(np.ceil(points[:, 0].max()))+pad+1)
    bottom = min(height, int(np.ceil(points[:, 1].max()))+pad+1)
    return dict(x=x, y=y, w=right-x, h=bottom-y)


def overlap(a, b, padding=12):
    return (a['x'] <= b['x']+b['w']+padding and b['x'] <= a['x']+a['w']+padding and
            a['y'] <= b['y']+b['h']+padding and b['y'] <= a['y']+a['h']+padding)


def merge_regions(regions):
    result = []
    for region in regions:
        current = dict(region)
        # Transitive union, including animated QR/banner positions.
        again = True
        while again:
            again = False
            for other in list(result):
                if overlap(current, other):
                    x, y = min(current['x'], other['x']), min(current['y'], other['y'])
                    right = max(current['x']+current['w'], other['x']+other['w'])
                    bottom = max(current['y']+current['h'], other['y']+other['h'])
                    current = dict(x=x, y=y, w=right-x, h=bottom-y)
                    result.remove(other); again = True
        result.append(current)
    return result


def banner_box(frame, box):
    """Prefer a containing rectangular banner; otherwise cover text+margin."""
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    contours, _ = cv2.findContours(cv2.Canny(gray, 60, 160), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if w*h < box['w']*box['h']*1.15 or w*h > width*height*.22:
            continue
        if x <= box['x']+8 and y <= box['y']+8 and x+w >= box['x']+box['w']-8 and y+h >= box['y']+box['h']-8:
            if cv2.contourArea(contour) >= w*h*.65:
                candidates.append((w*h, rectangle([[x,y],[x+w,y+h]],width,height,8)))
    return min(candidates, key=lambda c: c[0])[1] if candidates else box


def detect_frame(frame, ocr=True):
    height, width = frame.shape[:2]
    regions, kinds, evidence = [], [], []
    detector = cv2.QRCodeDetector()
    # Full frame plus quadrants preserve small corner QR codes at native scale.
    views = [(frame, 0, 0)]
    if width >= 1000:
        for x, y in [(0,0),(width//2,0),(0,height//2),(width//2,height//2)]:
            views.append((frame[y:min(height,y+height//2+32),x:min(width,x+width//2+32)],x,y))
    for view, x, y in views:
        found, points = detector.detectMulti(view)
        if found and points is not None:
            for polygon in points:
                regions.append(rectangle(polygon+np.array([x,y]),width,height,16))
                kinds.append('qr')
    if ocr:
        result = text_engine()(frame)
        if result.boxes is not None:
            for polygon, text, score in zip(result.boxes, result.txts, result.scores):
                if score >= .65 and AD_WORDS.search(text):
                    box = rectangle(polygon,width,height,24)
                    regions.append(banner_box(frame,box)); kinds.append('banner'); evidence.append(text)
    return dict(regions=merge_regions(regions), kinds=kinds, evidence=evidence)


def scan_ads(video, start, end, transcript='', extra_regions=None, *, verified_profile=False):
    if not 0 <= start < end or end-start > 180:
        raise ValueError('Ad scanning accepts clips of at most 180 seconds')
    cv2.setNumThreads(2)
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise ValueError('Cannot open video for ad screening')
    width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    regions, evidence, qr_hits, banner_hits, frames = [], set(), 0, 0, 0
    try:
        if width <= 0 or height <= 0:
            raise ValueError('Invalid video dimensions')
        for r in extra_regions or []:
            if any(not isinstance(r.get(k), int) or isinstance(r[k], bool) for k in ('x','y','w','h')) or \
               r['x']<0 or r['y']<0 or r['w']<=0 or r['h']<=0 or r['x']+r['w']>width or r['y']+r['h']>height:
                raise ValueError('Mask must be inside the video frame')
            regions.append(dict(r))
        # Sequential decode avoids seeking to an earlier keyframe and
        # decoding the same GOP again for every quarter-second sample.
        fps=cap.get(cv2.CAP_PROP_FPS)
        if not math.isfinite(fps) or fps<=0:
            raise ValueError('Invalid video frame rate')
        cap.set(cv2.CAP_PROP_POS_MSEC,start*1000)
        next_frame=0
        # A verified VOD map already classifies banners and rejects chat/HUD.
        # Do not override that decision with keyword-only OCR on individual clips.
        # QR detection remains active for brief/animated codes between VOD samples.
        for index in range(math.ceil((end-start)*4)):
            target=round(index*fps/4)
            ok=True
            while next_frame<=target:
                ok=cap.grab();next_frame+=1
                if not ok:break
            if ok:ok,frame=cap.retrieve()
            if not ok:
                if index < (end-start)*4-4:
                    raise ValueError('Video could not be fully screened')
                break
            found = detect_frame(frame, ocr=not verified_profile and index % 4 == 0)
            regions.extend(found['regions']); evidence.update(found['evidence'])
            qr_hits += found['kinds'].count('qr'); banner_hits += found['kinds'].count('banner'); frames += 1
    finally:
        cap.release()
    if not frames:
        raise ValueError('No video frames were screened')
    regions = merge_regions(regions)
    area = sum(r['w']*r['h'] for r in regions)/(width*height)
    spoken = bool(SPOKEN_AD.search(transcript))
    return dict(regions=regions, qrHits=qr_hits, bannerHits=banner_hits, frames=frames,
                evidence=sorted(evidence), coverage=area, reject=area > .3 or spoken,
                reason='Рекламная речь' if spoken else 'Реклама занимает большую часть кадра' if area > .3 else None,
                requiresReview=True, sampleFps=4, ocrFps=0 if verified_profile else 1)
