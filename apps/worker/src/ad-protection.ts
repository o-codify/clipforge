import { eq } from 'drizzle-orm';
import { vods } from '@clipforge/db';
import type { Context } from './context.js';
import type { JobReport } from './handlers.js';
import { dirname, join } from 'node:path';

export async function ensureAdProfile(ctx:Context,vodId:string,video:string,report:JobReport,bounded=false) {
  const [row]=await ctx.db.select({adProtection:vods.adProtection}).from(vods).where(eq(vods.id,vodId));
  if(!row)throw new Error('Эфир не найден');
  report.log('Проверяю карту рекламы эфира');
  const profile=await ctx.python.call('profileAds',{video,directory:join(dirname(video),'ad-protection'),cached:bounded?null:row.adProtection});
  if(await report.cancelled())throw new Error('Проверка рекламы отменена');
  // A sampled prefix cannot certify or replace the map of the entire broadcast.
  if(!bounded)await ctx.db.update(vods).set({adProtection:profile}).where(eq(vods.id,vodId));
  report.log(`Карта рекламы эфира готова: ${profile.samples} кадров, ${profile.regions.length} областей`);
  return profile;
}
