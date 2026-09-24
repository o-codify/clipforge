import { mkdir, readdir, copyFile, rename, stat, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

// Hashed Next assets must outlive their container: an open browser can still
// request an old chunk, and either container can receive a request during rollout.
export async function retainWebAssets(source, destination, now = Date.now()) {
  await mkdir(destination, {recursive:true});
  const current = new Set();
  async function copy(dir) {
    for (const entry of await readdir(dir, {withFileTypes:true})) {
      const file = join(dir,entry.name);
      if (entry.isDirectory()) { await copy(file); continue; }
      if (!entry.isFile()) continue;
      const name = relative(source,file);
      current.add(name);
      const target = join(destination,name);
      await mkdir(join(target,'..'),{recursive:true});
      const temp = `${target}.${randomUUID()}.tmp`;
      await copyFile(file,temp);
      await rename(temp,target);
    }
  }
  await copy(source);
  async function prune(dir) {
    for (const entry of await readdir(dir,{withFileTypes:true})) {
      const file=join(dir,entry.name);
      if(entry.isDirectory()) {await prune(file);continue;}
      if(!entry.isFile() || current.has(relative(destination,file))) continue;
      const info=await stat(file).catch(()=>null);
      if(info && now-info.mtimeMs>30*86400_000) await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});
    }
  }
  await prune(destination);
}
