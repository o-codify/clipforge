import Link from "next/link";
import { SiteBrand, SiteCanvas } from "./SiteFrame";
import styles from "./PublicPage.module.css";

export { styles as publicStyles };

export function PublicPage({ children, current }: {
  children: React.ReactNode;
  current: "/about" | "/privacy" | "/terms" | "/login";
}) {
  return <div className={`site-frame public-shell ${styles.page}`}>
    <SiteCanvas />
    <a className="workspace-skip" href="#public-content">К содержимому</a>
    <header className="public-header">
      <SiteBrand href="/about" />
      <span className="public-status">Моменты эфиров</span>
      {current !== "/login" && <Link className="masthead-action" href="/login">Войти</Link>}
    </header>
    <main id="public-content" className={styles.content}>{children}</main>
    <footer className={styles.footer}>
      <a className={styles.channel} href="https://www.youtube.com/channel/UC-P-55QVYfT8SBtGnCNAtog" aria-label="Наш канал на YouTube — Кузня Клипов">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24"><rect x="1" y="4" width="22" height="16" rx="5" fill="currentColor"/><path d="m10 8 7 4-7 4Z" fill="#ed0037"/></svg>
        <span>Кузня Клипов <span className={styles.channelPlatform}>/ YouTube</span></span>
      </a>
      <nav aria-label="Информация о ClipForge">
        <Link href="/about" aria-current={current === "/about" ? "page" : undefined}>О платформе</Link>
        <Link href="/privacy" aria-current={current === "/privacy" ? "page" : undefined}>Конфиденциальность</Link>
        <Link href="/terms" aria-current={current === "/terms" ? "page" : undefined}>Условия использования</Link>
        <a href="mailto:admin@clanvelt.com">Связаться</a>
      </nav>
    </footer>
  </div>;
}
