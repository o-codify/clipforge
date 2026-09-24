import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {downloadVideo} from '../src/ytdlp.ts';
test('downloads serialize, cap overrides at 40 Mbps and never cache a failed partial file',async()=>{
  const root=await mkdtemp(join(tmpdir(),'clipforge-download-'));
  try {
    const script=join(root,'fake.mjs'), events=join(root,'events.jsonl');
    await writeFile(script,`import{writeFile,appendFile}from'node:fs/promises';const args=process.argv.slice(2);const target=args[args.indexOf('-o')+1];await appendFile(${JSON.stringify(events)},JSON.stringify({event:'start',args})+'\\n');await new Promise(r=>setTimeout(r,50));await writeFile(target,'test media');await appendFile(${JSON.stringify(events)},JSON.stringify({event:'end'})+'\\n');if(args.at(-1).includes('failure'))process.exit(1);`);
    const opts={command:process.execPath,args:[script],rateLimitKbps:80000};
    await assert.rejects(downloadVideo('https://example.test/failure.mp4',join(root,'failed.mp4'),'best',1,opts));
    await assert.rejects(readFile(join(root,'failed.mp4')));
    await Promise.all(['a','b'].map(id=>downloadVideo(`https://example.test/${id}.mp4`,join(root,`${id}.mp4`),'best',8,opts)));
    const rows=(await readFile(events,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.deepEqual(rows.map(r=>r.event),['start','end','start','end','start','end']);
    for(const row of rows.filter(r=>r.args)){assert.equal(row.args[row.args.indexOf('--limit-rate')+1],'5000000');assert.equal(row.args[row.args.indexOf('-N')+1],'1');assert(row.args.includes('--abort-on-unavailable-fragments'));}
  }finally{await rm(root,{recursive:true,force:true});}
});
