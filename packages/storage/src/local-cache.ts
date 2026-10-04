import {readdir,lstat,realpath,unlink,rmdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';

export type CacheClip={id:string;vodId:string;runId:string;version:string;file:string;outDir:string;keep:boolean;cloud:{size:number;sha256:string}|null};
export type CacheManifest={activeVods:string[];neededVods:string[];clips:CacheClip[];sources:{vodId:string;name:string;size:number;sha256:string}[];generatedAt:string};
const inside=(root:string,file:string)=>{const p=relative(root,file);return !!p&&p!=='..'&&!p.startsWith('..'+sep)&&!isAbsolute(p);};
export function cacheClip(name:string,clips:CacheClip[]) {
  const path='/'+name.replaceAll('\\','/');
  return clips.find(c=>{
    const out=c.outDir.replaceAll('\\','/'),at=out.lastIndexOf('/out/');
    const aliases=[`/${c.vodId}/${c.runId}/${c.file}`,at>=0?out.slice(at+4)+'/'+c.file:''];
    for(const kind of ['original-audio','cleaned','protected'])aliases.push(`/${kind}/${c.version}/${c.file}`);
    return aliases.filter(Boolean).some(a=>path.endsWith(a)||path.endsWith(a+'.jpg'));
  });
}
/** Only generated media roots are traversed. No symlink, changed file, active
 * VOD or unverified sole copy of an accepted clip may be removed. */
export async function cleanLocalCache(data:string,out:string,manifest:CacheManifest,apply=false) {
  if(Date.now()-Date.parse(manifest.generatedAt)>120000)throw new Error('Refresh the storage manifest before cleanup');
  const result={files:0,bytes:0,kept:0,reasons:{} as Record<string,number>};
  const digest=async(file:string)=>{const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex');};
  for(const [configured,kind] of [[join(data,'games'),'data'],[out,'out']] as const){
    const info=await lstat(configured).catch(()=>null);if(!info)continue;if(info.isSymbolicLink())throw new Error('Symlink cache root');
    const root=await realpath(configured);
    const walk=async(dir:string):Promise<void>=>{
      for(const entry of await readdir(dir,{withFileTypes:true})){
        const file=join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Symlink in media cache');
        if(entry.isDirectory()){await walk(file);if(apply)await rmdir(file).catch(e=>{if(!['ENOTEMPTY','ENOENT'].includes(e.code))throw e;});continue;}
        if(!entry.isFile())continue;
        const name=relative(root,file).split(sep).join('/'),clip=kind==='out'?cacheClip(name,manifest.clips):undefined;
        const vodId=name.split('/').find(p=>/^v\d+$/.test(p))??clip?.vodId;
        if(vodId&&manifest.activeVods.includes(vodId)){result.kept++;continue;}
        const before=await lstat(file,{bigint:true});let reason:string|undefined;
        if(Number(before.mtimeMs)>Date.parse(manifest.generatedAt)){result.kept++;continue;}
        if(kind==='out'){
          if(!clip||!clip.keep)reason=clip?'rejected':'unreferenced-output';
          else if(clip.cloud){
            if(name.endsWith('.jpg'))reason='cloud-poster';
            else if(Number(before.size)===clip.cloud.size&&await digest(file)===clip.cloud.sha256)reason='verified-cloud';
          }
        }else if(vodId&&!manifest.neededVods.includes(vodId))reason='expired-source';
        else if(vodId){
          const parts=name.split('/'),at=parts.indexOf(vodId),asset=manifest.sources.find(a=>a.vodId===vodId&&a.name==='data/'+parts.slice(at+1).join('/'));
          if(asset&&asset.size===Number(before.size)&&await digest(file)===asset.sha256)reason='verified-cloud';
        }
        if(!reason){result.kept++;continue;}
        const actual=await realpath(file),after=await lstat(file,{bigint:true});
        if(!inside(root,actual)||after.isSymbolicLink()||after.size!==before.size||after.mtimeNs!==before.mtimeNs)throw new Error('Media file changed during cleanup');
        if(apply)await unlink(file);
        result.files++;result.bytes+=Number(before.size);result.reasons[reason]=(result.reasons[reason]??0)+1;
      }
    };await walk(root);
  }
  return result;
}
