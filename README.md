# ZvenFit Estetika Frontend

Статический лендинг из Webflow, клиентский код на чистом JavaScript и одна облачная функция Yandex Cloud. Заявки и подписки сначала сохраняются в YDB, после чего функция отправляет уведомления в Telegram с повторными попытками по таймеру.

Продакшен: `https://estetika.zvenfit.ru`.

## Архитектура

```text
Браузер (estetika.zvenfit.ru)
  ├─ CDN сайта → бакет zvenfit-estetika-frontend
  │    HTML, юридические страницы, JS приложения, минифицированный CSS сайта,
  │    robots.txt и sitemap.xml
  ├─ storage.yandexcloud.net/zvenfit-estetika
  │    изображения, шрифты, сторонние CSS, jQuery, GSAP, ScrollTrigger, IMask и webflow.js
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
| `public/documents/` | Юридические HTML-страницы без инъекций лендинга |
| `functions/telegram-lead/index.js` | Точка входа Cloud Function, реэкспорт обработчика |
| `functions/telegram-lead/handler.js` | Валидация, идемпотентность, Telegram и retry timer |
| `functions/telegram-lead/submission-store.js` | YDB: заявки и подписки, TTL, lease и статусы доставки |
| `functions/telegram-lead/__tests__/` | Модульные тесты функции |
| `scripts/build-static.cjs` | Сборка `public/` в `dist/` |
| `scripts/structured-data.config.json` | URL сайта и CDN, метаданные страниц и данные JSON-LD |
| `tests/visual/` | Скриншотные тесты Playwright для десктопа, планшета и телефона |
| `upload/` | Локальная папка для сырого экспорта Webflow, исключена из Git |
| `dist/` | Сгенерированный артефакт для деплоя, исключён из Git |

Основные маршруты: `/`, `/form/`, `/404.html` и две страницы в `/documents/`.

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

`dev:watch` пересобирает проект при изменениях в `public/`, сниппетах сборки и конфигурации структурированных данных. По умолчанию мок-сервер выводит только безопасную сводку формы и возвращает успешный mock-ответ. Для запуска настоящего обработчика локально нужны `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` и `YDB_CONNECTION_STRING`.

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

Сборка также минифицирует CSS сайта, добавляет UTM-атрибуцию, Open Graph, canonical и JSON-LD, нормализует ссылки Webflow и удаляет ассеты, которые должны отдаваться из CDN. В юридические страницы инъекции лендинга не добавляются. Страница `/404.html` остаётся с `noindex` и не получает ни аналитику, ни JSON-LD.

## Проверка

```bash
npm test                 # линтер + модульные тесты + сборка + performance-budget
npm run test:lead-fn     # только тесты пакета Cloud Function
npm run test:performance # проверка бюджета уже собранного dist/
npm run test:visual      # сравнение скриншотов Playwright
```

Эталонные скриншоты зависят от платформы, хранятся только локально и исключены из Git. Создать или намеренно обновить их можно командой `npm run test:visual:update`, после чего нужно повторно запустить `npm run test:visual`.

Для ручной проверки откройте `/?utm_source=test`, отправьте подписку на рассылку, затем заявку на `/form/` и убедитесь, что в логе или сообщении Telegram есть маркировка.

## Деплой

При пуше в `main` или ручном запуске workflow выполняется `.github/workflows/main.yml`:

1. создаёт YDB Serverless при необходимости, разворачивает функцию и минутный retry timer;
2. устанавливает зависимости, запускает линтер и модульные тесты функции;
3. собирает сайт с URL функции, идентификатором Метрики и версией кеша;
4. проверяет `dist/` и performance-budget;
5. синхронизирует с бакетом сайта версионируемые ассеты с кешем на год, а HTML, `robots.txt` и `sitemap.xml` — с `no-cache`.

Ручной деплой:

```bash
export YC_FOLDER_ID=...
export YC_LEAD_SERVICE_ACCOUNT_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
npm run deploy:lead-fn

export LEAD_API_URL=...       # значение из вывода deploy:lead-fn
export YANDEX_METRIKA_ID=...
npm run build

export AWS_ACCESS_KEY_ID=...  # ID статического ключа Yandex Object Storage
export AWS_SECRET_ACCESS_KEY=...
npm run deploy:yc
```

В репозитории намеренно нет staging и upload-скрипта для CDN. Версии jQuery, GSAP и IMask зафиксированы в `package.json`; шрифты, jQuery, GSAP, ScrollTrigger, IMask и `webflow.js` публикуются напрямую в бакет `zvenfit-estetika` через авторизованный Yandex Cloud CLI с `Cache-Control: public, max-age=31536000, immutable`. Массовый `sync --delete` для бакета ассетов не используется.

```bash
yc storage s3api put-object \
  --bucket zvenfit-estetika \
  --key fonts/asset.woff2 \
  --body ./asset.woff2 \
  --content-type font/woff2 \
  --cache-control 'public, max-age=31536000, immutable'
```

После публикации проверьте публичный URL, `Content-Type`, `Cache-Control` и CORS-заголовок. `npm run setup:storage` задаёт CORS для публичной загрузки шрифтов.

Полная настройка инфраструктуры и секретов: [`docs/setup.md`](docs/setup.md). Правила маркетинговой атрибуции: [`docs/utm-attribution-marketing.md`](docs/utm-attribution-marketing.md).

## Повторный экспорт из Webflow

1. Экспортируйте проект Webflow в `upload/zvenfit-kosmetologiya.webflow/`.
2. Перенесите изменения разметки и CSS сайта в `public/`, сохранив ссылки на CDN.
3. Пользовательский клиентский код храните в `public/js/`.
4. Запустите `npm test`.
5. Если изменились CDN-ассеты, перед публикацией сайта обновите соответствующие объекты напрямую в бакете и проверьте их HTTP-статус и хеш.

Изображения, шрифты и сторонние библиотеки управляются непосредственно в бакете ассетов.

## Безопасность

Не коммитьте токены бота, ключи сервисного аккаунта, статические ключи доступа и реальные `.env*`-файлы. Если токен Telegram-бота попал в экспорт Webflow или HTML, отзовите его через BotFather до деплоя.
