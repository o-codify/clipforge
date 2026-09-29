"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "@/lib/session";
import { PageScroll } from "@/components/PageScroll";
export default function SettingsLayout({children}:{children:React.ReactNode}) {
  const {viewer}=useSession();const path=usePathname();
  if(!viewer.isAdmin)return null;
  return <><nav className="page-toolbar settings-tabs" aria-label="Управление платформой">{[["/settings","Платформа"],["/settings/publication","Публикации"],["/settings/accounts","Аккаунты"]].map(([href,label])=><Link key={href} href={href!} aria-current={path===href?"page":undefined}>{label}</Link>)}</nav>{path==="/settings/accounts"?children:<PageScroll>{children}</PageScroll>}</>;
}
