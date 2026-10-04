import {readdir,lstat,stat,realpath,unlink,mkdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {runMediaCommand} from '@clipforge/pipeline';
import {uploadObject,downloadObject,fileDigest} from './object-transfer.js';

type Request=<T>(path:string,body?:unknown,timeout?:number)=>Promise<T>;
type Asset={name:string;size:number;sha256:string;mtimeNs:string};
const within=(root:string,file:string)=>{const rel=relative(root,file);return !!rel&&!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel);};
export function sourcePath(root:string,name:string){
  if(!name||name.includes('\\')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('Invalid source path');
  const file=resolve(root,name);if(!within(resolve(root),file))throw new Error('Source path escapes workspace');return file;
}
async function noSymlinks(root:string,file:string){
  for(let current=root,parts=relative(root,file).split(sep);parts.length;){current=join(current,parts.shift()!);if((await lstat(current).catch(()=>null))?.isSymbolicLink())throw new Error('Symlink in media workspace');}
}
export async function restoreSources(request:Request,root:string,select:(name:string)=>boolean,kbps:number){
  const assets=await request<Asset[]>('sources');await mkdir(root,{recursive:true});root=await realpath(root);
  for(const asset of assets){
    if(!asset.name.startsWith('data/'))continue;const name=asset.name.slice(5);if(!select(name))continue;
    const file=sourcePath(root,name);await noSymlinks(root,file);
    if(await stat(file).then(async s=>s.size===asset.size&&await fileDigest(file)===asset.sha256).catch(()=>false))continue;
    await downloadObject(async()=>(await request<{url:string}>('sources/read',{name:asset.name,sha256:asset.sha256})).url,file,asset.size,asset.sha256,kbps);
    // Python caches use nanoseconds; JS utimes would lose precision and repeat
    // speech/ad analysis after every restore on another worker.
    const result=await runMediaCommand(process.env.PYTHON_BIN??'python',['-c','import os,sys; n=int(sys.argv[2]); os.utime(sys.argv[1],ns=(n,n))',file,asset.mtimeNs],30000);
    if(result.code!==0)throw new Error('Не удалось восстановить метаданные исходника');
  }
}
async function files(root:string):Promise<string[]>{
  const result:string[]=[];
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    if(entry.isSymbolicLink())throw new Error('Symlink in media cache');
    const path=join(root,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(path);
  }return result;
}
export async function cachedVods(data:string,out:string){
  const found=new Set<string>();
  for(const root of [join(data,'games'),out])for(const game of await readdir(root,{withFileTypes:true}).catch(()=>[]))if(game.isDirectory()&&!game.isSymbolicLink())
    for(const streamer of await readdir(join(root,game.name),{withFileTypes:true}))if(streamer.isDirectory()&&!streamer.isSymbolicLink())
      for(const vod of await readdir(join(root,game.name,streamer.name),{withFileTypes:true}))if(vod.isDirectory()&&!vod.isSymbolicLink()&&/^v\d+$/.test(vod.name)&& (await files(join(root,game.name,streamer.name,vod.name))).length)found.add(vod.name);
  return [...found];
}
export async function archiveWorkspace(request:Request,data:string,out:string,vodId:string,kbps:number,log:(message:string)=>void,beforeArchive?:(name:string,file:string)=>Promise<boolean|void>){
  if(!/^v\d+$/.test(vodId))throw new Error('Invalid VOD');let bytes=0,count=0;
  const archive=async(root:string,prefix:string)=>{
    if(!await stat(root).catch(()=>null))return;
    if((await lstat(root)).isSymbolicLink())throw new Error('Symlink in media cache');
    const boundary=await realpath(root);
    for(const file of await files(boundary)){
      const before=await stat(file,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!before)continue;
      if(before.size){
        const name=prefix+'/'+relative(boundary,file).split(sep).join('/');
        const keep=await beforeArchive?.(name,file);
        if(keep!==false){log(`Сохранение в S3: ${name}`);await uploadObject(request,file,{kind:'cache',name},kbps);}
      }
      const after=await stat(file,{bigint:true}),actual=await realpath(file);
      if(!within(boundary,actual)||after.size!==before.size||after.mtimeNs!==before.mtimeNs)throw new Error('Файл изменился; локальная копия сохранена');
      await unlink(actual);bytes+=Number(before.size);count++;
    }
  };
  for(const [base,prefix] of [[join(data,'games'),'data'],[out,'out']] as const){
    for(const game of await readdir(base,{withFileTypes:true}).catch(()=>[]))if(game.isDirectory()&&!game.isSymbolicLink())
      for(const streamer of await readdir(join(base,game.name),{withFileTypes:true}))if(streamer.isDirectory()&&!streamer.isSymbolicLink()){
        await archive(join(base,game.name,streamer.name,vodId),prefix);
      }
  }
  const versions=await request<{version:string}[]>('operation',{operation:'cache.legacy',input:{}});
  for(const {version} of versions)if(/^[a-f0-9]{12}$/.test(version))for(const kind of ['original-audio','cleaned','protected'])await archive(join(out,kind,version),`out/${kind}/${version}`);
  return {files:count,freedBytes:bytes};
}
