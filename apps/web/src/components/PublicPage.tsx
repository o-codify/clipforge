import Link from "next/link";
import Image from "next/image";
import styles from "./PublicPage.module.css";

export { styles as publicStyles };

export function PublicPage({ children, current }: {
  children: React.ReactNode;
  current: "/about" | "/privacy" | "/terms";
}) {
  return (
    <div className={styles.page}>
      <a className={styles.skip} href="#public-content">К содержимому</a>
      <header className={styles.header}>
        <Link className={styles.brand} href="/about" aria-label="ClipForge — о платформе">
          <span className={styles.mark} aria-hidden="true">C<span>F</span></span>
          ClipForge
        </Link>
        <span className={styles.status}>Моменты эфиров</span>
        <Link className={styles.login} href="/login">Войти <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="public-content" className={styles.content}>{children}</main>
      <footer className={styles.footer}>
        <a className={styles.channel} href="https://www.youtube.com/channel/UC-P-55QVYfT8SBtGnCNAtog" aria-label="Наш канал на YouTube — Кузня Клипов">
          <span>Наш канал</span>
          <Image src="/branding/youtube-logo-white.png" alt="YouTube" width={1705} height={573} unoptimized />
        </a>
        <nav aria-label="Информация о ClipForge">
          <Link href="/about" aria-current={current === "/about" ? "page" : undefined}>О платформе</Link>
          <Link href="/privacy" aria-current={current === "/privacy" ? "page" : undefined}>Конфиденциальность</Link>
          <Link href="/terms" aria-current={current === "/terms" ? "page" : undefined}>Условия использования</Link>
          <a href="mailto:admin@clanvelt.com">Связаться</a>
        </nav>
      </footer>
    </div>
  );
}
