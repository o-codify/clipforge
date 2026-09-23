import Link from "next/link";
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
        <span className={styles.status}>Закрытая разработка</span>
        <Link className={styles.login} href="/login">Войти <span aria-hidden="true">↗</span></Link>
      </header>
      <main id="public-content" className={styles.content}>{children}</main>
      <footer className={styles.footer}>
        <span>ClipForge</span>
        <nav aria-label="Информация о ClipForge">
          <Link href="/about" aria-current={current === "/about" ? "page" : undefined}>О платформе</Link>
          <Link href="/privacy" aria-current={current === "/privacy" ? "page" : undefined}>Конфиденциальность</Link>
          <Link href="/terms" aria-current={current === "/terms" ? "page" : undefined}>Условия использования</Link>
          <a href="mailto:mr.sagrin@gmail.com">Связаться</a>
        </nav>
      </footer>
    </div>
  );
}
