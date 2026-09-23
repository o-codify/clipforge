"""Download only a bounded HLS VOD excerpt, at <= 5,000,000 bytes/s."""
import re,subprocess,urllib.request,urllib.parse,time,pathlib,json,sys
vod,start,folder=sys.argv[1],float(sys.argv[2]),pathlib.Path(sys.argv[3]);folder.mkdir(parents=True,exist_ok=True)
r=subprocess.run([sys.executable,'-m','yt_dlp','--no-update','-f','720p60/720p/best','-g','https://www.twitch.tv/videos/'+vod.lstrip('v')],capture_output=True,text=True,check=True)
url=r.stdout.strip().splitlines()[0]
manifest=urllib.request.urlopen(url,timeout=30).read().decode()
if '#EXT-X-KEY' in manifest:raise RuntimeError('Encrypted segments unsupported by this bounded review downloader')
position=0;duration=0;selected=[]
for line in manifest.splitlines():
 if line.startswith('#EXTINF:'):duration=float(line.split(':')[1].split(',')[0])
 elif line and not line.startswith('#'):
  if position+duration>start and position<start+75:selected.append((urllib.parse.urljoin(url,line),position,duration))
  position+=duration
if not selected:raise RuntimeError('No segments in requested window')
began=time.monotonic();received=0
with (folder/'source.ts').open('wb') as out:
 init=re.search(r'#EXT-X-MAP:URI="([^"]+)"',manifest)
 transfers=([(urllib.parse.urljoin(url,init.group(1)),0,0)] if init else [])+selected
 for segment,_,_ in transfers:
  with urllib.request.urlopen(segment,timeout=30) as response:
   while data:=response.read(65536):
    out.write(data);received+=len(data)
    time.sleep(max(0,received/5000000-(time.monotonic()-began)))
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(folder/'source.ts'),'-c','copy','-y',str(folder/'source.mp4')],check=True)
(folder/'source.ts').unlink()
(folder/'source.json').write_text(json.dumps({'vodId':vod,'start':selected[0][1],'duration':sum(x[2] for x in selected),'bytes':received}))
print(json.dumps({'vod':vod,'seconds':sum(x[2] for x in selected),'MB':round(received/1e6,1),'file':str(folder/'source.mp4')}))
