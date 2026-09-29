import Link from "next/link";

/** One canvas and one masthead system for public pages and the workspace. */
export function SiteCanvas() {
  return <div className="site-canvas" aria-hidden="true">
    <svg viewBox="0 0 1440 1000" preserveAspectRatio="none"><path d="M0 0 1440 1000M0 1000 1440 0M240 0 960 1000M1200 0 480 1000M0 380 1440 720"/></svg>
  </div>;
}

export function SiteBrand({ href = "/" }: { href?: string }) {
  return <Link href={href} className="workspace-brand" aria-label="ClipForge — главная">
    <span className="brand-mark" aria-hidden>CF</span><span>ClipForge</span>
  </Link>;
}

export function PageIdentity({ title, index, area }: { title: string; index: string; area: string }) {
  return <div className="workspace-heading">
    <span className="page-index" aria-hidden="true">{index}</span>
    <div className="page-identity"><span>{area}</span><h1>{title}</h1></div>
    <span className="page-registration" aria-hidden="true">+</span>
  </div>;
}
