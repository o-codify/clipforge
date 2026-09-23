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
      <p>Яркие реакции, неожиданные победы и запоминающиеся разговоры из эфиров Twitch. ClipForge находит интересные моменты и превращает их в короткие видео с субтитрами.</p>
      <div className={s.actions}>
        <Link href="/login" className={s.primary}>Войти в платформу <span aria-hidden="true">↗</span></Link>
        <a href="mailto:admin@clanvelt.com" className={s.secondary}>Связаться</a>
      </div>
    </section>
    <section className={s.steps} aria-label="Что есть в ClipForge">
      <article className={s.step}><span>01 / Моменты</span><h2>Самое интересное из эфиров</h2><p>Короткие истории, ради которых не нужно пересматривать многочасовую запись.</p></article>
      <article className={s.step}><span>02 / Стримеры</span><h2>Знакомые и новые лица</h2><p>Любимые авторы и стримеры, которых вы ещё не открыли для себя.</p></article>
      <article className={s.step}><span>03 / Игры</span><h2>Разные игры и эмоции</h2><p>Решающий раунд, смешной диалог или неожиданная развязка — у каждого эфира свои моменты.</p></article>
    </section>
  </PublicPage>;
}
