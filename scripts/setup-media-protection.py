"""Explicit, pinned, bandwidth-limited model installation; never at job startup."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
MODELS=[
    ('dtln/model_1.onnx','https://raw.githubusercontent.com/breizhn/DTLN/1de1f15a8b5b7e1c44905618ff2ef70ca8277fbc/pretrained_model/model_1.onnx','22b91cae3855e5a0620e66a917ca6c82c58db0e842c770f58d86751c5e8d4ae3',1458237),
    ('dtln/model_2.onnx','https://raw.githubusercontent.com/breizhn/DTLN/1de1f15a8b5b7e1c44905618ff2ef70ca8277fbc/pretrained_model/model_2.onnx','e20c92f9233fccf29cddf86970d0d0161a03aebccc26d6f4d5639c4d5ec2e639',2510010),
    ('deepfilter/deep-filter.exe','https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-pc-windows-msvc.exe','75e11fa16445f560cb6b021521ddb89e89270d13b83089705d98776f58fd7915',26912256),
]

def digest(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()

def install(destination,kibps,check=False,dtln_only=False):
    if os.name!='nt' and not dtln_only:
        raise RuntimeError('This pinned executable is for the Windows media worker. Control servers do not need it.')
    for relative,url,sha,size in MODELS:
        if dtln_only and not relative.startswith('dtln/'):continue
        file=destination/relative
        if file.is_file() and file.stat().st_size==size and digest(file)==sha:
            print('Verified:',relative,flush=True);continue
        if check:raise RuntimeError(f'Missing or altered model: {relative}')
        file.parent.mkdir(parents=True,exist_ok=True)
        pending=file.with_suffix(file.suffix+'.part')
        started=time.monotonic();count=0
        request=urllib.request.Request(url,headers={'User-Agent':'ClipForge-model-setup'})
        with urllib.request.urlopen(request,timeout=30) as source,pending.open('wb') as output:
            while chunk:=source.read(16384):
                count+=len(chunk)
                if count>size:raise RuntimeError(f'Unexpected model size: {relative}')
                output.write(chunk)
                time.sleep(max(0,count/(kibps*1024)-(time.monotonic()-started)))
        if count!=size or digest(pending)!=sha:
            raise RuntimeError(f'Model checksum mismatch: {relative}')
        os.replace(pending,file)
        print('Installed:',relative,flush=True)
    for name in ('DTLN-LICENSE.txt','DeepFilterNet-LICENSE-MIT.txt'):
        shutil.copyfile(ROOT/'workers/python/licenses'/name,destination/name)
    import onnxruntime, rapidocr, psutil
    print('Ready: CPU inference, QR/OCR and desktop governor',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--models',type=Path,default=ROOT/'models')
    parser.add_argument('--kibps',type=int,default=256)
    parser.add_argument('--check',action='store_true')
    parser.add_argument('--dtln-only',action='store_true')
    args=parser.parse_args()
    if not 16<=args.kibps<=2048:parser.error('--kibps must be between 16 and 2048')
    install(args.models,args.kibps,args.check,args.dtln_only)
