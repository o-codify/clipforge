import type { ReactNode } from "react";
import { Button, Pill } from "./ui";
export function SettingsCard({title,status,tone="",children,actions}:{title:string;status:string;tone?:""|"ok"|"warn"|"bad";children?:ReactNode;actions?:ReactNode}) {
  return <section className="settings-card"><header><h2>{title}</h2><Pill tone={tone}>{status}</Pill></header>{children&&<div className="settings-card-body">{children}</div>}{actions&&<footer>{actions}</footer>}</section>;
}
export function LoadError({message,retry}:{message:string;retry:()=>void}) {
  return <div className="load-error" role="alert"><span className="load-error-icon" aria-hidden>!</span><div><strong>{message}</strong><p>Попробуйте загрузить данные ещё раз.</p></div><Button onClick={retry}>Повторить</Button></div>;
}
