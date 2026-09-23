import { randomBytes } from "node:crypto";
import { BadRequestException, Controller, Get, Inject, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { accounts, streamers, runtimeValue, type Database } from "@clipforge/db";
import { CONFIG, DATABASE, type ApiConfig } from "../config.js";
import { CurrentViewer } from "./auth.guard.js";
import type { Viewer } from "./auth.service.js";

@Controller("api/twitch")
export class TwitchController {
  constructor(@Inject(DATABASE) private readonly db: Database, @Inject(CONFIG) private readonly config: ApiConfig) {}
  private credentials() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new BadRequestException("Twitch не настроен администратором");
    return { clientId, clientSecret, redirectUri: `${this.config.webOrigin}/api/twitch/callback` };
  }
  @Post("connect")
  async connect(@CurrentViewer() viewer: Viewer) {
    const {clientId, redirectUri} = this.credentials();
    const state = randomBytes(32).toString("hex");
    await runtimeValue(this.db, `twitch-oauth:${state}`, {accountId:viewer.accountId});
    await this.db.execute(sql`delete from platform_runtime where key like 'twitch-oauth:%' and updated_at < now() - interval '10 minutes'`);
    return { url: `https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({client_id:clientId, redirect_uri:redirectUri, response_type:"code", scope:"", state, force_verify:"true"})}` };
  }
  @Get("callback")
  async callback(@CurrentViewer() viewer: Viewer, @Query("code") code: string, @Query("state") state: string, @Res() reply: FastifyReply) {
    try {
      if (!code || !state) throw new Error("Отказ от подключения");
      const pending = await this.db.execute(sql`delete from platform_runtime where key = ${`twitch-oauth:${state}`}
        and value->>'accountId' = ${viewer.accountId} and updated_at > now() - interval '10 minutes' returning key`);
      if (!pending.length) throw new Error("Подключение устарело");
      const {clientId,clientSecret,redirectUri} = this.credentials();
      const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {method:"POST", signal:AbortSignal.timeout(15000),
        body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,code,grant_type:"authorization_code",redirect_uri:redirectUri})});
      if (!tokenResponse.ok) throw new Error("Twitch отклонил авторизацию");
      const token = await tokenResponse.json() as {access_token:string};
      const identity = await fetch("https://api.twitch.tv/helix/users", {signal:AbortSignal.timeout(15000), headers:{"Client-Id":clientId, Authorization:`Bearer ${token.access_token}`}});
      if (!identity.ok) throw new Error("Не удалось подтвердить Twitch");
      const data = await identity.json() as {data:{id:string;login:string;display_name:string;profile_image_url:string}[]};
      const user = data.data[0];
      if (!user) throw new Error("Канал не найден");
      await this.db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(740020)`);
        const [owner] = await tx.select().from(accounts).where(and(eq(accounts.streamer,user.login),sql`${accounts.id} <> ${viewer.accountId}`));
        if(owner) throw new Error("Канал уже связан с аккаунтом");
        await tx.insert(streamers).values({login:user.login,twitchId:user.id,displayName:user.display_name,avatar:user.profile_image_url,state:"active",source:"owner"})
          .onConflictDoUpdate({target:streamers.login,set:{twitchId:user.id,displayName:user.display_name,avatar:user.profile_image_url}});
        await tx.update(accounts).set({streamer:user.login}).where(eq(accounts.id,viewer.accountId));
      });
      return reply.redirect(`${this.config.webOrigin}/me?twitch=connected`,302);
    } catch {
      return reply.redirect(`${this.config.webOrigin}/me?twitch=failed`,302);
    }
  }
}
