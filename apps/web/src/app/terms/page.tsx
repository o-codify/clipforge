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
    <p className={s.meta}>Проект редакции от 23 сентября 2026 года</p>
    <aside className={s.notice}><p>ClipForge находится в закрытой разработке. Этот документ подготовлен для согласования перед публичным запуском; открытая регистрация и платные услуги сейчас недоступны.</p></aside>
    <h2>Назначение и доступ</h2>
    <p>ClipForge автоматизирует поиск моментов в эфирах Twitch, монтаж коротких видео и работу с их публикациями. Аккаунты создаёт администратор. Доступ к данным и операциям определяется ролью аккаунта.</p>
    <h2>Материалы и публикации</h2>
    <p>Для обработки и распространения материалов нужны соответствующие права или разрешения. Доступность эфира в интернете сама по себе не предоставляет права на его повторную публикацию. По вопросам использования материалов можно обратиться на <a href="mailto:mr.sagrin@gmail.com">mr.sagrin@gmail.com</a>, указав ссылку и основание обращения.</p>
    <p>Канал подключает его владелец или уполномоченный администратор. Публикация зависит от настроек, состояния подключения и правил площадки; ClipForge не гарантирует число просмотров или приём каждого видео.</p>
    <h2>Использование YouTube</h2>
    <p>Платформа использует YouTube API Services. Используя функции YouTube в ClipForge, пользователь соглашается соблюдать <a href="https://www.youtube.com/t/terms">условия использования YouTube</a>. ClipForge является самостоятельным приложением и не представляет YouTube или Twitch.</p>
    <h2>Данные и связь</h2>
    <p>Обработка данных, отключение доступа и запросы на удаление описаны в <Link href="/privacy">политике конфиденциальности</Link>. Контакт для вопросов о работе сервиса: <a href="mailto:mr.sagrin@gmail.com">mr.sagrin@gmail.com</a>.</p>
  </article></PublicPage>;
}
