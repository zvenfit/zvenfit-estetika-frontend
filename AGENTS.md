# Руководство для агентов — ZvenFit Estetika Frontend

Краткий контракт для AI-агентов и новых участников проекта. Список задач: [`TODO.md`](TODO.md).

## Изоляция проекта

- Это самостоятельный локальный проект. Не подключайте его к Стефании.
- Не используйте для работы в этом репозитории скиллы, базы знаний, память, персоны, процессы Стефании и внешние сервисы Яндекса.
- Опирайтесь только на этот репозиторий, его документацию и универсальные инструменты разработки, если пользователь явно не попросил иного для конкретной задачи.

## Стек

- **Фронтенд:** статический HTML из Webflow в `public/`
- **Сборка:** `scripts/build-static.cjs` → `dist/`, который исключён из Git
- **Клиентский JS:** чистый JavaScript в `public/js/`
- **Бэкенд:** одна облачная функция Yandex Cloud в `functions/telegram-lead/` для заявок и рассылки
- **CI:** `.github/workflows/main.yml` — деплой функции → линтер и модульные тесты → проверка сборки → S3

React, Vite и Next не используются. TypeScript почти отсутствует.

## Исходники

| Редактировать | Не редактировать |
|---------------|------------------|
| `public/` | `dist/` |
| `scripts/` | сгенерированные `*.min.css` в `dist/` |
| `functions/` | закоммиченные секреты |
| `upload/` | — это локальная промежуточная папка сырого экспорта Webflow |

После изменений HTML, CSS, JS или конфигурации запускайте `npm run build` либо `npm run dev:watch`.

## Архитектура

```text
Браузер (estetika.zvenfit.ru)
  ├─ бакет сайта — HTML, юридические страницы, JS приложения, минифицированный CSS,
  │                robots и sitemap
  ├─ CDN zvenfit-estetika/ — изображения, шрифты, сторонние CSS и JS-библиотеки
  └─ POST lead/newsletter → functions/telegram-lead → Telegram

Локальная разработка (npm run dev):
  мок-сервер :3000  ← POST заявок
  serve dist :4173  ← статический сайт
```

Сборка подставляет URL API в `public/js/lead-config.js`, создавая в `dist/` значение `window.ZVENFIT_LEAD_API`.

## Процесс сборки

`build-static.cjs` добавляет перед `</head>` следующие данные; специальные маркеры в исходном HTML не нужны:

| Инъекция | Источник |
|----------|----------|
| Яндекс Метрика | `scripts/snippets/analytics-head.html` + `YANDEX_METRIKA_ID` |
| UTM-атрибуция | `scripts/snippets/utm-head.html` |
| Open Graph и canonical | метаданные страницы + `scripts/structured-data.config.json` |
| JSON-LD | `scripts/structured-data.config.json`; пропускается для `/404.html` |

Также во время сборки:

- `zvenfit-kosmetologiya.webflow.css` минифицируется в `*.min.css`;
- к перечисленным JS добавляется версия кеша из `ASSET_VERSION`;
- из `dist/` удаляются CDN-ассеты: изображения, шрифты, сторонние CSS и JS; юридические HTML остаются;
- `public/robots.txt` и `public/sitemap.xml` копируются в `dist/` и обновляются вручную.

## Карта задач и файлов

| Задача | Файлы |
|--------|-------|
| Разметка лендинга | `public/index.html` |
| Интерфейс формы заявки | `public/form/index.html`, `public/js/lead-form.js` |
| Форма рассылки | `public/index.html` (футер), `public/js/newsletter-form.js` |
| API заявок и Telegram | `functions/telegram-lead/index.js` |
| UTM в заявках | `public/js/utm-attribution.js`, `docs/utm-attribution-marketing.md` |
| SEO и JSON-LD | `scripts/structured-data.config.json`, `<title>` страницы |
| CSS сайта | `public/css/zvenfit-kosmetologiya.webflow.css` |
| Тесты функции | `tests/unit/telegram-lead.test.cjs` |
| Визуальные тесты | `tests/visual/`, `playwright.config.js` |
| Версии CDN-библиотек | `package.json`, `scripts/build-static.cjs`; файлы публикуются напрямую в Object Storage |
| Деплой | `.github/workflows/main.yml`, `npm run deploy:yc` |

## Локальная разработка

```bash
cp .env.example .env.development
npm ci
npm run dev:watch
```

В режиме разработки форма отправляет заявки на `http://localhost:3000` через подставленный `LEAD_API_URL`.

## Проверка

```bash
npm test
npm run test:visual    # необязательное локальное сравнение скриншотов
```

Эталонные скриншоты зависят от платформы и исключены из Git. Создавайте или обновляйте локальные эталоны командой `npm run test:visual:update`.

Ручной smoke-тест:

- `/` — форма рассылки в футере;
- `/form/` — отправка заявки; при проверке с `?utm_source=test` в логе мок-сервера должен быть объект `utm`.

## Секреты и безопасность

- Не коммитьте токены, ключи сервисного аккаунта и реальные `.env*`.
- Токен бота и ID чата хранятся только в окружении облачной функции и GitHub Secrets.
- CORS задаётся через `ALLOWED_ORIGINS` в workflow и окружении функции.

## Ограничения бренда

Это эстетика косметологии и индустрии красоты. Не заменяйте её универсальным фитнес-оформлением из основного `zvenfit-frontend`.

## Частые ошибки

1. Редактирование `dist/` вручную: изменения исчезнут при следующей сборке.
2. Добавление локального staging или upload-скрипта для CDN: библиотеки публикуются напрямую в Object Storage без `.cdn-upload` и `sync --delete`.
3. Запуск `lint` вместо `lint:public`: каталога `src/` в проекте нет.
4. Возврат изображений, шрифтов или сторонних ассетов в бакет сайта: `dist/` должен оставаться компактным, кроме юридических HTML.

## Страницы

Основные страницы: `index.html`, `form/index.html`, `404.html`.

Юридические HTML разворачиваются вместе с сайтом: `documents/privacy-policy.html`, `documents/personal-data-processing.html`.

## Документация

| Файл | Назначение |
|------|------------|
| `README.md` | Архитектура, разработка, проверка, деплой и процесс Webflow |
| `docs/setup.md` | Настройка Yandex Cloud, Telegram и GitHub Secrets |
| `docs/utm-attribution-marketing.md` | UTM-атрибуция для маркетинга |
| `TODO.md` | Backlog и блокеры запуска |
