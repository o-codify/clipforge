import type { Metadata } from "next";
import { PublicPage, publicStyles as s } from "@/components/PublicPage";

export const metadata: Metadata = {
  title: "О платформе — ClipForge",
  description: "Моменты игровых эфиров Twitch в коротких клипах с субтитрами.",
  alternates: { canonical: "https://clipforge.clanvelt.com/about" },
};

function Placeholder({ className = "" }: { className?: string }) {
  return <div className={[s.placeholder, className].join(" ")} role="img" aria-label="Место для изображения">
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0 100 100M100 0 0 100"/></svg>
    <span>Изображение</span>
  </div>;
}

export default function AboutPage() {
  return <PublicPage current="/about">
    <div className={s.landing}>
      <section className={s.intro} aria-labelledby="intro-title">
        <div className={s.introTitle}><span>Twitch / YouTube</span><h1 id="intro-title"><span>Из эфира</span><span>в клип</span></h1></div>
        <Placeholder className={s.introMedia}/>
        <p className={s.introCopy}>Моменты игровых эфиров.<br/>Короткие видео с субтитрами.</p>
        <a className={s.watch} href="https://www.youtube.com/channel/UC-P-55QVYfT8SBtGnCNAtog"><span aria-hidden="true">▶</span><span>Смотреть на YouTube</span></a>
      </section>
      <section className={s.creators} aria-labelledby="creators-title">
        <div className={s.sectionHeading}><span>01 / Стримеры</span><h2 id="creators-title">Знакомые<br/><em>и новые лица</em></h2></div>
        <p className={s.creatorsCopy}>Любимые авторы и те, кого вы ещё не открыли для себя. Ссылка на Twitch — рядом с каждым клипом.</p>
        <div className={s.portraits}><Placeholder/><Placeholder/></div>
      </section>
      <section className={s.games} aria-labelledby="games-title">
        <div className={s.sectionHeading}><span>02 / Игры</span><h2 id="games-title">Разные игры.<br/><em>Живые эмоции.</em></h2></div>
        <Placeholder className={s.gamesMedia}/>
        <p className={s.gamesCopy}>Решающие раунды, неожиданные повороты и разговоры между матчами.</p>
        <span className={s.gamesCaption}>Dota 2 / PUBG / Counter-Strike</span>
      </section>
    </div>
  </PublicPage>;
}
