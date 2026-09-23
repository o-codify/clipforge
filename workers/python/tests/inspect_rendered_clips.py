"""Decode actual outputs, collect beginning/middle/end frames for visual review."""
import json, pathlib, cv2, subprocess, sys
rows=json.loads(pathlib.Path('data/reviews/active-clips.json').read_text(encoding='utf-8'))
for row in rows:
    if len(sys.argv)>1 and row['streamer']!=sys.argv[1]:continue
    file=pathlib.Path(row['outDir'])/row['file']
    subprocess.run(['ffmpeg','-hide_banner','-v','error','-i',str(file),'-f','null','-'],check=True)
    cap=cv2.VideoCapture(str(file)); frames=[]
    assert cap.get(cv2.CAP_PROP_FRAME_WIDTH)==1080 and cap.get(cv2.CAP_PROP_FRAME_HEIGHT)==1920
    for t in [1,row['duration']/2,row['duration']-1]:
        cap.set(cv2.CAP_PROP_POS_MSEC,t*1000); ok,frame=cap.read(); assert ok
        frame=cv2.resize(frame,(270,480));cv2.putText(frame,f'{row["streamer"]} {t:.1f}s',(8,18),cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
        frames.append(frame)
    cap.release()
    out=pathlib.Path('data/reviews')/f'actual-{row["streamer"]}.jpg'
    cv2.imwrite(str(out),cv2.hconcat(frames));print(str(out),flush=True)
