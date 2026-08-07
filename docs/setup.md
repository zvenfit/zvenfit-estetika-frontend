# Настройка Telegram-бота и Yandex Cloud

Инструкция по настройке облачной функции для заявок, бакета сайта, бакета ассетов и деплоя через GitHub Actions.

## Продакшен-топология

```text
Форма → облачная функция Yandex Cloud (секреты в окружении) → группа Telegram

CDN estetika.zvenfit.ru
  └─ zvenfit-estetika-frontend → полный артефакт dist/

Ссылки на ассеты в HTML/CSS из public/
  └─ storage.yandexcloud.net/zvenfit-estetika → изображения, шрифты,
     сторонние CSS и webflow.js
```

Продакшен-workflow сначала разворачивает функцию, использует её URL при сборке сайта, проверяет `dist/` и только после этого загружает сайт.

## Что потребуется

- Node.js 22 и npm
- Yandex Cloud CLI (`yc`) с выполненным `yc init`
- AWS CLI для ручной синхронизации с Object Storage
- `jq` для команд настройки и `scripts/setup-storage.sh`
- Telegram-бот и целевая группа

Нельзя коммитить токен бота, JSON авторизованного ключа или секретный ключ Object Storage.

## 1. Telegram

1. Создайте бота через BotFather либо отзовите и замените токен, если он когда-либо был раскрыт.
2. Добавьте бота в целевую группу.
3. Отправьте сообщение в группу и запросите обновления:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Скопируйте `chat.id` нужной группы. Идентификаторы групп обычно отрицательные.

## 2. Каталог и сервисный аккаунт для CI

```bash
yc init
export YC_FOLDER_ID="$(yc config get folder-id)"
export SA_NAME=github-ci-zvenfit-estetika

yc iam service-account create --name "$SA_NAME"
SA_ID="$(yc iam service-account get --name "$SA_NAME" --format json | jq -r '.id')"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role serverless.functions.admin \
  --service-account-id "$SA_ID"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role iam.serviceAccounts.user \
  --service-account-id "$SA_ID"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role storage.editor \
  --service-account-id "$SA_ID"
```

Для этого аккаунта нужны два набора реквизитов:

- авторизованный JSON-ключ для использования `yc` в CI → секрет GitHub `YC_SA_JSON_KEY`;
- статические ID и секретный ключ Object Storage → `YC_ACCESS_KEY_ID` и `YC_SECRET_ACCESS_KEY`.

Авторизованный ключ можно создать локально:

```bash
yc iam key create --service-account-name "$SA_NAME" --output sa-key.json
```

Скопируйте JSON целиком в GitHub Secrets, затем безопасно удалите локальный файл. Статический ключ создайте в консоли Yandex Cloud или актуальной командой `yc iam access-key`: его секрет показывается только при создании.

## 3. Object Storage

| Бакет | Содержимое | Как обновляется |
|-------|------------|-----------------|
| `zvenfit-estetika-frontend` | HTML, юридические страницы, robots, sitemap, JS приложения, минифицированный CSS сайта | CI при пуше в `main` или `npm run deploy:yc` |
| `zvenfit-estetika` | Изображения, шрифты, сторонние CSS, `webflow.js` | Изображения и шрифты управляются отдельно; остальные файлы — через `npm run upload:assets` |

Создайте оба бакета с публичным чтением и настройками статического сайта для первого бакета:

```bash
export YC_FOLDER_ID="$(yc config get folder-id)"
npm run setup:storage
```

Сгенерированный артефакт сайта содержит:

```text
index.html
form/index.html
404.html
documents/privacy-policy.html
documents/personal-data-processing.html
robots.txt
sitemap.xml
css/zvenfit-kosmetologiya.webflow.min.css
js/*.js (скрипты приложения без webflow.js)
```

В нём не должно быть `images/`, `fonts/`, сторонних CSS, исходного CSS сайта и `js/webflow.js`.

### Загрузка изменяемых ассетов

`upload:assets` берёт сторонние `normalize.css` и `webflow.css` из `upload/zvenfit-kosmetologiya.webflow/`, минифицирует их, а `webflow.js` копирует из `public/js/`:

```bash
YC_ACCESS_KEY_ID=... \
YC_SECRET_ACCESS_KEY=... \
npm run upload:assets
```

Скрипт синхронизирует только префиксы `css/` и `js/`, поэтому не может удалить изображения или шрифты.

### Ручная загрузка сайта

Скрипт `deploy:yc` напрямую запускает AWS CLI, поэтому использует имена переменных `AWS_*`, хотя сами ключи относятся к Yandex Object Storage:

```bash
LEAD_API_URL=https://... \
YANDEX_METRIKA_ID=... \
ASSET_VERSION=manual \
npm run build

node scripts/check-build.cjs

AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
npm run deploy:yc
```

## 4. CDN и DNS

1. Создайте CDN-ресурс с бакетом статического сайта `zvenfit-estetika-frontend` в качестве источника.
2. Добавьте пользовательский домен `estetika.zvenfit.ru`.
3. Направьте DNS-запись CNAME на домен CDN.
4. Подключите управляемый TLS-сертификат.
5. Проверьте, что неизвестные пути отдают `/404.html`, а HTML не кешируется бессрочно.

Бакет ассетов используется напрямую по адресу `https://storage.yandexcloud.net/zvenfit-estetika`. То же значение записано в `assetsCdnBase` файла `scripts/structured-data.config.json`.

## 5. Настройка GitHub

Секреты репозитория:

| Имя | Значение |
|-----|----------|
| `YC_SA_JSON_KEY` | Полный JSON авторизованного ключа сервисного аккаунта |
| `YC_FOLDER_ID` | Идентификатор каталога Yandex Cloud для `yc` |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `TELEGRAM_CHAT_ID` | Идентификатор целевой группы |
| `YC_ACCESS_KEY_ID` | ID статического ключа Object Storage |
| `YC_SECRET_ACCESS_KEY` | Секретная часть статического ключа Object Storage |

Переменные репозитория:

| Имя | Значение |
|-----|----------|
| `YANDEX_METRIKA_ID` | Идентификатор продакшен-счётчика Метрики |
| `ASSET_VERSION` | Необязательная версия для сброса кеша; по умолчанию используется номер запуска workflow |

Продакшен-список разрешённых CORS-доменов находится в переменной `ALLOWED_ORIGINS` внутри workflow. При добавлении или удалении домена обновите значение в `.github/workflows/main.yml` и заново разверните функцию.

## 6. Первый деплой

1. Убедитесь, что изображения и шрифты уже находятся в бакете ассетов.
2. Загрузите актуальные сторонние CSS и `webflow.js` через `npm run upload:assets`.
3. Настройте все перечисленные выше секреты и переменные GitHub.
4. Отправьте изменения в `main` или вручную запустите workflow `Deploy to Production`.
5. Убедитесь, что успешно завершились деплой функции, сборка сайта, проверка артефакта и обе синхронизации с S3.

Порядок шагов workflow:

```text
деплой функции → получение URL → линтер → модульные тесты → сборка →
проверка dist → загрузка не-HTML-файлов → загрузка HTML с no-cache
```

Для полного ручного деплоя сначала разверните функцию, затем используйте напечатанный скриптом URL при сборке сайта:

```bash
export YC_FOLDER_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export ALLOWED_ORIGINS=https://estetika.zvenfit.ru,https://www.estetika.zvenfit.ru
npm run deploy:lead-fn

export LEAD_API_URL=...  # значение из вывода deploy:lead-fn
export YANDEX_METRIKA_ID=...
export ASSET_VERSION=manual
npm run build
node scripts/check-build.cjs

export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
npm run deploy:yc
```

## Локальная разработка и проверка форм

```bash
cp .env.example .env.development
npm ci
npm run dev:watch
```

- сайт: `http://localhost:4173`
- API форм: `http://localhost:3000`
- `/`: форма подписки на рассылку
- `/form/`: форма заявки

Без реквизитов Telegram локальный API выводит заявки в консоль и возвращает успешный ответ. Чтобы проверить настоящую отправку в Telegram, задайте обе переменные `TELEGRAM_*` и добавьте `http://localhost:4173` в `ALLOWED_ORIGINS` файла `.env.development`.

## Решение проблем

Сначала запустите полную локальную проверку:

```bash
npm test
```

Проверьте подставленный URL функции и состав артефакта:

```bash
rg 'ZVENFIT_LEAD_API' dist/js/lead-config.js
find dist -maxdepth 3 -type f | sort
node scripts/check-build.cjs
```

Проверьте развёрнутую функцию, используя валидный номер телефона и разрешённый Origin:

```bash
URL="$(yc serverless function get \
  --name zvenfit-estetika-telegram-lead \
  --format json | jq -r '.http_invoke_url')"

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"lead","name":"Тест","phone":"+79991234567","service":"Позвонить"}'

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"newsletter","phone":"+79991234567"}'
```

Функция проверяет Origin, тип и размер JSON, валидирует поля, использует honeypot, ограничивает число запросов с одного IP в рамках экземпляра и обрабатывает ошибки Telegram. Модульные тесты находятся в `tests/unit/telegram-lead.test.cjs`.
