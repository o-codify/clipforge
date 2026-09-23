import { platformAccounts, runtimeValue } from "@clipforge/db";
import { refreshAccessToken, myChannel } from "@clipforge/youtube";
import { createContext } from "./context.js";
import { collectMetrics } from "./metrics.js";

const ctx = createContext();
try {
  if (ctx.twitch) {
    const games = await ctx.twitch.topGames(3);
    console.log(JSON.stringify({ service:"twitch", ok:true, categories:games.map(g=>g.name) }));
  } else console.log(JSON.stringify({ service:"twitch", ok:false, reason:"Приложение не настроено" }));
  const accounts = await ctx.db.select().from(platformAccounts);
  for (const account of accounts.filter(a=>a.platform === "youtube")) {
    try {
      if (!ctx.youtube || !account.credentials.refreshToken) throw new Error("Нет настроенного приложения или refresh token");
      const token = await refreshAccessToken(ctx.youtube,account.credentials.refreshToken);
      const channel = await myChannel(token);
      if (channel?.id !== account.externalId) throw new Error("Подключение принадлежит другому каналу");
      await runtimeValue(ctx.db,"youtube-access",{state:"ok",channel:channel.title});
      console.log(JSON.stringify({service:"youtube",ok:true,channel:channel.title}));
    } catch(error) {
      await runtimeValue(ctx.db,"youtube-access",{state:"error",reason:String(error)});
      console.log(JSON.stringify({service:"youtube",ok:false,reason:String(error)}));
    }
  }
  try { await collectMetrics(ctx); } catch(error) { console.log(JSON.stringify({service:"youtube-metrics",ok:false,reason:String(error)})); }
} finally { await ctx.close(); }
