"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/session";
import { AccountSettings } from "@/components/AccountSettings";
import { toast } from "@/lib/toast";
export default function MePage(){
  const {viewer}=useSession();const router=useRouter();
  useEffect(()=>{const params=new URLSearchParams(window.location.search);if(params.has("youtube")){router.replace(`/settings/publication?${params}`);return;}if(params.has("twitch")){toast.info(params.get("twitch")==="connected"?"Twitch подключён":"Не удалось подключить Twitch");router.replace("/me");}},[router]);
  return <AccountSettings viewer={viewer}/>;
}
