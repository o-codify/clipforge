import { Blobatar } from "@blobatar/react";
import { happy, idle, sad, sleepy } from "blobatar/expression";

const moods={idle,working:idle,success:happy,error:sad,paused:sleepy};
/** Authored identity: a violet editing companion with headphones and a clipped frame. */
export function Mascot({mood,size=58}:{mood:keyof typeof moods;size?:number}){
  return <span className="cfa-mascot" style={{width:size,height:size}} aria-hidden="true">
    <Blobatar name="forge-companion-v1" size={size} animate="always" expression={moods[mood]}
      palette={{head:"#a970ff",eye:"#160a29"}}
      traits={{shape:0.48,"body.r":0.9,"eye.ratio":0.16,"eye.gap":0.7}}/>
    <svg className="cfa-mascot-gear" viewBox="0 0 100 100" fill="none">
      <path d="M20 52V43C20 24 33 15 50 15S80 24 80 43V52" stroke="#e2ceff" strokeWidth="5" strokeLinecap="round"/>
      <rect x="13" y="43" width="11" height="22" rx="5" fill="#392057" stroke="#bf94ff" strokeWidth="2"/>
      <rect x="76" y="43" width="11" height="22" rx="5" fill="#392057" stroke="#bf94ff" strokeWidth="2"/>
      <path d="M81 62V69Q81 77 63 77" stroke="#e2ceff" strokeWidth="3" strokeLinecap="round"/>
      <rect x="55" y="73" width="12" height="7" rx="3.5" fill="#f0e7ff"/>
      <path d="M42 9H56L50 18H36Z" fill="#9146ff"/>
    </svg>
  </span>;
}

