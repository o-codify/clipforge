# Состояние платформы — 23 сентября 2026

## Что проверено

- TypeScript API, worker и Next UI; PostgreSQL + pg-boss; закрытая регистрация.
- 31 HTTP-проверок прав: анонимный доступ, изоляция пользователя, модератор без записи, административные маршруты, валидация.
- Конкурентная постановка 12 одинаковых заданий создаёт одну задачу; активная задача не дублируется; после завершения можно повторить.
- 25 тестов pipeline и 2 теста перевода технических событий в понятные сообщения.
- Реальный изолированный тест 75 секунд видео: Whisper large-v3 на CUDA, звуковые сигналы, камера, 2 вертикальных видео 1080×1920, повтор без дублей, восстановление удалённого тестового файла.
- Реальный автономный прогон rostikfacekid: 24 новых клипа из эфира v2880100583. Планировщик выбрал следующий эфир без ручного запуска.
- В браузере проверены двухколоночный помощник 850×660 на desktop, ответы о результатах, три видеоплеера внутри чата, ссылки заданий и перенос названий. Blobatar использует always + thinking; состояние задаётся реальной обработкой.

## Ограничение сети

Загрузка аудио/видео ограничена 40 000 Кбит/с (5 000 000 байт/с). yt-dlp запускается с --limit-rate 5000000 и одним HLS-потоком, чтобы лимит не умножался. Проверены аргументы реального процесса; прерванная загрузка продолжилась со скачанной части и завершилась.

## YouTube

Проверка существующего подключения вернула `invalid_grant`. Нужно повторно войти через «Управление платформой → YouTube». Причина отзыва/истечения токена из ответа неизвестна. Для внешнего приложения в Google OAuth Testing токен с YouTube scopes обычно живёт 7 дней: https://developers.google.com/identity/protocols/oauth2#expiration

Загрузка, проверка реальной видимости и сбор статистики реализованы. Автопубликация по умолчанию выключена. Новые ролики не загружались в ходе проверки. Существующий приватный ролик не объявляется публичным без подтверждения API. Чтобы считать публикацию публичной, требуется actual privacy=public и uploadStatus=processed.

Для непроверенных API-проектов YouTube может принудительно оставлять загрузки приватными. `YOUTUBE_PRIVACY=public` не обходит это: нужен аудит проекта. https://developers.google.com/youtube/v3/docs/videos

Приватную блокировку API нельзя снять подменой параметра: официальный путь — проверенный API-проект или загрузка через YouTube. https://support.google.com/youtube/answer/7300965

## TikTok и Instagram

TikTok Direct Post требует аудита для публичного размещения. Его правила не допускают приложение, просто копирующее произвольный контент с других платформ, или внутреннюю утилиту загрузки только на свои/командные аккаунты. Требуются действия автора и выбор видимости. Текущая полностью автономная агрегация Twitch не соответствует такому сценарию. Коннектор не реализован: добавлять фиктивную работающую кнопку нельзя. https://developers.tiktok.com/doc/content-sharing-guidelines/

Instagram Reels технически подходит: профессиональный Business/Creator аккаунт, OAuth-разрешение публикации, доступный Meta video_url, создание media container, ожидание FINISHED, затем media_publish. Для локальных файлов нужен собственный HTTPS-хостинг медиа. Коннектор не реализован без аккаунта/Meta-приложения; архитектура publications уже разделяет operationId и mediaId. Официальная коллекция Meta: https://www.postman.com/meta/instagram/overview

## Границы текущей версии

Платёжные тарифы не включены: это будущая стадия продукта. Модераторы и пользователи поддержаны в правах, создавать их сейчас не требуется. Рост популярности не гарантируется: сначала собирается публичная статистика, затем ограниченно корректируются веса отбора. Сейчас публичных данных недостаточно, поэтому используются исходные сигналы и исследование менее обработанных каналов.

Помощник — отдельный пакет с детерминированными ответами по данным сайта. LLM не установлена: для навигации и сообщений очереди она не даёт преимущества, но добавляет память и задержки. Адаптер модели предусмотрен.

Camera verification (2026-09-23): every new rendered segment is checked at approximately 0.5-second intervals, including its boundaries. YuNet eye landmarks must have plausible geometry; mouth visibility is not required. Detections are counted by distinct sample frames. All samples must agree on a camera region; static regions and uncertain/missing detections disable the separate camera panel. The actual per-clip layout is included in the clip fingerprint. This is conservative sampling, not a guarantee of detection between samples or through every mask. Existing clips retain their old layout until rerendered. Verified a real replacement clip for v2859643784 (run 20260923-184954-283254) and seven Python regression cases.

Development mode enabled (2026-09-23): platform_runtime.settings.developmentMode=true disables autonomous clip scheduling and publishing; manual render requests are capped at one clip, including requests with a higher count. Discovery/indexing remain enabled. Pausing/resuming now preserves these settings. No-camera layout fits the complete source frame into the vertical canvas without cropping its sides; verified an ephemeral two-second render and removed the preview after review.

Camera/layout correction (supersedes the previous full-frame layout note): game panels now use a shared 1080x812 size with and without a camera; the no-camera variant is vertically centered. This deliberately retains the landscape crop used by the camera layout. Per-clip detection validates the established VOD camera rectangle and does not widen it to enclose all sampled head positions. If a detected head leaves that rectangle, the separate panel is omitted. Verified actual YuNet inference on three real video windows (65 samples each), plus controlled lower-face occlusion, absent/intermittent camera, frozen image and shifted camera. Occlusion kept the face; absence/intermittence/freeze/shift disabled the panel. This does not establish accuracy for arbitrary real masks. Both existing review runs were rebuilt in place, not added as more examples.
