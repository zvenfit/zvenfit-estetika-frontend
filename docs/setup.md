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
     сторонние CSS, jQuery, IMask и webflow.js
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

## 2. Изолированные service accounts, YDB и функция

Estetika использует отдельные service accounts, GitHub OIDC/WIF и resource-level bindings. Не
выдавайте CI folder-level роли `functions.editor`, `storage.editor` или `ydb.editor`: в общей
production folder это откроет ресурсы основного `zvenfit-frontend`. Постоянные authorized JSON и
S3 access keys для GitHub Actions не создаются.

```bash
yc init
export YC_FOLDER_ID="$(yc config get folder-id)"

yc iam service-account create --name zvenfit-estetika-frontend-ci-sa
yc iam service-account create --name zvenfit-estetika-ydb-verify-sa
yc iam service-account create --name zvenfit-estetika-site-storage-sa
yc iam service-account create --name zvenfit-estetika-lead-runtime

DEPLOY_SA_ID="$(yc iam service-account get \
  --name zvenfit-estetika-frontend-ci-sa --format json | jq -r '.id')"
VERIFY_SA_ID="$(yc iam service-account get \
  --name zvenfit-estetika-ydb-verify-sa --format json | jq -r '.id')"
STORAGE_SA_ID="$(yc iam service-account get \
  --name zvenfit-estetika-site-storage-sa --format json | jq -r '.id')"
RUNTIME_SA_ID="$(yc iam service-account get \
  --name zvenfit-estetika-lead-runtime --format json | jq -r '.id')"
```

Если уже существует прежний `github-ci-zvenfit-estetika`, используйте его ID и переименуйте аккаунт,
не создавая вторую deploy identity. Verifier, storage и runtime identities всё равно должны быть
отдельными: preflight отклоняет совпадающие ID.

### GitHub OIDC / Workload Identity Federation

Создайте отдельную federation для Estetika и свяжите deploy и verifier identities с разными
GitHub Environment subjects этого репозитория. Deploy использует `production`, а YDB verifier —
`production-verify`; оба Environment разрешают только ветку `main`.

В организации `zvenfit` OIDC subject использует numeric owner/repository IDs. Для этого
репозитория deploy subject равен
`repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production`, а verifier
subject —
`repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production-verify`.
Стандартная форма без numeric IDs здесь не совпадает с JWT и не должна добавляться как
альтернативный credential.

```bash
yc iam workload-identity oidc federation create \
  --name zvenfit-estetika-production-github \
  --folder-id "$YC_FOLDER_ID" \
  --issuer https://token.actions.githubusercontent.com \
  --audiences https://github.com/zvenfit \
  --jwks-url https://token.actions.githubusercontent.com/.well-known/jwks

FEDERATION_ID="$(yc iam workload-identity oidc federation get \
  --name zvenfit-estetika-production-github --format json | jq -r '.id')"

yc iam workload-identity federated-credential create \
  --service-account-id "$DEPLOY_SA_ID" \
  --federation-id "$FEDERATION_ID" \
  --external-subject-id \
  'repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production'

yc iam workload-identity federated-credential create \
  --service-account-id "$VERIFY_SA_ID" \
  --federation-id "$FEDERATION_ID" \
  --external-subject-id \
  'repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production-verify'
```

Workflow получает GitHub OIDC JWT и выбирает audience конкретной identity. Перед положительным
обменом verifier JWT CI обязан доказать, что тот же token отклоняется для `DEPLOY_SA_ID`. Forbidden
ID передаётся output-ом из `production` preflight, а не дублируется переменной
`production-verify`; тест принимает только ожидаемый `HTTP 401 invalid_client` без `access_token`,
а любой другой 4xx/5xx/network response завершает job ошибкой.
После обмена OIDC request variables удаляются из окружения шага, исполняющего verifier artifact.
`VERIFY_SA_ID` имеет доступ только к Estetika YDB; `DEPLOY_SA_ID` создаёт версию только
Estetika-функции и выпускает одночасовой ephemeral key только для `STORAGE_SA_ID`. Сам storage SA
имеет READ/WRITE только на `zvenfit-estetika-frontend`.

При миграции сначала создайте новый verifier credential, дождитесь зелёного workflow с успешным
negative cross-SA exchange и только затем удалите прежний verifier credential с `production`
subject. Не оставляйте оба subjects как fallback: это снова объединит verifier и deploy trust
boundaries.

Роль выпуска ephemeral keys назначается на ресурс storage SA, а не на общую folder:

```bash
yc iam service-account add-access-binding \
  --id "$STORAGE_SA_ID" \
  --role iam.serviceAccounts.ephemeralAccessKeyAdmin \
  --service-account-id "$DEPLOY_SA_ID"
```

Не заменяйте binding ролью на folder. CI сначала пытается выпустить deny-only ключ для runtime SA и
обязан получить `PERMISSION_DENIED`, затем выпускает ключ для storage SA и проверяет, что session не
может читать `zvenfit-estetika` или `zvenfit-frontend`. Если Yandex Cloud не принимает
service-account-scoped binding в конкретной организации, безопасный fallback — отдельный folder или
credential broker с фиксированными subject/policy; folder-level issuer в общей folder не используется.

`npm ci`, TypeScript и сборка сайта выполняются в jobs без OIDC. Jobs с `id-token: write` скачивают
готовые SHA-pinned Actions artifacts. Исключение — live YDB integration/schema probe: он исполняет
предварительно собранный verifier под отдельным `VERIFY_SA_ID`, который не может менять функцию,
выпускать S3 keys или обращаться к другим YDB.

До первого CI deploy администратор один раз создаёт YDB, финальную схему, функцию и retry timer и
выдаёт доступы на конкретные ресурсы. Обычный deploy после этого только проверяет инфраструктуру
и схему, затем создаёт новую версию функции:

```bash
yc ydb database create \
  --name zvenfit-estetika-leads \
  --description="Durable ZvenFit Estetika form submissions" \
  --serverless \
  --sls-storage-size=1GB \
  --deletion-protection

YDB_DATABASE_ID="$(yc ydb database get \
  --name zvenfit-estetika-leads \
  --format json | jq -r '.id')"
echo "YDB_DATABASE_ID=$YDB_DATABASE_ID"

yc ydb database add-access-binding \
  --name zvenfit-estetika-leads \
  --role ydb.editor \
  --service-account-id "$VERIFY_SA_ID"

yc ydb database add-access-binding \
  --name zvenfit-estetika-leads \
  --role ydb.editor \
  --service-account-id "$RUNTIME_SA_ID"

export YDB_CONNECTION_STRING="$(yc ydb database get \
  --name zvenfit-estetika-leads \
  --format json | jq -r '.endpoint')"
export YDB_ACCESS_TOKEN_CREDENTIALS="$(yc iam create-token)"
npm --prefix functions/telegram-lead run bootstrap:schema
unset YDB_ACCESS_TOKEN_CREDENTIALS YDB_CONNECTION_STRING

yc iam service-account add-access-binding \
  --id "$RUNTIME_SA_ID" \
  --role iam.serviceAccounts.user \
  --service-account-id "$DEPLOY_SA_ID"

yc serverless function create --name zvenfit-estetika-telegram-lead
yc serverless function add-access-binding \
  --name zvenfit-estetika-telegram-lead \
  --role functions.editor \
  --service-account-id "$DEPLOY_SA_ID"

yc serverless function allow-unauthenticated-invoke zvenfit-estetika-telegram-lead
yc serverless function add-access-binding \
  --name zvenfit-estetika-telegram-lead \
  --role functions.functionInvoker \
  --service-account-id "$RUNTIME_SA_ID"

yc serverless trigger create timer \
  --name zvenfit-estetika-telegram-retry \
  --description="Retry pending ZvenFit Estetika Telegram notifications" \
  --cron-expression='* * * * ? *' \
  --payload='retry-telegram' \
  --invoke-function-name=zvenfit-estetika-telegram-lead \
  --invoke-function-service-account-id="$RUNTIME_SA_ID" \
  --retry-attempts=2 \
  --retry-interval=30s

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role monium.metrics.writer \
  --service-account-id "$RUNTIME_SA_ID"

yc iam api-key create \
  --service-account-id "$RUNTIME_SA_ID" \
  --description="ZvenFit Estetika direct metrics" \
  --scope yc.monium.metrics.write
```

Секрет API key из последней команды сохраните как `MONIUM_API_KEY`: после создания его нельзя
прочитать повторно. Роль Monium действует в проекте текущего каталога, но метрики Estetika имеют
отдельный `service=zvenfit-estetika-frontend`; она не даёт доступ к YDB, функции или бакетам
основного проекта.

Публичный `functionInvoker` и retry timer назначаются один раз администратором. CI проверяет
binding, не изменяет timer и останавливает deploy с инструкцией, если функция или binding
отсутствуют; выдавать `functions.admin` CI не требуется.

### Минимальная IAM-матрица

| Identity | Scope | Role / access | Зачем |
| --- | --- | --- | --- |
| deploy SA | federation credential | точный subject `repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production` | обмен GitHub OIDC на IAM token |
| deploy SA | `zvenfit-estetika-telegram-lead` | `functions.editor` | создавать версии своей функции |
| deploy SA | runtime SA | `iam.serviceAccounts.user` | назначать runtime identity версии функции |
| deploy SA | storage SA | `iam.serviceAccounts.ephemeralAccessKeyAdmin` | выпускать ephemeral key только для storage SA |
| verifier SA | federation credential | точный subject `repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production-verify` | отдельная WIF identity для live YDB probe |
| verifier SA | `zvenfit-estetika-leads` | `ydb.editor` | integration probe и schema verification |
| storage SA | `zvenfit-estetika-frontend` | bucket READ/WRITE ACL | загружать только артефакт сайта |
| runtime SA | `zvenfit-estetika-leads` | `ydb.editor` | хранить заявки, rate limit и retry state |
| runtime SA | Monium project | `monium.metrics.writer` + scoped API key | писать direct queue gauges |
| runtime SA | функция | `functions.functionInvoker` | timer вызывает функцию |
| `allUsers` | функция | `functions.functionInvoker` | публичная форма до появления Gateway/SWS |
| `allUsers` | оба Estetika buckets | public read | CDN origin и прямые ассеты |

У deploy и verifier SA нет доступа к данным Object Storage. Storage SA не имеет доступа к
`zvenfit-estetika`, `zvenfit-frontend` и другим бакетам общей folder.
Обычный CI не создаёт YDB, function, trigger, bucket, federation и IAM bindings — это
административный bootstrap.

## 3. Object Storage

| Бакет | Содержимое | Как обновляется |
|-------|------------|-----------------|
| `zvenfit-estetika-frontend` | HTML, юридические страницы, robots, sitemap, JS приложения, минифицированный CSS сайта | CI при пуше в `main` или `npm run deploy:yc` |
| `zvenfit-estetika` | Изображения, шрифты, сторонние CSS, jQuery, IMask, `webflow.js` | Объекты публикуются напрямую через авторизованный Yandex Cloud CLI; массовый `sync --delete` не используется |

Создайте оба бакета с публичным чтением и настройками статического сайта для первого бакета:

```bash
export YC_FOLDER_ID="$(yc config get folder-id)"
npm run setup:storage
```

Скрипт выдаёт `READ` + `WRITE` storage service account только через ACL бакета
`zvenfit-estetika-frontend`. Доступ к бакету ассетов `zvenfit-estetika` и к бакетам основного
проекта CI не получает. Команда ACL, если инфраструктура настраивается вручную:

```bash
yc storage bucket update zvenfit-estetika-frontend \
  --public-read \
  --grants grant-type=grant-type-account,grantee-id="$STORAGE_SA_ID",permission=permission-read \
  --grants grant-type=grant-type-account,grantee-id="$STORAGE_SA_ID",permission=permission-write
```

Сгенерированный артефакт сайта содержит:

```text
index.html
form/index.html
404.html
privacy/index.html
personal-data-processing/index.html
robots.txt
sitemap.xml
css/zvenfit-kosmetologiya.webflow.min.css
js/*.js (скрипты приложения без CDN-библиотек)
```

В нём не должно быть `images/`, `fonts/`, сторонних CSS, исходного CSS сайта и CDN-библиотек.
Старые ключи `documents/privacy-policy.html` и `documents/personal-data-processing.html` в `dist/`
не входят. HTTP 301 с них задаётся правилами `routingRules` из `scripts/website-settings.json`,
которые применяет одноразовая административная команда `npm run setup:storage`. Обычный CI не
меняет настройки бакета и только проверяет редиректы в production smoke.

### Загрузка изменяемых ассетов

В репозитории нет staging или upload-скрипта для бакета ассетов. Изменяемые объекты публикуются напрямую через авторизованный профиль Yandex Cloud:

| Объект в бакете | Версионируемый источник |
|------------------|-------------------------|
| `js/jquery-3.5.1.min.js` | `jquery@3.5.1` из `package.json` |
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
AWS_SESSION_TOKEN=... \
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
9. Проверьте HTTP 301 со старых `/documents/*.html` на `/privacy/` и `/personal-data-processing/`.

CI загружает HTML, `robots.txt` и `sitemap.xml` с `no-cache, must-revalidate`, а версионированные CSS/JS — с `public, max-age=31536000, immutable`. После изменения CDN-настроек или первого деплоя очистите кеш ресурса. Значение `ASSET_VERSION`, переданное через окружение или GitHub Variables, должно меняться при каждом релизе с изменениями CSS/JS.

Бакет ассетов используется напрямую по адресу `https://storage.yandexcloud.net/zvenfit-estetika`. То же значение записано в `assetsCdnBase` файла `scripts/structured-data.config.json`.

## 5. Настройка GitHub

Секреты репозитория:

| Имя | Значение |
|-----|----------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота |
| `TELEGRAM_CHAT_ID` | Идентификатор целевой группы |
| `LEAD_RATE_LIMIT_SECRET` | Случайная строка длиной от 32 символов для HMAC IP (`openssl rand -hex 32`) |
| `MONIUM_API_KEY` | API key с правом записи direct metrics в Monium; передаётся только функции |

Переменные репозитория:

| Имя | Значение |
|-----|----------|
| `YC_FOLDER_ID` | Идентификатор production folder Yandex Cloud |
| `YC_DEPLOY_SERVICE_ACCOUNT_ID` | ID `zvenfit-estetika-frontend-ci-sa`, связанного с WIF |
| `YC_YDB_VERIFY_SERVICE_ACCOUNT_ID` | ID отдельного `zvenfit-estetika-ydb-verify-sa`, связанного с той же federation |
| `YC_STORAGE_SERVICE_ACCOUNT_ID` | ID `zvenfit-estetika-site-storage-sa`; WIF к нему не привязывается |
| `YANDEX_METRIKA_ID` | Идентификатор продакшен-счётчика Метрики |
| `ASSET_VERSION` | Необязательная версия для сброса кеша; по умолчанию используется номер запуска workflow |
| `YC_LEAD_SERVICE_ACCOUNT_ID` | Обязательный ID отдельного runtime SA функции и таймера |
| `YDB_DATABASE_ID` | Обязательный ID заранее созданной YDB; позволяет изолированному CI обращаться к базе без права перечислять ресурсы каталога |
| `YDB_DATABASE_NAME` | Имя Serverless БД; по умолчанию `zvenfit-estetika-leads` |
| `YDB_LEADS_TABLE` | Независимые бизнес-заявки; по умолчанию `leads` |
| `YDB_NEWSLETTER_SUBSCRIPTIONS_TABLE` | Текущее состояние рассылки, одна строка на нормализованный телефон; по умолчанию `newsletter_subscriptions` |
| `YDB_NEWSLETTER_CONSENT_EVENTS_TABLE` | Неизменяемая история opt-in и отписок; по умолчанию `newsletter_consent_events` |
| `YDB_TELEGRAM_OUTBOX_TABLE` | Техническая очередь Telegram; по умолчанию `telegram_outbox` |
| `YDB_RATE_LIMITS_TABLE` | TTL-таблица технических счётчиков; по умолчанию `form_rate_limits` |
| `LEAD_RATE_LIMIT_MAX` | Допустимых отправок с одного HMAC-IP за окно; по умолчанию `5` |
| `LEAD_RATE_LIMIT_WINDOW_SECONDS` | Размер окна rate limit; по умолчанию `600` |
| `MAX_TELEGRAM_ATTEMPTS` | Максимум попыток Telegram; по умолчанию `12` |
| `TELEGRAM_RETRY_BATCH_SIZE` | Число записей, обрабатываемых timer за вызов; по умолчанию `5`, максимум `25` |
| `TELEGRAM_TIMEOUT_MS` | Таймаут одного запроса Telegram; по умолчанию `15000`, максимум `25000` |
| `YC_LEAD_TIMEOUT` | Таймаут Cloud Function; по умолчанию `120s`, должен покрывать retry batch |
| `YDB_QUERY_TIMEOUT_MS` | Таймаут операции/транзакции YDB; production default `10000`, как в обкатанной конфигурации `zvenfit-frontend` |
| `YDB_SLOW_OPERATION_MS` | Порог события медленной бизнес-операции; по умолчанию `3000`. Инициализация YDB-клиента в холодном контейнере измеряется вне этого порога |
| `YDB_SESSION_POOL_SIZE` | Максимум YDB-сессий на экземпляр функции; по умолчанию `5` |
| `MONIUM_METRICS_ENABLED` | Прямой экспорт метрик; production default `true` |
| `MONIUM_PROJECT` | Проект Monium; по умолчанию `folder__<YC_FOLDER_ID>` |
| `MONIUM_CLUSTER` | Cluster direct metrics; по умолчанию `default` |
| `MONIUM_SERVICE` | Service direct metrics; по умолчанию `zvenfit-estetika-frontend` |
| `MONIUM_METRICS_TIMEOUT_MS` | Таймаут OTLP export; по умолчанию `1000`, диапазон `100–5000` |

Для еженедельной проверки паритета приватного `zvenfit/zvenfit-frontend` добавьте необязательный
repository secret `UPSTREAM_READ_TOKEN` с read-only доступом к contents. Для публичного upstream
workflow использует стандартный `GITHUB_TOKEN`.

GitHub Environments `production` и `production-verify` используют custom deployment branch policy
только для `main`. В `production-verify` находятся только несекретные YDB/verifier variables;
deploy SA ID для негативного cross-SA теста приходит из проверенного `production` preflight
output, application/runtime secrets туда не
копируются. Не снимайте branch restriction: иначе ручной `workflow_dispatch` сможет получить WIF
token из feature-ветки.

Repository ruleset для `main` активен без bypass: изменения проходят только через pull request,
требуют зелёный `quality-checks`, минимум одно approval и approval последнего push; удаление и
force-push запрещены. На `pull_request` workflow выполняет только job без secrets/OIDC, а все
production jobs начинаются лишь после merge/push в `main`.

Продакшен-список разрешённых CORS-доменов находится в переменной `ALLOWED_ORIGINS` внутри workflow. Единственный production-домен проекта — `https://estetika.zvenfit.ru`. Вариант `www.estetika.zvenfit.ru` намеренно не поддерживается и не должен добавляться в DNS, TLS, CORS или CI. При добавлении или удалении другого домена обновите значение в `.github/workflows/main.yml` и заново разверните функцию.

После первого успешного WIF deploy удалите GitHub Secrets `YC_SA_JSON_KEY`, `YC_ACCESS_KEY_ID` и
`YC_SECRET_ACCESS_KEY`, отзовите соответствующие authorized/static access keys в Yandex Cloud и не
оставляйте их как fallback. Повторно выполните `npm run setup:storage`: скрипт перепишет ACL site
bucket на отдельный storage SA и удалит временный legacy deploy-SA grant. Runtime-секреты Telegram,
rate limit и Monium к WIF не относятся.

## 6. Первый деплой

1. Убедитесь, что изображения и шрифты уже находятся в бакете ассетов.
2. Убедитесь, что все используемые сторонние CSS и JS-библиотеки уже доступны из бакета ассетов.
3. Настройте все перечисленные выше секреты и переменные GitHub.
4. Отправьте изменения в `main` или вручную запустите workflow `Deploy to Production`.
5. Убедитесь, что успешно завершились artifact packaging, отдельная WIF-проверка YDB, integration test, read-only проверка схемы, деплой версии функции, сборка сайта без OIDC, обе негативные проверки доступа и три синхронизации с S3.

Порядок шагов workflow:

```text
quality checks + immutable artifacts → deploy preflight → verifier OIDC/WIF → negative cross-SA exchange → integration test →
проверка схемы → function deploy OIDC/WIF → версия функции → получение URL → сборка сайта без OIDC →
storage deploy OIDC/WIF → negative issuer test → bucket-scoped ephemeral key → negative bucket test →
immutable-ассеты → robots/sitemap → HTML → production smoke без cloud credentials
```

Для полного ручного деплоя сначала разверните функцию, затем используйте напечатанный скриптом URL при сборке сайта:

```bash
export YC_FOLDER_ID=...
export YC_LEAD_SERVICE_ACCOUNT_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export LEAD_RATE_LIMIT_SECRET="$(openssl rand -hex 32)"
export MONIUM_API_KEY=...
export ALLOWED_ORIGINS=https://estetika.zvenfit.ru
bash scripts/verify-telegram-lead-ydb.sh
npm run deploy:lead-fn

export LEAD_API_URL=...  # значение из вывода deploy:lead-fn
export YANDEX_METRIKA_ID=...
export ASSET_VERSION=manual
npm run build
node scripts/check-build.cjs

# Только короткоживущие credentials Object Storage:
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=...
npm run deploy:yc
```

Greenfield-схема создаётся один раз до первого деплоя. Production deploy только проверяет её
командой `verify:schema` и никогда не выполняет DDL:

```bash
export YDB_CONNECTION_STRING="$(yc ydb database get --id="$YDB_DATABASE_ID" --format=json | jq -r '.endpoint')"
export YDB_ACCESS_TOKEN_CREDENTIALS="$(yc iam create-token)"
npm --prefix functions/telegram-lead run bootstrap:schema
unset YDB_ACCESS_TOKEN_CREDENTIALS YDB_CONNECTION_STRING
```

`leads` бессрочно хранит независимые заявки. `newsletter_subscriptions` хранит подтверждённое
текущее состояние `active`/`unsubscribed`, а `newsletter_consent_events` — бессрочную историю
`opt_in_requested`, `opt_in_confirmed` и `unsubscribe`. `telegram_outbox` содержит только доставку и использует синхронные индексы
`idx_telegram_outbox_due` и `idx_telegram_outbox_status_created`. TTL применяется только к
`form_rate_limits`; PII в outbox очищается сразу после `sent` или terminal `failed`.

Публичный opt-in только записывает запрос и не активирует подписку. Доверенная интеграция должна
подтвердить владение номером (OTP/double opt-in или подписанный одноразовый токен) и лишь затем
вызвать confirmation-операцию. До этого номер остаётся suppressed; публичный повторный opt-in не
может снять отписку. Отправитель рассылки обязан проверять suppression перед каждым сообщением.
Публичная отписка по одному телефону запрещена — для неё нужен доверенный webhook провайдера или
подписанная одноразовая ссылка.

Ответ `{ "ok": true }` означает, что запись уже сохранена в YDB; `notification: "pending"`
означает, что Telegram будет повторён таймером. Для newsletter ответ также содержит
`confirmation_required: true`; это не подтверждение активной подписки. Доступ к таблице содержит
персональные данные и должен быть ограничен ответственными сотрудниками.

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
  -d '{"form_type":"lead","name":"Тест","phone":"+79991234567","service":"Позвонить","consents":{"version":"2026-08-14-v2","personal_data":true,"marketing":false}}'

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"newsletter","phone":"+79991234567","consents":{"version":"2026-08-14-v2","personal_data":true,"marketing":true}}'
```

Функция проверяет Origin, тип и размер JSON, валидирует поля, использует honeypot,
транзакционно ограничивает один HMAC-IP пятью отправками за 10 минут и обрабатывает ошибки
Telegram. `functions/telegram-lead/src/index.ts` остаётся тонкой точкой входа, реализация разделена
на HTTP, payload, Telegram, YDB и observability-модули. Пакет функции можно проверить отдельно
командой `npm run test:lead-fn`, а настоящую YDB — `npm --prefix functions/telegram-lead run test:integration`.
