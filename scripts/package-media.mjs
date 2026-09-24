// Runs in GitHub Actions. The PC only extracts and runs this prepared bundle.
import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output=resolve('dist/media');
await mkdir(`${output}/apps/worker/dist`,{recursive:true});
await build({entryPoints:['apps/worker/src/main.ts'],outfile:`${output}/apps/worker/dist/main.mjs`,
  bundle:true,platform:'node',target:'node22',format:'esm',external:['pg-native','aws-crt'],
  banner:{js:"import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);"}});
await cp('workers/python',`${output}/workers/python`,{recursive:true,filter:path=>!path.includes('__pycache__')&&!path.endsWith('.pyc')});
await cp('scripts/media-pc.mjs',`${output}/supervisor.mjs`);
await cp('scripts/stop-media-tree.ps1',`${output}/stop-media-tree.ps1`);
await cp('scripts/run-media-limited.py',`${output}/run-media-limited.py`);
await writeFile(`${output}/release.json`,JSON.stringify({release:process.env.GITHUB_SHA,entry:'apps/worker/dist/main.mjs'}));
console.log('Prepared media runtime without a compiler or package manager requirement on the PC');
