import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, utimes, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retainWebAssets} from './web-assets.mjs';
test('keeps chunks from concurrent releases and expires only old unused chunks',async()=>{
  const root=await mkdtemp(join(tmpdir(),'clipforge-assets-'));
  try {
    for(const dir of ['old/chunks','new/chunks','shared/chunks'])await mkdir(join(root,dir),{recursive:true});
    await writeFile(join(root,'old/chunks/old.js'),'old');
    await writeFile(join(root,'new/chunks/new.js'),'new');
    await writeFile(join(root,'shared/chunks/expired.js'),'expired');
    const old=new Date(Date.now()-31*86400_000);await utimes(join(root,'shared/chunks/expired.js'),old,old);
    await retainWebAssets(join(root,'old'),join(root,'shared'));
    await retainWebAssets(join(root,'new'),join(root,'shared'));
    assert.equal(await readFile(join(root,'shared/chunks/old.js'),'utf8'),'old');
    assert.equal(await readFile(join(root,'shared/chunks/new.js'),'utf8'),'new');
    await assert.rejects(readFile(join(root,'shared/chunks/expired.js')));
  }finally{await rm(root,{recursive:true,force:true});}
});
