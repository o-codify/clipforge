import { sql } from "drizzle-orm";
import { feedbackMultiplier, labelTrigger, type Candidate } from "@clipforge/pipeline";
import type { Context } from "./context.js";

export async function applyFeedback(ctx: Context, streamer: string, candidates: Candidate[]) {
  const feedback = await ctx.db.execute<{ trigger: string; samples: number; rate: number }>(sql`
    select c.trigger, count(*)::int samples,
      avg(m.views / greatest(1,extract(epoch from (m.collected_at-p.published_at))/3600))::float rate
    from clips c join publications p on p.clip_id=c.id
    join lateral (select * from publication_metrics where publication_id=p.id
      and extended->>'privacy'='public' order by collected_at desc limit 1) m on true
    where c.streamer=${streamer} and c.archived_at is null and p.published_at < now()-interval '24 hours'
      and p.published_at > now()-interval '30 days'
    group by c.trigger`);
  const total=feedback.reduce((n,r)=>n+r.samples,0);
  const baseline=feedback.reduce((n,r)=>n+r.rate*r.samples,0)/Math.max(1,total);
  const multipliers=Object.fromEntries(feedback.map(r=>[r.trigger,feedbackMultiplier(r.samples,r.rate,baseline)]));
  return {
    candidates:candidates.map(c=>({...c,score:c.score*(multipliers[labelTrigger(c)]??1)})),
    evidence:{samples:total,multipliers,mode:total>=5 ? "public-performance" : "signal-baseline"},
  };
}
