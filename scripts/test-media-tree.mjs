import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Windows process recovery test skipped on this host');
  process.exit(0);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const options = { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] };
const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
const started = Date.now();
const root = spawn(process.execPath, ['-e', `
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{windowsHide:true,detached:true,stdio:['ignore','ignore','ignore','ipc']});
  child.once('message',()=>process.send(child.pid));
  setInterval(()=>{},1000);
`], options);
let descendant;
try {
  [descendant] = await once(root, 'message');
  assert.equal(alive(descendant), true, 'The descendant must be running before the crash');
  const exited = once(root, 'exit');
  root.kill();
  await exited;
  assert.equal(alive(descendant), true, 'The test must create an actual orphan');
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./stop-media-tree.ps1', import.meta.url)),
    '-ParentProcess', String(root.pid), '-StartedMilliseconds', String(started)], { windowsHide: true });
  assert.equal(alive(descendant), false, 'Orphaned media descendants must stop');
  assert.equal(alive(unrelated.pid), true, 'Unrelated processes must remain running');
  console.log('Windows recovery: orphan stopped; unrelated process preserved');
} finally {
  for (const pid of [root.pid, descendant, unrelated.pid]) if (pid && alive(pid)) process.kill(pid);
}
