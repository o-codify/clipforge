"""Conservative, game-aware HUD localisation, independent of streamer identity.

Coordinates come from the video, not streamer presets. Dota maps are located
by clusters of small coloured map markers; PUBG maps by the HUD grid and player
marker. Every sampled frame must confirm the same map before it is extracted.
Unknown games are deliberately unsupported rather than guessing a camera/ad.
"""
from dataclasses import dataclass, field
from pathlib import Path
import cv2
import numpy as np

from .facecam import Rect, grab_frames


@dataclass
class MinimapResult:
    found: bool = False
    rect: Rect | None = None
    confidence: float = 0
    hits: int = 0
    samples: int = 0
    profile: str = "unsupported"
    note: str = ""
    evidence: dict = field(default_factory=dict)


def _components(mask, min_area=3, max_area=100):
    count, _, stats, centers = cv2.connectedComponentsWithStats(mask.astype(np.uint8),8)
    return [(float(centers[i,0]),float(centers[i,1]),int(stats[i,4]))
            for i in range(1,count) if min_area<=stats[i,4]<=max_area
            and stats[i,2]<=18 and stats[i,3]<=18 and .25<stats[i,2]/stats[i,3]<4]


def _markers(image):
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    hue,sat,value=cv2.split(hsv)
    bright=(sat>150)&(value>150)
    masks=[bright&((hue<10)|(hue>172)),bright&(hue>38)&(hue<90),
           bright&(hue>132)&(hue<171)]
    return [_components(mask) for mask in masks]


def _clusters(points,distance):
    pending=set(range(len(points))); groups=[]
    while pending:
        group=[pending.pop()]; todo=list(group)
        while todo:
            i=todo.pop()
            neighbours={j for j in pending if np.linalg.norm(np.array(points[i][:2])-points[j][:2])<distance}
            pending-=neighbours;todo.extend(neighbours);group.extend(neighbours)
        groups.append([points[i] for i in group])
    return groups


def _edge_refine(image,box,margin=14):
    """Refine a marker/grid proposal against actual rectangular HUD edges."""
    h,w=image.shape[:2]
    x,y,bw,bh=box
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY).astype(np.float32)
    dx=np.abs(np.diff(gray,axis=1));dy=np.abs(np.diff(gray,axis=0))
    def strongest(values,guess,limit):
        lo=max(1,int(guess-margin));hi=min(limit-1,int(guess+margin))
        if hi<=lo:return max(0,min(limit,int(guess)))
        return lo+int(np.argmax(values[lo:hi]))+1
    # Average over the inner span so a single nearby icon cannot move the edge.
    ys=slice(max(0,int(y+bh*.1)),min(h,int(y+bh*.9)))
    xs=slice(max(0,int(x+bw*.1)),min(w,int(x+bw*.9)))
    vx=np.mean(dx[ys,:],axis=0);hy=np.mean(dy[:,xs],axis=1)
    left=0 if x<margin else strongest(vx,x,w)
    right=w if w-(x+bw)<margin else strongest(vx,x+bw,w)
    top=strongest(hy,y,h)
    bottom=h if h-(y+bh)<margin else strongest(hy,y+bh,h)
    return Rect(left,top,right-left,bottom-top)


def _overlaps(a,b):
    if b is None:return 0
    return max(0,min(a.x+a.w,b.x+b.w)-max(a.x,b.x))*max(0,min(a.y+a.h,b.y+b.h)-max(a.y,b.y))/(a.w*a.h)


def _iou(a,b):
    intersection=_overlaps(a,b)*a.w*a.h
    return intersection/(a.w*a.h+b.w*b.h-intersection)


def _dota_proposals(image):
    h,w=image.shape[:2]
    points=[p for color in _markers(image) for p in color
            if p[1]>h*.66 and (p[0]<w*.26 or p[0]>w*.74)]
    boxes=[]
    for cluster in _clusters(points,h*.068):
        if len(cluster)<12:continue
        xy=np.array([p[:2] for p in cluster]);lo=xy.min(axis=0);hi=xy.max(axis=0)
        width,height=hi-lo
        if not (.6<width/max(height,1)<1.5 and h*.12<max(width,height)<h*.34):continue
        margin=h*.014
        side=max(width,height)+2*margin
        left=lo[0]-margin if lo[0]<w/2 else hi[0]+margin-side
        box=(left,hi[1]+margin-side,side,side)
        boxes.append(_edge_refine(image,box,int(h*.035)))
    return boxes


def _grid_proposals(image):
    h,w=image.shape[:2]
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    lines=cv2.HoughLinesP(cv2.Canny(gray,45,110),1,np.pi/180,30,
                          minLineLength=int(h*.14),maxLineGap=8)
    if lines is None:return []
    boxes=[]
    for x1,y1,x2,y2 in np.asarray(lines).reshape(-1,4):
        x1,y1,x2,y2=map(int,(x1,y1,x2,y2))
        if min(y1,y2)<h*.6 or min(x1,x2)<w*.68:continue
        length=abs(y2-y1)
        if abs(x1-x2)<=2 and h*.16<length<h*.32 and x1>w*.88:
            boxes.append(_edge_refine(image,(x1-length*1.1,min(y1,y2),length*1.1,length),12))
    return boxes


def _dota_score(image):
    groups=_markers(image)
    counts=[len(g) for g in groups]
    points=[p for g in groups for p in g]
    if len(points)<12:return 0,{'markers':counts}
    h,w=image.shape[:2];xy=np.array([p[:2] for p in points])
    spread=(np.ptp(xy[:,0])/w,np.ptp(xy[:,1])/h)
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    dark_terrain=float(np.mean((hsv[:,:,2]<150)&(hsv[:,:,2]>18)))
    valid=min(spread)>.6 and dark_terrain>.4 and sum(n>=3 for n in counts)>=2
    return (min(1,len(points)/30)*.4+min(spread)*.4+.2 if valid else 0),{'markers':counts,'spread':spread,'terrain':dark_terrain}


def _grid_score(image):
    h,w=image.shape[:2];gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    # Grid lines can be too faint for Canny. Require a small luminance edge
    # along at least 75% of a row/column, and regular spacing in both axes.
    gray=gray.astype(np.float32)
    def grid_lines(values):
        candidates=np.flatnonzero(values>.75)
        candidates=candidates[(candidates>len(values)*.12)&(candidates<len(values)*.88)]
        groups=[]
        for value in candidates:
            if not groups or value-groups[-1][-1]>4:groups.append([])
            groups[-1].append(int(value))
        positions=[round(float(np.mean(g))) for g in groups]
        if len(positions)<3:return []
        gaps=np.diff(positions)
        return positions if np.std(gaps)/np.mean(gaps)<.2 else []
    vertical=grid_lines(np.mean(np.abs(np.diff(gray,axis=1))>2,axis=0))
    horizontal=grid_lines(np.mean(np.abs(np.diff(gray,axis=0))>2,axis=1))
    hsv=cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    player=(hsv[:,:,0]>18)&(hsv[:,:,0]<40)&(hsv[:,:,1]>130)&(hsv[:,:,2]>150)
    markers=[p for p in _components(player,max_area=240) if w*.2<p[0]<w*.8 and h*.2<p[1]<h*.8]
    valid=len(vertical)>=3 and len(horizontal)>=3 and bool(markers)
    return (.9 if valid else 0),{'vertical':vertical,'horizontal':horizontal,'playerMarkers':len(markers)}


def _same_map(a,b):
    # Compression and configurable team colours can weaken individual cues.
    # Recheck the actual pixels against independently confirmed map frames.
    # Tiled comparison prevents a partly covered map being accepted from an
    # otherwise similar background.
    a=cv2.GaussianBlur(cv2.cvtColor(a,cv2.COLOR_BGR2GRAY),(3,3),0)
    b=cv2.GaussianBlur(cv2.cvtColor(b,cv2.COLOR_BGR2GRAY),(3,3),0)
    if min(np.std(a),np.std(b))<5:return False
    if float(cv2.matchTemplate(a,b,cv2.TM_CCOEFF_NORMED)[0,0])<.82:return False
    h,w=a.shape
    for row in range(3):
        for col in range(3):
            aa=a[row*h//3:(row+1)*h//3,col*w//3:(col+1)*w//3]
            bb=b[row*h//3:(row+1)*h//3,col*w//3:(col+1)*w//3]
            if np.std(bb)>8 and (np.std(aa)<3 or float(cv2.matchTemplate(aa,bb,cv2.TM_CCOEFF_NORMED)[0,0])<.45):return False
    return True


def detect_minimap(frames,game,exclude_rect=None):
    game=game.lower().replace(' ','_').replace(':','')
    profile='dota2' if game in ('dota_2','dota2') else 'pubg' if game in ('pubg_battlegrounds','pubg') else 'unsupported'
    result=MinimapResult(profile=profile,samples=len(frames))
    if profile=='unsupported':
        result.note='Для этой игры проверенный детектор мини-карты пока не настроен';return result
    if not frames:result.note='Нет кадров для проверки карты';return result
    original_h,original_w=frames[0].shape[:2];scale=720/original_h
    # Resize on demand, with bounded cache; do not retain 200 full HUD frames.
    from collections.abc import Sequence
    from functools import lru_cache
    source=frames
    class ResizedFrames(Sequence):
        def __len__(self): return len(source)
        @lru_cache(maxsize=3)
        def frame(self,index): return cv2.resize(source[index],(round(original_w*scale),720))
        def __getitem__(self,index):
            if isinstance(index,slice): return [self.frame(i) for i in range(*index.indices(len(self)))]
            if index>=len(self): raise IndexError(index)
            return self.frame(index)
    frames=ResizedFrames()
    exclude=Rect(*(round(v*scale) for v in (exclude_rect.x,exclude_rect.y,exclude_rect.w,exclude_rect.h))) if exclude_rect else None
    propose=_dota_proposals if profile=='dota2' else _grid_proposals
    score=_dota_score if profile=='dota2' else _grid_score
    proposals=[]
    proposal_frames=frames[::max(1,len(frames)//5)]
    for i,frame in enumerate(proposal_frames):proposals.extend((box,i) for box in propose(frame))
    best=None
    for box,_ in proposals:
        box=box.clamped(frames[0].shape[1],720)
        if min(box.w,box.h)<90 or not .88<box.w/box.h<1.2 or _overlaps(box,exclude)>.03:continue
        # A temporary cover must not redefine a smaller remaining piece of the
        # map as its full boundary. Require a repeatable HUD rectangle first.
        support={i for other,i in proposals if _iou(box,other)>.85}
        # PUBG's faint outer border is often lost in compression. Two clear
        # boundary observations suffice, but grid/appearance must still pass
        # on every frame. Dota's marker boundary must have majority support.
        required=max(1,len(proposal_frames)*.6) if profile=='dota2' else min(2,len(proposal_frames))
        if len(support)<required:continue
        scores=[];details=[];patches=[]
        for frame in frames:
            patch=frame[box.y:box.y+box.h,box.x:box.x+box.w].copy();patches.append(patch)
            value,evidence=score(patch);scores.append(value);details.append(evidence)
        confirmed=[i for i,s in enumerate(scores) if s>=.65]
        if len(confirmed)>=max(2,len(frames)*.4):
            for i in range(len(frames)):
                if i in confirmed:continue
                detail=details[i]
                cues=(sum(detail.get('markers',[]))>=12 and min(detail.get('spread',[0]))>.6
                      and detail.get('terrain',0)>.4) if profile=='dota2' else detail['playerMarkers']>0
                if not cues:continue
                nearest=sorted(confirmed,key=lambda j:abs(j-i))[:2]
                if all(_same_map(patches[i],patches[j]) for j in nearest):
                    scores[i]=.85;detail['verifiedByAppearance']=nearest
        hits=int(sum(s>=.65 for s in scores))
        rank=(hits,float(np.mean(scores)),box.w*box.h)
        if best is None or rank>best[0]:best=(rank,box,scores,details)
    if best:
        rank,box,scores,details=best
        result.hits=rank[0];result.confidence=rank[1];result.evidence={'frames':details}
        if result.hits==len(frames):
            result.found=True
            result.rect=Rect(*(round(v/scale) for v in (box.x,box.y,box.w,box.h)))
    result.note=(f'Мини-карта подтверждена в {result.hits}/{result.samples} кадров' if result.found
                 else f'Мини-карта не подтверждена ({result.hits}/{result.samples}); отдельный блок скрыт')
    return result


def find_minimap(video: Path | str,game: str,start: float,end: float,samples: int=12,exclude_rect: Rect | None=None):
    frames=grab_frames(video,samples,start=start,end=end)
    try:
        result=detect_minimap(frames,game,exclude_rect)
        if len(frames)!=samples:result.found=False;result.rect=None;result.note='Не все кадры карты прочитаны'
        return result
    finally:
        if hasattr(frames,'close'): frames.close()
