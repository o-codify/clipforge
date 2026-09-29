// A transient DB/Docker DNS outage must not trigger a rapid restart loop.
export function readinessExpired({startedAt,unreadySince,now,wasReady}) {
  if(unreadySince===null)return false;
  return now-unreadySince>=180_000 && (wasReady || now-startedAt>=180_000);
}
