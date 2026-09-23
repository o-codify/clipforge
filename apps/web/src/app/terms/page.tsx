import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage, publicStyles as s } from "@/components/PublicPage";

export const metadata: Metadata = {
  title: "Условия использования — ClipForge",
  description: "Назначение платформы ClipForge, доступ и правила работы с материалами.",
  alternates: { canonical: "https://clipforge.clanvelt.com/terms" },
};

export default function TermsPage() {
  return <PublicPage current="/terms"><article className={s.article}>
    <p className={s.eyebrow}>Правила работы</p>
    <h1>Условия использования</h1>
    <p className={s.meta}>Обновлено 24 сентября 2026 года</p>
    <h2>Назначение и доступ</h2>
    <p>ClipForge помогает находить и смотреть короткие клипы из эфиров Twitch. Для отдельных функций требуется аккаунт. Не передавайте данные для входа другим лицам и не пытайтесь получить доступ к чужим аккаунтам или закрытым данным.</p>
    <h2>Материалы и публикации</h2>
    <p>Для обработки и распространения материалов нужны соответствующие права или разрешения. Доступность эфира в интернете сама по себе не предоставляет права на его повторную публикацию. По вопросам использования материалов можно обратиться на <a href="mailto:admin@clanvelt.com">admin@clanvelt.com</a>, указав ссылку и основание обращения.</p>
    <p>Права на исходные материалы принадлежат их правообладателям. Использование ClipForge не передаёт эти права пользователю. Не используйте сервис для нарушения чужих прав или распространения незаконного контента.</p>
    <h2>Использование YouTube</h2>
    <p>ClipForge использует YouTube API Services. Используя ClipForge, вы также соглашаетесь соблюдать <a href="https://www.youtube.com/t/terms">условия использования YouTube</a>. ClipForge является самостоятельным сервисом и не представляет YouTube или Twitch.</p>
    <h2>Данные и связь</h2>
    <p>Обработка данных и запросы на их удаление описаны в <Link href="/privacy">политике конфиденциальности</Link>. Контакт для вопросов о работе сервиса и обращений правообладателей: <a href="mailto:admin@clanvelt.com">admin@clanvelt.com</a>.</p>
  </article></PublicPage>;
}
