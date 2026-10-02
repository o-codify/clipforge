import {build} from 'esbuild';
import {mkdir,cp,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';

// Explicit allowlist. This archive is served only to enrolled workers. It must
// never include .env files, API handlers, YouTube clients or database credentials.
const root=resolve('.'),out=resolve(process.env.WORKER_BUNDLE_BUILD??'.worker-bundle');
await mkdir(out,{recursive:true});
for(const name of ['remote-agent','remote-task','remote-light-task'])await build({entryPoints:[`apps/worker/src/${name}.ts`],outfile:join(out,name+'.mjs'),bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:"import {createRequire as __cfRequire} from 'node:module'; const require=__cfRequire(import.meta.url);"},logLevel:'warning'});
for(const name of ['container-resources.py','setup-media-protection.py','setup-vision-model.py','vision-model.json','install-worker-deps.py']){
  await mkdir(join(out,'scripts'),{recursive:true});await cp(join(root,'scripts',name),join(out,'scripts',name));
}
if(await stat('vision-runtime').catch(()=>null))await cp('vision-runtime',join(out,'vision-runtime'),{recursive:true});
await cp('workers/python',join(out,'workers','python'),{recursive:true,filter:src=>!/__pycache__|\.pyc$/.test(src)});
await cp('assets',join(out,'assets'),{recursive:true});
await mkdir(join(out,'models'),{recursive:true});
for(const name of ['face_detection_yunet_2023mar.onnx'])await cp(join('models',name),join(out,'models',name));
await writeFile(join(out,'package.json'),JSON.stringify({private:true,type:'module'}));
execFileSync('tar',['-czf',join(root,'worker-bundle.tar.gz'),'-C',out,'.'],{windowsHide:true});
const sum=createHash('sha256');for await(const chunk of createReadStream('worker-bundle.tar.gz'))sum.update(chunk);
await writeFile('worker-bundle.tar.gz.json',JSON.stringify({sha256:sum.digest('hex'),size:(await stat('worker-bundle.tar.gz')).size}));
console.log('Worker package built (no platform credentials).');
