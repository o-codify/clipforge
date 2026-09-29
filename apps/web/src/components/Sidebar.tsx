"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { workspaceLinks, activeSection, sectionNumber } from "@/lib/navigation";
import { SiteBrand } from "./SiteFrame";
import { useSession } from "@/lib/session";
import { useJobs } from "@/lib/jobs";

const icons: Record<string, React.ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  clips: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4Z"/></>,
  streamers: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  games: <><path d="M7 7h10c3 0 5 11 3 12-2 2-5-3-6-3h-4c-1 0-4 5-6 3C2 18 4 7 7 7Z"/><path d="M7 10v4m-2-2h4m7-1h.01m2 3h.01"/></>,
  jobs: <><path d="M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1"/></>,
  settings: <><path d="m12 3 3 2 3 .5.5 3 2 3-2 3-.5 3-3 .5-3 2-3-2-3-.5-.5-3-2-3 2-3 .5-3L9 5Z"/><circle cx="12" cy="11.5" r="3"/></>,
};

export function Sidebar() {
  const { viewer } = useSession();
  const { jobs } = useJobs();
  const section = activeSection(usePathname());
  const pending = jobs.filter(job => ["active", "created", "retry"].includes(job.state)).length;
  const links = workspaceLinks(viewer);
  return <aside className="workspace-sidebar">
    <SiteBrand />
    <div className="sidebar-caption">Рабочее пространство</div>
    <nav aria-label="Разделы платформы">
      {links.map(item => <Link key={item.href} href={item.href} className="workspace-nav-link" aria-label={item.label} title={item.label} aria-current={section === (item.href.startsWith("/streamers/") ? "/streamers" : item.href) ? "page" : undefined}>
        <span className="nav-index" aria-hidden="true">{sectionNumber(item.href)}</span>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{icons[item.icon] ?? icons.streamers}</svg>
        <span className="nav-label">{item.label}</span>{item.href === "/jobs" && pending > 0 && <span className="nav-count">{pending}</span>}
      </Link>)}
    </nav>
    <div className="sidebar-footer"><span className="sidebar-caption">Из эфира — в короткий клип</span><Link href="/about" title="О ClipForge"><span aria-hidden>ⓘ</span><span className="nav-label">О платформе</span></Link></div>
  </aside>;
}
