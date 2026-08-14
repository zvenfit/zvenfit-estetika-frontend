# ZvenFit Estetika Frontend

Статический лендинг из Webflow, клиентский код на чистом JavaScript и одна облачная функция Yandex Cloud. HTTP-запрос сохраняет заявку или подписку вместе с версией согласия, выраженного отправкой формы, в YDB и сразу возвращает подтверждение; уведомления в Telegram асинхронно доставляет минутный timer с повторными попытками.

Продакшен: `https://estetika.zvenfit.ru`.

## Архитектура

```text
Браузер (estetika.zvenfit.ru)
  ├─ CDN сайта → бакет zvenfit-estetika-frontend
  │    HTML, юридические страницы, JS приложения, минифицированный CSS сайта,
  │    robots.txt и sitemap.xml
  ├─ storage.yandexcloud.net/zvenfit-estetika
  │    изображения, шрифты, сторонние CSS, jQuery, IMask и webflow.js
  └─ POST lead/newsletter → Cloud Function → YDB (источник истины)
                                      └→ Telegram
                                          ↑ retry timer
```

Ссылки на ассеты из CDN зафиксированы в HTML и CSS внутри `public/`. Сборка создаёт компактный `dist/`: изображения, шрифты, сторонние CSS и CDN-библиотеки удаляются, потому что отдаются из отдельного бакета с ассетами.

## Исходники и структура проекта

Редактируйте `public/`, `scripts/` и `functions/`. Сгенерированный `dist/` вручную не изменяется.

| Путь | Назначение |
|------|------------|
| `public/` | Версионируемые HTML, CSS сайта, JS приложения, robots и sitemap |
| `public/form/` | Страница формы заявки |
| `public/privacy/`, `public/personal-data-processing/` | Юридические страницы с чистыми URL без инъекций лендинга |
| `functions/telegram-lead/src/index.ts` | Точка входа Cloud Function, реэкспорт обработчика |
| `functions/telegram-lead/src/handler.ts` | HTTP, валидация, идемпотентность и retry timer |
| `functions/telegram-lead/src/ydb/` | Миграции, бессрочные заявки/подписки, индексированная очередь и rate limit |
| `functions/telegram-lead/src/observability/` | Structured logs, redaction, YDB telemetry и прямые OTLP-метрики Monium |
| `functions/telegram-lead/src/**/__tests__/` | Unit, artifact и YDB integration-тесты функции |
| `scripts/build-static.cjs` | Сборка `public/` в `dist/` |
| `scripts/structured-data.config.json` | URL сайта и CDN, метаданные страниц и данные JSON-LD |
| `tests/visual/` | Скриншотные тесты Playwright для десктопа, планшета и телефона |
| `scripts/upstream-parity.json` | Последний проверенный commit `zvenfit-frontend` |
| `upload/` | Локальная папка для сырого экспорта Webflow, исключена из Git |
| `dist/` | Сгенерированный артефакт для деплоя, исключён из Git |

Основные маршруты: `/`, `/form/`, `/privacy/`, `/personal-data-processing/` и `/404.html`.

## Требования

- Node.js 22 и npm; если `package-lock.json` не менялся, предпочтительно использовать `npm ci`
- доступ к CDN для загрузки изображений и ассетов Webflow при локальном просмотре
- для деплоя: Yandex Cloud CLI (`yc`) и AWS CLI
- для визуальных тестов: Chromium для Playwright (`npx playwright install chromium`)

## Локальная разработка

```bash
cp .env.example .env.development
npm ci
npm run dev:watch
```

Сайт откроется на `http://localhost:4173`, локальный обработчик форм — на `http://localhost:3000`.

Перед запуском dev-команд TypeScript-функция компилируется в локальный `functions/telegram-lead/build/`. `dev:watch` пересобирает статический сайт при изменениях в `public/`, сниппетах сборки и конфигурации структурированных данных. По умолчанию мок-сервер выводит только безопасную сводку формы и возвращает успешный mock-ответ. Для запуска настоящего обработчика локально нужны `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `YDB_CONNECTION_STRING` и `LEAD_RATE_LIMIT_SECRET`.

Команда `npm run dev` выполняет разовую сборку и запускает серверы без отслеживания файлов.

## Сборка

```bash
LEAD_API_URL=https://example.invalid/lead \
YANDEX_METRIKA_ID=123456 \
ASSET_VERSION=local \
npm run build
```

Переменные сборки:

| Переменная | Поведение |
|------------|-----------|
| `LEAD_API_URL` | Подставляется в `dist/js/lead-config.js`; без неё продакшен-формы не смогут отправлять заявки |
| `YANDEX_METRIKA_ID` | При наличии добавляет Яндекс Метрику |
| `ASSET_VERSION` | Версия для сброса кеша JS приложения, CSS сайта и CDN-библиотек; значение по умолчанию — `1` |
| `SITE_URL` | Базовый URL для canonical и Open Graph; по умолчанию берётся `siteUrl` из конфигурации структурированных данных |
| `NODE_ENV=development` | Загружает `.env.development` и использует `http://localhost:3000` как адрес API форм по умолчанию |

Сборка также минифицирует CSS сайта, выносит стили после маркера юридического шаблона в отдельный `legal-documents.min.css`, добавляет UTM-атрибуцию, Open Graph, canonical и JSON-LD, нормализует ссылки Webflow и удаляет ассеты, которые должны отдаваться из CDN. В юридические страницы инъекции лендинга не добавляются; их CSS получает только версию кеша. Страница `/404.html` остаётся с `noindex` и не получает ни аналитику, ни JSON-LD.

## Движение интерфейса

Первый экран, карточки «Почему выбирают нас» и секция «О нас» намеренно статичны: они не должны перемещаться между секциями, менять прозрачность от прогресса страницы или перекрывать CTA. Движение используется только как короткая обратная связь — 180 мс для кнопок и hover-состояния FAQ. Глобальный `prefers-reduced-motion` отключает и эти переходы.

При переносе нового экспорта Webflow сохраняйте классы `home-hero`, `studio-about` и `card-personal`, не возвращайте удалённые `data-w-id` трёх первых карточек и `qa-hover`: старые Webflow timelines привязаны к этим служебным маркерам и создают невидимые hit-test слои.

## Проверка

```bash
npm test                 # линтер + функция + мониторинговый контракт + сборка + performance-budget
npm run test:lead-fn     # strict typecheck + unit + проверка runtime-артефакта
npm run test:monitoring  # контракт CI/deploy, событий, метрик и алертов
npm run test:performance # проверка бюджета уже собранного dist/
npm run test:visual      # сравнение скриншотов Playwright
npm run check:upstream-parity # есть ли новые неразобранные изменения в соседнем zvenfit-frontend
```

Эталонные скриншоты зависят от платформы, хранятся только локально и исключены из Git. Создать или намеренно обновить их можно командой `npm run test:visual:update`, после чего нужно повторно запустить `npm run test:visual`.

Для ручной проверки откройте `/?utm_source=test`, отправьте подписку на рассылку, затем заявку на `/form/` и убедитесь, что в логе или сообщении Telegram есть маркировка.

## Деплой

При пуше в `main` или ручном запуске workflow выполняется `.github/workflows/main.yml`:

1. независимо от облака запускает линтер, strict typecheck, unit/artifact-тесты функции, мониторинговый контракт и проверку сайта;
2. fail-fast проверяет наличие и формат обязательных production secrets/variables без вывода значений;
3. проверяет заранее созданную YDB Serverless, прогоняет integration-тесты на временных таблицах и read-only проверку готовой схемы;
4. упаковывает только скомпилированный CommonJS runtime, разворачивает функцию и использует заранее созданный минутный retry timer;
5. собирает сайт с URL функции, проверяет `dist/` и performance-budget;
6. синхронизирует сайт и выполняет безопасный production smoke без создания реальной заявки.

Ручной деплой:

```bash
export YC_FOLDER_ID=...
export YC_LEAD_SERVICE_ACCOUNT_ID=...
export YDB_DATABASE_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export LEAD_RATE_LIMIT_SECRET="$(openssl rand -hex 32)"
export MONIUM_API_KEY=...
npm run deploy:lead-fn

export LEAD_API_URL=...       # значение из вывода deploy:lead-fn
export YANDEX_METRIKA_ID=...
npm run build

export AWS_ACCESS_KEY_ID=...  # ID статического ключа Yandex Object Storage
export AWS_SECRET_ACCESS_KEY=...
npm run deploy:yc
```

В репозитории намеренно нет staging и upload-скрипта для CDN. Версии jQuery и IMask зафиксированы в `package.json`; шрифты, jQuery, IMask и `webflow.js` публикуются напрямую в бакет `zvenfit-estetika` через авторизованный Yandex Cloud CLI с `Cache-Control: public, max-age=31536000, immutable`. Массовый `sync --delete` для бакета ассетов не используется.

```bash
yc storage s3api put-object \
  --bucket zvenfit-estetika \
  --key fonts/asset.woff2 \
  --body ./asset.woff2 \
  --content-type font/woff2 \
  --cache-control 'public, max-age=31536000, immutable'
```

После публикации проверьте публичный URL, `Content-Type`, `Cache-Control` и CORS-заголовок. `npm run setup:storage` задаёт CORS для публичной загрузки шрифтов.

Короткий список действий владельца: [`docs/operator-handoff.md`](docs/operator-handoff.md). Полная настройка инфраструктуры и секретов: [`docs/setup.md`](docs/setup.md). Мониторинг после первого деплоя: [`docs/monitoring.md`](docs/monitoring.md). Правила регулярного сравнения с основным проектом: [`docs/upstream-parity.md`](docs/upstream-parity.md). Правила маркетинговой атрибуции: [`docs/utm-attribution-marketing.md`](docs/utm-attribution-marketing.md).

## Повторный экспорт из Webflow

1. Экспортируйте проект Webflow в `upload/zvenfit-kosmetologiya.webflow/`.
2. Перенесите изменения разметки и CSS сайта в `public/`, сохранив ссылки на CDN.
3. Пользовательский клиентский код храните в `public/js/`.
4. Запустите `npm test`.
5. Если изменились CDN-ассеты, перед публикацией сайта обновите соответствующие объекты напрямую в бакете и проверьте их HTTP-статус и хеш.

Изображения, шрифты и сторонние библиотеки управляются непосредственно в бакете ассетов.

## Безопасность

Не коммитьте токены бота, ключи сервисного аккаунта, статические ключи доступа и реальные `.env*`-файлы. Если токен Telegram-бота попал в экспорт Webflow или HTML, отзовите его через BotFather до деплоя.
