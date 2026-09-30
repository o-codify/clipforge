import { sql } from "drizzle-orm";
import { feedbackMultiplier, labelTrigger, type Candidate } from "@clipforge/pipeline";
import type { Context } from "./context.js";
import { youtubeDerivedMetricsAllowed, runtimeValue } from "@clipforge/db";

export async function applyFeedback(ctx: Context, streamer: string, candidates: Candidate[], game?:string|null) {
  if(!await youtubeDerivedMetricsAllowed(ctx.db))return {candidates,evidence:{samples:0,multipliers:{},mode:"signal-baseline"}};
  const feedback = await ctx.db.execute<{ trigger: string; samples: number; rate: number }>(sql`
    select c.trigger, count(*)::int samples,
      avg(m.views / greatest(1,extract(epoch from (m.collected_at-p.published_at))/3600))::float rate
    from clips c join publications p on p.clip_id=c.id
    join lateral (select * from publication_metrics where publication_id=p.id
      and extended->>'privacy'='public' and views is not null
      and collected_at>=p.published_at+interval '24 hours' and collected_at<=p.published_at+interval '48 hours'
      order by collected_at,id limit 1) m on true
    where c.streamer=${streamer} ${game?sql`and c.game=${game}`:sql``}
      and c.archived_at is null and p.status='published' and p.privacy='public' and p.published_at < now()-interval '24 hours'
      and p.published_at > now()-interval '21 days'
    group by c.trigger`);
  const total=feedback.reduce((n,r)=>n+r.samples,0);
  const baseline=feedback.reduce((n,r)=>n+r.rate*r.samples,0)/Math.max(1,total);
  const multipliers=Object.fromEntries(feedback.map(r=>[r.trigger,feedbackMultiplier(r.samples,r.rate,baseline)]));
  const evidence={samples:total,multipliers,mode:feedback.some(r=>r.samples>=5)?'public-performance':'signal-baseline'};
  await runtimeValue(ctx.db,'feedback:'+streamer,{...evidence,streamer,game,groups:feedback.filter(r=>r.samples>=5).length});
  return {
    candidates:candidates.map(c=>({...c,score:c.score*(multipliers[labelTrigger(c)]??1)})),
    evidence,
  };
}
