import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PythonWorker} from '@clipforge/pipeline';
import {PAYLOADS,QUEUES,type QueueName} from '@clipforge/jobs';
import type {Context} from './context.js';
import {RemoteClient,RemoteTaskAccess,type Assignment} from './remote-client.js';
import {fetchVod,transcribeVod,analyzeVod,facecamVod,inspectAds,renderRun,runPipeline,type JobReport} from './handlers.js';
import {preparePreview} from './prepare-preview.js';
import {cleanClip} from './clean-clip.js';
import {restoreAudio} from './restore-audio.js';

/** A fresh process per assignment releases speech models and ffmpeg memory.
 * There is deliberately no createContext(), .env loading or database client. */
async function main(){
  const task=JSON.parse(await readFile(process.argv[2]!,'utf8')) as Assignment,client=await RemoteClient.load();
  const root=process.env.MEDIA_BUNDLE_ROOT??process.cwd(),storage=process.env.WORKER_STORAGE??'/storage';
  const log=(message:string)=>{process.send?.({type:'progress',message:message.slice(0,500)});};
  const python=new PythonWorker({pythonBin:process.env.PYTHON_BIN??'/storage/venv/bin/python',workerRoot:join(root,'workers','python'),cwd:root,
    env:{CLIPFORGE_YUNET_MODEL:join(storage,'models','face_detection_yunet_2023mar.onnx')},onEvent:e=>log(e.event==='log'?e.message:e.stage),onStderr:s=>{if(/error|traceback/i.test(s))log(s);}});
  const ctx:Context={remote:new RemoteTaskAccess(client,task),get db():never{throw new Error('Remote worker has no database access');},storage:null,twitch:null,youtube:null,python,log,
    config:{role:'media',databaseUrl:'',pythonBin:process.env.PYTHON_BIN??'/storage/venv/bin/python',workerRoot:join(root,'workers','python'),data:join(storage,'data'),out:join(storage,'out'),
      assets:join(root,'assets','twitch'),models:join(storage,'models'),videoFormat:task.settings.videoFormat,mediaNetworkKbps:task.policy.downloadKbps,renderConcurrency:1,
      speechModel:task.settings.speechModel,speechLanguage:task.settings.speechLanguage,speechBatchSize:1,glossary:task.settings.glossary,clipsPerRun:task.settings.clipsPerRun},close:()=>python.stop()};
  type Handler=(ctx:Context,data:never,report:JobReport)=>Promise<unknown>;
  const handlers:Record<string,Handler>={
    [QUEUES.pipeline]:runPipeline as Handler,[QUEUES.preparePreview]:preparePreview as Handler,[QUEUES.prepareBatchVod]:preparePreview as Handler,
    [QUEUES.fetchVod]:fetchVod as Handler,[QUEUES.transcribeVod]:transcribeVod as Handler,[QUEUES.analyzeVod]:analyzeVod as Handler,[QUEUES.facecamVod]:facecamVod as Handler,
    [QUEUES.inspectAds]:inspectAds as Handler,[QUEUES.renderRun]:renderRun as Handler,[QUEUES.renderVariant]:renderRun as Handler,[QUEUES.cleanClip]:cleanClip as Handler,[QUEUES.restoreAudio]:restoreAudio as Handler};
  try{const handler=handlers[task.queue];if(!handler)throw new Error('Неизвестное задание');
    const data=PAYLOADS[task.queue as QueueName].parse(task.payload);
    const output=await handler(ctx,data as never,{id:String(task.payload.batchId??task.jobId),log,cancelled:async()=>false});
    process.send?.({type:'result',ok:true,output:output??{}});
  }catch(error){process.send?.({type:'result',ok:false,error:String(error).slice(0,2000)});}
  finally{await ctx.close();process.disconnect?.();}
}
main().catch(()=>process.exit(1));
