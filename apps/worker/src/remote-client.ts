import {readFile,stat,mkdir,rename} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {pacedStream,waitForResources} from '@clipforge/resources';
import {runMediaCommand} from '@clipforge/pipeline';
import type {RemoteMediaAccess} from './remote-access.js';
import {uploadObject} from './object-transfer.js';
import {restoreSources,archiveWorkspace} from './source-cache.js';

export type RemoteIdentity={origin:string;secret:string;workerId:string};
export type Assignment={leaseId:string;jobId:string;queue:string;payload:Record<string,unknown>;
  settings:{speechModel:string;speechLanguage:string;videoFormat:string;clipsPerRun:number;glossary:string[]};policy:{downloadKbps:number;uploadKbps:number}};
export class RemoteClient {
  constructor(readonly identity:RemoteIdentity){}
  static async load(file=process.env.WORKER_IDENTITY_FILE??'/storage/identity.json'){return new RemoteClient(JSON.parse(await readFile(file,'utf8')) as RemoteIdentity);}
  url(path:string){return `${this.identity.origin}/api/worker-gateway/${path}`;}
  async request<T=unknown>(path:string,body?:unknown,timeout=30000):Promise<T>{
    for(let attempt=0;;attempt++){
      try{const response=await fetch(this.url(path),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.identity.secret}`,...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeout),redirect:'error'});
        if(!response.ok){const message=(await response.text()).slice(0,500);const error=new Error(`Platform ${response.status}: ${message}`);if(response.status<500)throw Object.assign(error,{permanent:true});throw error;}
        const text=await response.text();return (text?JSON.parse(text):null) as T;
      }catch(error){if(attempt>=3||(error as {permanent?:boolean}).permanent)throw error;await delay(500*2**attempt);}
    }
  }
}
export class RemoteTaskAccess implements RemoteMediaAccess {
  constructor(private readonly client:RemoteClient,private readonly assignment:Assignment){}
  private path(suffix:string){return `tasks/${this.assignment.leaseId}/${suffix}`;}
  call<T=unknown>(operation:string,input?:unknown){return this.client.request<T>(this.path('operation'),{operation,input:input??{}});}
  private async upload(clipId:string,kind:'video'|'poster',file:string){
    return (await uploadObject((path,body,timeout)=>this.client.request(this.path(path),body,timeout),file,{clipId,kind,name:clipId+'/'+kind},this.assignment.policy.uploadKbps)).storageKey;
  }
  restoreSources(root:string,select:(name:string)=>boolean){return restoreSources((path,body,timeout)=>this.client.request(this.path(path),body,timeout),root,select,this.assignment.policy.downloadKbps);}
  archiveWorkspace(data:string,out:string,log:(message:string)=>void){return archiveWorkspace((path,body,timeout)=>this.client.request(this.path(path),body,timeout),data,out,String(this.assignment.payload.vodId),this.assignment.policy.uploadKbps,log);}
  async uploadClip(id:string,file:string){
    const poster=file+'.jpg',result=await runMediaCommand('ffmpeg',['-v','error','-y','-ss','2.5','-i',file,'-frames:v','1','-vf','scale=270:-2',poster],60000);
    if(result.code!==0)throw new Error('Не удалось создать обложку');
    const videoKey=await this.upload(id,'video',file),posterKey=await this.upload(id,'poster',poster);return {videoKey,posterKey};
  }
  async downloadClip(id:string,file:string){
    await waitForResources();await mkdir(dirname(file),{recursive:true});
    // Proxies may stream the response without Content-Length. Validate against
    // the platform's scoped clip record, which describes the decoded media.
    const {clip}=await this.call<{clip:{sizeBytes:number}|null}>('clip.get',{id});
    const expected=clip?.sizeBytes;
    if(!expected||!Number.isSafeInteger(expected)||expected<1)throw new Error('Не удалось проверить размер исходного клипа');
    const response=await fetch(this.client.url(this.path(`source/${encodeURIComponent(id)}`)),{headers:{authorization:`Bearer ${this.client.identity.secret}`},signal:AbortSignal.timeout(600000),redirect:'error'});
    if(!response.ok||!response.body)throw new Error('Платформа не передала исходный клип');
    await pipeline(pacedStream(Readable.fromWeb(response.body as never),'download',this.assignment.policy.downloadKbps*125),createWriteStream(file+'.part'));
    if((await stat(file+'.part')).size!==expected)throw new Error('Клип передан не полностью');
    await rename(file+'.part',file);
  }
}
