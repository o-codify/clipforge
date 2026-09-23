# Состояние платформы — 24 сентября 2026

## Проверка продакшена и исправление миграций

Актуальный релиз `4f61d11aca2e9053745082ce481a9efc4de0d2e0` собран,
проверен и развёрнут через GitHub: https://github.com/o-codify/clipforge/actions/runs/35913346123.
Coolify завершил переключение, публичный readiness возвращает этот SHA,
на ПК автоматически установлен тот же готовый media-runtime. Одна новая версия
контейнера здорова; удаление прежнего неиспользуемого образа оставило около
745 МБ свободного места. Диск по-прежнему занят на 97%.

Вход в прод выполнен под существующим администратором. В интерфейсе проверены
канал «Кузня Клипов», действующий доступ к YouTube и форма публикации реального
клипа: канал, название, описание, три варианта видимости. Публикация не отправлялась.
При этой проверке найден и исправлен пропуск миграций уже существующей БД:
camelCase-преобразование скрывало от мигратора `created_at`. CI теперь отдельно
проверяет обновление заполненной базы, сохранность канала, повторный запуск
и отказ при неверном журнале миграций. Readiness проверяет необходимые колонки.
Сбой загрузки канала больше не отображается как отсутствие подключения.

Исправлена коллизия CSS, скрывавшая второстепенные кнопки вместе со служебными
подписями. Кнопка отключения YouTube подтверждена в работающем интерфейсе.
Реализованы ограничение повторов отзыва, срок хранения API-данных, независимая
почасовая очистка копий и очистка данных YouTube перед запуском восстановленной
БД; см. [deployment.md](deployment.md).

Два PDF приложены к черновику Google. Заявка **не отправлена**: остаются снимки
интерфейса и согласования формы. Детали, включая блокировку экспорта снимка:
[youtube-audit-preparation.md](youtube-audit-preparation.md). OAuth остаётся Testing,
автоматическая публикация выключена. Данные администратора не переданы Google.

## Обновление публичных страниц и подготовка аудита

Релиз `1d24a9414f8895da26f5908a8ef69b34afd3d44b` собран и проверен только
на GitHub: https://github.com/o-codify/clipforge/actions/runs/35905329857.
Сервер отвечает readiness с этим SHA; Coolify завершил переключение и оставил
один здоровый контейнер. Обработчик на ПК автоматически скачал тот же релиз
и запустил шесть медиаочередей. Новые клипы и YouTube-публикации при проверке
не создавались.

Из `/about`, `/privacy`, `/terms` убраны детали инфраструктуры и описание
подключения пользовательских YouTube-каналов. Публичные страницы проверены
через HTTPS: ответ 200, контакт `admin@clanvelt.com`, без Beget/S3 и прежнего
блока подключения канала. Обязательные раскрытия об API, обработке данных,
отзыве доступа и обращениях сохранены.

Ручная публикация доступна администратору: выбор канала, заголовка, описания
и видимости. Данные сохраняются без молчаливого обрезания; фактическую видимость
подтверждает YouTube. Добавлены отзыв разрешения, повтор отключения после
сбоя Google, очистка данных и проверка доступа даже без загруженных видео.
CI проверил эти сценарии, конкурентную постановку одной публикации и изоляцию
ролей. Вычисление собственных оценок из YouTube-статистики выключено до отдельного
разрешения Google; анализ Twitch и исходных видео продолжает работать.

Заявка аудита подготовлена частично в Google, но не отправлена. Цель — один
канал, до 100 загрузок в день, без увеличения текущей квоты. Остаются материалы
демонстрации, доступ проверяющего, подтверждение оснований использования контента
и согласование заверений формы. OAuth остаётся Testing; снятие ограничения
приватных загрузок не подтверждено. Личные адресные сведения в репозиторий
и на публичный сайт не добавляются.

Локальный Next dev preview ещё использует прежний локальный API. Перезапуск
preview отклонён автоматической проверкой инструмента; серверная версия
уже обновлена. Не использовать старый локальный API для проверки новых маршрутов.

## Актуальное размещение и Google OAuth

Публичный адрес — https://clipforge.clanvelt.com. Сборка контейнера и готового
media-runtime, проверки и запуск деплоя выполняются на GitHub-hosted runner.
ПК выполняет только медиазадачи и загрузку в S3; GitHub Actions runner с ПК удалён.
Текущий каталог содержит четыре актуальных клипа; старые пробы архивированы.
Проверены 41 HTTP-проверка через публичный HTTPS, реальная выдача закрытых S3
файлов с диапазонами байтов, а также восстановление БД из скачанной S3-копии.
Описание размещения и восстановления: [deployment.md](deployment.md).

В Google OAuth сохранены адрес поддержки и контакт разработчика
`admin@clanvelt.com`, домен `clanvelt.com` и публичные страницы `/about`,
`/privacy`, `/terms`. Владелец создал Google-аккаунт с этой почтой, самостоятельно
вошёл и подтвердил назначение ему роли `roles/oauthconfig.editor`.
Этой роли оказалось достаточно для замены адреса поддержки; права Owner/Editor
на весь проект новому аккаунту не выдавались. Google подтвердил сохранение.
Статус приложения пока **Testing**, аудит YouTube и массовая публикация не запущены.

Ниже сохранена история предыдущих проверок. Более поздние изменения компоновки
и проверки настоящих исходников описаны в [layout-minimap-review.md](layout-minimap-review.md)
и [real-source-validation.md](real-source-validation.md).

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

Повторная проверка 23 сентября прошла: refresh token работает, подключён канал «Кузня Клипов» (`UC-P-55QVYfT8SBtGnCNAtog`). Предыдущая запись об `invalid_grant` устарела. Фактический OAuth-проект — `valid-climber-507122-a3` (97417694771), приложение ClipForge, External / Testing. В Cloud Console проверена отдельная квота загрузок: 100 видео в день. Переход OAuth в Production и аудит YouTube API ещё не завершены. Для внешнего приложения в Google OAuth Testing токен с YouTube scopes обычно живёт 7 дней: https://developers.google.com/identity/protocols/oauth2#expiration

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
