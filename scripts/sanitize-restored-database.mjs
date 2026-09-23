// Run with the deployed image, after pg_restore and before starting services.
import {createDatabase,sanitizeRestoredYoutubeData} from '../packages/db/dist/index.js';
const url=process.env.DATABASE_URL;
if(!url)throw new Error('DATABASE_URL is required');
const target=decodeURIComponent(new URL(url).pathname.slice(1));
if(process.argv[2]!==`--confirm-database=${target}`)throw new Error('Pass --confirm-database=<restored database name>. This clears restored YouTube data and pauses automation.');
const db=createDatabase({url});
const lease=await db.sql.reserve();
const acquired=[];
try {
  for(const key of [740021,740023,740022]){
    const [lock]=await lease`select pg_try_advisory_lock(${key}) as ok`;
    if(!lock.ok)throw new Error('Stop the application and media worker before sanitizing a restored database');
    acquired.push(key);
  }
  await sanitizeRestoredYoutubeData(db);
  console.log('Restored YouTube credentials, API metadata and statistics cleared; automation paused. Source clips and platform accounts preserved. Reconnect YouTube explicitly before publishing.');
} finally {
  for(const key of acquired.reverse())await lease`select pg_advisory_unlock(${key})`;
  lease.release();await db.close();
}
