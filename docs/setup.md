# Настройка Telegram, YDB и Yandex Cloud

Инструкция по настройке облачной функции для заявок, бакета сайта, бакета ассетов и деплоя через GitHub Actions.

## Продакшен-топология

```text
Форма → Cloud Function → YDB (источник истины) → группа Telegram
                      ↑                         ↗
                      └──── retry timer ───────┘

CDN estetika.zvenfit.ru
  └─ zvenfit-estetika-frontend → полный артефакт dist/

Ссылки на ассеты в HTML/CSS из public/
  └─ storage.yandexcloud.net/zvenfit-estetika → изображения, шрифты,
     сторонние CSS, jQuery, GSAP, ScrollTrigger, IMask и webflow.js
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
  --role functions.editor \
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

Для runtime функции создайте отдельный сервисный аккаунт без статических ключей. Его ID потребуется
как GitHub Variable `YC_LEAD_SERVICE_ACCOUNT_ID`:

```bash
export RUNTIME_SA_NAME=zvenfit-estetika-lead-runtime
yc iam service-account create --name "$RUNTIME_SA_NAME"
RUNTIME_SA_ID="$(yc iam service-account get --name "$RUNTIME_SA_NAME" --format json | jq -r '.id')"

echo "YC_LEAD_SERVICE_ACCOUNT_ID=$RUNTIME_SA_ID"
```

До первого CI deploy администратор один раз создаёт YDB и функцию и выдаёт доступы на
конкретные ресурсы. Обычный deploy после этого только проверяет инфраструктуру, применяет
миграции и создаёт новую версию функции:

```bash
yc ydb database create \
  --name zvenfit-estetika-leads \
  --description="Durable ZvenFit Estetika form submissions" \
  --serverless \
  --sls-storage-size=1GB \
  --deletion-protection

yc ydb database add-access-binding \
  --name zvenfit-estetika-leads \
  --role ydb.editor \
  --service-account-id "$SA_ID"

yc ydb database add-access-binding \
  --name zvenfit-estetika-leads \
  --role ydb.editor \
  --service-account-id "$RUNTIME_SA_ID"

yc iam service-account add-access-binding \
  --id "$RUNTIME_SA_ID" \
  --role iam.serviceAccounts.user \
  --service-account-id "$SA_ID"

yc serverless function create --name zvenfit-estetika-telegram-lead
yc serverless function allow-unauthenticated-invoke zvenfit-estetika-telegram-lead
yc serverless function add-access-binding \
  --name zvenfit-estetika-telegram-lead \
  --role functions.functionInvoker \
  --service-account-id "$RUNTIME_SA_ID"
```

Публичный `functionInvoker` назначается один раз администратором. CI проверяет binding и
останавливает deploy с инструкцией, если он отсутствует; выдавать `functions.admin` CI не требуется.

## 3. Object Storage

| Бакет | Содержимое | Как обновляется |
|-------|------------|-----------------|
| `zvenfit-estetika-frontend` | HTML, юридические страницы, robots, sitemap, JS приложения, минифицированный CSS сайта | CI при пуше в `main` или `npm run deploy:yc` |
| `zvenfit-estetika` | Изображения, шрифты, сторонние CSS, jQuery, GSAP, ScrollTrigger, IMask, `webflow.js` | Объекты публикуются напрямую через авторизованный Yandex Cloud CLI; массовый `sync --delete` не используется |

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
js/*.js (скрипты приложения без CDN-библиотек)
```

В нём не должно быть `images/`, `fonts/`, сторонних CSS, исходного CSS сайта и CDN-библиотек.

### Загрузка изменяемых ассетов

В репозитории нет staging или upload-скрипта для бакета ассетов. Изменяемые объекты публикуются напрямую через авторизованный профиль Yandex Cloud:

| Объект в бакете | Версионируемый источник |
|------------------|-------------------------|
| `js/jquery-3.5.1.min.js` | `jquery@3.5.1` из `package.json` |
| `js/gsap-3.15.0.min.js` | `gsap@3.15.0` из `package.json` |
| `js/ScrollTrigger-3.15.0.min.js` | `gsap@3.15.0` из `package.json` |
| `js/imask-7.6.1.min.js` | `imask@7.6.1` из `package.json` (`node_modules/imask/dist/imask.min.js`) |
| `js/webflow.js` | `public/js/webflow.js` |

После прямой загрузки проверьте HTTP 200, `Content-Type`, `Cache-Control` и совпадение SHA-256. Не используйте `sync --delete` для всего префикса `js/`.

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
5. Настройте edge-кеш «как у источника» с fallback `86400` секунд.
6. Отключите принудительный browser TTL: браузер должен получать `Cache-Control` объектов из бакета.
7. Добавьте query-параметр `v` в whitelist ключа кеша, чтобы `app.js?v=1` и `app.js?v=2` считались разными объектами.
8. Проверьте, что неизвестные пути отдают `/404.html` с HTTP 404 и `Cache-Control: no-cache, must-revalidate`.

CI загружает HTML, `robots.txt` и `sitemap.xml` с `no-cache, must-revalidate`, а версионированные CSS/JS — с `public, max-age=31536000, immutable`. После изменения CDN-настроек или первого деплоя очистите кеш ресурса. Значение `ASSET_VERSION`, переданное через окружение или GitHub Variables, должно меняться при каждом релизе с изменениями CSS/JS.

Бакет ассетов используется напрямую по адресу `https://storage.yandexcloud.net/zvenfit-estetika`. То же значение записано в `assetsCdnBase` файла `scripts/structured-data.config.json`.

## 5. Настройка GitHub

Секреты репозитория:

| Имя | Значение |
|-----|----------|
| `YC_SA_JSON_KEY` | Полный JSON авторизованного ключа сервисного аккаунта |
| `YC_FOLDER_ID` | Идентификатор каталога Yandex Cloud для `yc` |
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `TELEGRAM_CHAT_ID` | Идентификатор целевой группы |
| `LEAD_RATE_LIMIT_SECRET` | Случайная строка длиной от 32 символов для HMAC IP (`openssl rand -hex 32`) |
| `YC_ACCESS_KEY_ID` | ID статического ключа Object Storage |
| `YC_SECRET_ACCESS_KEY` | Секретная часть статического ключа Object Storage |

Переменные репозитория:

| Имя | Значение |
|-----|----------|
| `YANDEX_METRIKA_ID` | Идентификатор продакшен-счётчика Метрики |
| `ASSET_VERSION` | Необязательная версия для сброса кеша; по умолчанию используется номер запуска workflow |
| `YC_LEAD_SERVICE_ACCOUNT_ID` | Обязательный ID отдельного runtime SA функции и таймера |
| `YDB_DATABASE_NAME` | Имя Serverless БД; по умолчанию `zvenfit-estetika-leads` |
| `YDB_SUBMISSIONS_TABLE` | Таблица заявок и подписок; по умолчанию `submissions` |
| `YDB_RATE_LIMITS_TABLE` | TTL-таблица технических счётчиков; по умолчанию `submission_rate_limits` |
| `LEAD_RATE_LIMIT_MAX` | Допустимых отправок с одного HMAC-IP за окно; по умолчанию `5` |
| `LEAD_RATE_LIMIT_WINDOW_SECONDS` | Размер окна rate limit; по умолчанию `600` |
| `MAX_TELEGRAM_ATTEMPTS` | Максимум попыток Telegram; по умолчанию `12` |
| `TELEGRAM_RETRY_BATCH_SIZE` | Число записей, обрабатываемых timer за вызов; по умолчанию `5`, максимум `25` |
| `TELEGRAM_TIMEOUT_MS` | Таймаут одного запроса Telegram; по умолчанию `15000`, максимум `25000` |
| `YC_LEAD_TIMEOUT` | Таймаут Cloud Function; по умолчанию `120s`, должен покрывать retry batch |
| `YDB_QUERY_TIMEOUT_MS` | Таймаут операции/транзакции YDB; по умолчанию `5000` |
| `YDB_SLOW_OPERATION_MS` | Порог события медленной операции; по умолчанию `1000` |
| `YDB_SESSION_POOL_SIZE` | Максимум YDB-сессий на экземпляр функции; по умолчанию `5` |

Продакшен-список разрешённых CORS-доменов находится в переменной `ALLOWED_ORIGINS` внутри workflow. При добавлении или удалении домена обновите значение в `.github/workflows/main.yml` и заново разверните функцию.

## 6. Первый деплой

1. Убедитесь, что изображения и шрифты уже находятся в бакете ассетов.
2. Убедитесь, что все используемые сторонние CSS и JS-библиотеки уже доступны из бакета ассетов.
3. Настройте все перечисленные выше секреты и переменные GitHub.
4. Отправьте изменения в `main` или вручную запустите workflow `Deploy to Production`.
5. Убедитесь, что успешно завершились проверка YDB, integration test, миграции, деплой функции/retry timer, сборка сайта, проверка артефакта и три синхронизации с S3.

Порядок шагов workflow:

```text
quality checks → проверка YDB → integration test → миграции → деплой функции и retry timer → получение URL → сборка →
проверка dist → immutable-ассеты → robots/sitemap no-cache → HTML no-cache
```

Для полного ручного деплоя сначала разверните функцию, затем используйте напечатанный скриптом URL при сборке сайта:

```bash
export YC_FOLDER_ID=...
export YC_LEAD_SERVICE_ACCOUNT_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export LEAD_RATE_LIMIT_SECRET="$(openssl rand -hex 32)"
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

До создания версии функции deploy-скрипт применяет версионируемые миграции. Таблица `submissions` хранит заявки и подписки бессрочно, без TTL; TTL используется только для технических счётчиков rate limit. Очередь Telegram использует синхронный индекс `idx_telegram_due`. Статусы: `pending`, `sending`, `sent`, `failed`. Ответ `{ "ok": true }` означает, что запись уже сохранена в YDB; `notification: "pending"` означает, что Telegram будет повторён таймером. Доступ к таблице содержит персональные данные и должен быть ограничен ответственными сотрудниками.

Для запуска настоящего handler локально передайте endpoint существующей БД и короткоживущий IAM-токен через `YDB_CONNECTION_STRING` и `YDB_ACCESS_TOKEN_CREDENTIALS`. Без них mock-сервер не пишет персональные данные в YDB и возвращает безопасный mock-ответ.

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

Функция проверяет Origin, тип и размер JSON, валидирует поля, использует honeypot,
транзакционно ограничивает один HMAC-IP пятью отправками за 10 минут и обрабатывает ошибки
Telegram. `functions/telegram-lead/src/index.ts` остаётся тонкой точкой входа, реализация разделена
на HTTP, payload, Telegram, YDB и observability-модули. Пакет функции можно проверить отдельно
командой `npm run test:lead-fn`, а настоящую YDB — `npm --prefix functions/telegram-lead run test:integration`.
