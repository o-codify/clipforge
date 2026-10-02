import {and, eq, isNull} from 'drizzle-orm';
import type {Database} from './client.js';
import {platformAccounts, streamers} from './schema.js';

export const DEFAULT_YOUTUBE_CHANNEL = 'UC-P-55QVYfT8SBtGnCNAtog';

/** Never silently send to another channel when the chosen one is disconnected. */
export async function youtubeDestination(db:Database, login:string) {
  const [streamer] = await db.select({channel:streamers.youtubeChannelId}).from(streamers).where(eq(streamers.login,login));
  const channelId=streamer?.channel??DEFAULT_YOUTUBE_CHANNEL;
  const [account]=await db.select({id:platformAccounts.id,label:platformAccounts.label,externalId:platformAccounts.externalId})
    .from(platformAccounts).where(and(eq(platformAccounts.platform,'youtube'),eq(platformAccounts.externalId,channelId),isNull(platformAccounts.disconnectRequestedAt)));
  return {channelId,inherited:!streamer?.channel,account:account??null};
}
