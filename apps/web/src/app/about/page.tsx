import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage, publicStyles as s } from "@/components/PublicPage";

export const metadata: Metadata = {
  title: "О платформе — ClipForge",
  description: "ClipForge анализирует эфиры Twitch, находит интересные моменты и готовит короткие клипы для публикации.",
  alternates: { canonical: "https://clipforge.clanvelt.com/about" },
};

export default function AboutPage() {
  return <PublicPage current="/about">
    <section className={s.hero}>
      <p className={s.eyebrow}>Из эфира — в короткий клип</p>
      <h1>У интересного момента<br />должно быть продолжение.</h1>
      <p>ClipForge анализирует эфиры Twitch, выбирает моменты и собирает короткие видео с субтитрами. Результаты публикаций помогают выбирать следующие эфиры и улучшать отбор.</p>
      <div className={s.actions}>
        <Link href="/login" className={s.primary}>Войти в платформу <span aria-hidden="true">↗</span></Link>
        <a href="mailto:mr.sagrin@gmail.com" className={s.secondary}>Связаться с командой</a>
      </div>
    </section>
    <section className={s.steps} aria-label="Как работает ClipForge">
      <article className={s.step}><span>01 / Отбор</span><h2>Находит интересные эфиры</h2><p>Следит за популярностью стримеров, игр и контента. Собирает очередь для анализа.</p></article>
      <article className={s.step}><span>02 / Монтаж</span><h2>Готовит короткие видео</h2><p>Обрабатывает запись, распознаёт речь и компонует кадр с учётом камеры и игрового экрана.</p></article>
      <article className={s.step}><span>03 / Обратная связь</span><h2>Сравнивает результаты</h2><p>Собирает просмотры и реакции на опубликованные видео, чтобы улучшать следующие попытки.</p></article>
    </section>
    <section className={s.integration}>
      <div><h2>Подключение YouTube</h2><p>Доступ разрешает владелец канала.</p></div>
      <div>
        <p>ClipForge использует YouTube API Services для загрузки клипов в подключённый канал, проверки их обработки и получения статистики. Подключение проходит через Google OAuth; пароль Google платформа не запрашивает.</p>
        <p>Сейчас платформа находится в закрытой разработке. Открытой регистрации и продажи подписок нет. Автоматическая публичная публикация готовится к запуску.</p>
        <p>Описание данных и способов отключения доступа — в <Link href="/privacy">политике конфиденциальности</Link>. Использование платформы описано в <Link href="/terms">условиях</Link>.</p>
      </div>
    </section>
  </PublicPage>;
}
