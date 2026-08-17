# Что осталось сделать владельцу проекта

Код, тесты и CI-контур подготовлены. Ниже только действия, которые требуют ваших аккаунтов,
секретов, юридических решений или проверки реального сообщения. Значения секретов не присылайте в
чат и не коммитьте.

## 1. GitHub Environments переведены на WIF

Cloud-side identities, resource bindings, Estetika federation и разные exact-subject federated
credentials созданы 2026-08-16. Deploy использует GitHub Environment `production`, а YDB verifier
— отдельный `production-verify`; оба разрешают только ветку `main`. В `production` настроены
следующие Variables:

`main` защищён active repository ruleset без bypass: required PR, зелёный `quality-checks`, одно
approval с повторным approval последнего push, запрет force-push и удаления. Pull request не входит
ни в один production Environment и не получает secrets/OIDC.

- `YC_FOLDER_ID=b1ge1e4iopttj79hfdfm`;
- `YC_DEPLOY_SERVICE_ACCOUNT_ID=ajeousto2q45k6b9as32`;
- `YC_YDB_VERIFY_SERVICE_ACCOUNT_ID=ajed7h4ho8nu8pkruj6s`;
- `YC_STORAGE_SERVICE_ACCOUNT_ID=aje4hb6e2q58pu3utd47`;
- `YC_LEAD_SERVICE_ACCOUNT_ID=aje2smp55rippcfu6tsh`;
- `YDB_DATABASE_ID=etn188q3kirc4u7tbni7`;
- `YANDEX_METRIKA_ID`;

Секретами остаются только runtime/application значения:

- `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`;
- `LEAD_RATE_LIMIT_SECRET` — минимум 32 символа;
- `MONIUM_API_KEY`.

Federation `zvenfit-estetika-production-github` связана с deploy SA subject
`repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production` и verifier SA
subject
`repo:zvenfit@192599359/zvenfit-estetika-frontend@1324132200:environment:production-verify`.
Verifier job получает deploy SA ID из проверенного `production` preflight, принимает только
ожидаемый `HTTP 401 invalid_client` при негативной попытке обмена своего JWT на deploy SA, а затем удаляет GitHub OIDC
request variables перед запуском verifier artifact. В `production-verify` нет runtime/application
secrets; прежний verifier credential с `production` subject отозван после успешной проверки.
`YC_SA_JSON_KEY`, `YC_ACCESS_KEY_ID`, `YC_SECRET_ACCESS_KEY` удалены из GitHub,
соответствующие ключи отозваны в Yandex Cloud. Bucket ACL оставляет public read и read/write только
storage SA; legacy deploy-SA grant удалён. Значения секретов в чат не присылайте.

## 2. Yandex Cloud подготовлен

Созданы отдельные serverless YDB `zvenfit-estetika-leads`, функция
`zvenfit-estetika-telegram-lead`, runtime/CI service accounts и retry timer. Выданы только
resource-level роли YDB/Function, а CI получил ACL только бакета `zvenfit-estetika-frontend`.
Бакеты, YDB, функция и service accounts основного `zvenfit-frontend` не используются.

CI не выдаёт себе административные роли и остановится, если одноразовая инфраструктура или binding
отсутствуют. Deploy SA, YDB verifier, storage SA и runtime SA различаются; deploy и verifier также
имеют разные OIDC subjects. Verifier имеет
`ydb.editor` только на Estetika YDB; deploy SA меняет только Estetika-функцию и может выпускать
ephemeral keys только для storage SA; storage SA имеет ACL только на `zvenfit-estetika-frontend`.
Перед upload CI негативно проверяет запрет выпуска ключа для runtime SA и запрет чтения
`zvenfit-estetika`/`zvenfit-frontend`.

Не выдавайте deploy SA `iam.serviceAccounts.ephemeralAccessKeyAdmin` на общую folder. Разрешён
только binding на storage SA; если он недоступен в организации, нужен отдельный folder либо
credential broker.

## 3. Принять продуктовые решения до трафика

- реквизиты и владелец персональных данных подтверждены владельцем проекта 2026-08-14;
- согласие выражается отправкой формы без отдельных чекбоксов и фиксируется с версией в YDB; способ и формулировки остаётся подтвердить с юристом;
- считать `estetika.zvenfit.ru` единственным production-доменом; `www.estetika.zvenfit.ru` не поддерживать;
- отозвать Telegram token, если он когда-либо попадал в экспорт или HTML.

## 4. WIF deploy и observability выполнены

Workflow [run #32030115816](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/32030115816)
выполнил preflight, integration-тест YDB, проверку готовой схемы, WIF deploy функции, отдельную
сборку и bucket-scoped загрузку сайта с негативными access-boundary тестами, затем безопасный
read-only production smoke без реальной заявки.

Live Monium синхронизирован с Git desired state: 9 log metrics, 14 alerts, два канала,
12 operational charts, alert overview, памятка **Как читать дашборд** и строка INFO/ERROR
shortcuts. Борда показывает source
series для storage/outbox и Telegram failures, YDB retries/slow query, rate limiter/retry-trigger и
Cloud Function throttling. Runtime-error alert изолирован на
`zvenfit-estetika-telegram-lead` и использует системную серию
`cluster="default"`, `service="__serverless-functions__"`; throttling/duration используют
provider-серию `service="serverless-functions"`. Drift-check совпал. Synthetic smoke 2026-08-17
подтвердил ожидаемые пороги, 13 успешных отправок (оба канала для paging, только email для slow-YDB)
и возврат правил в `OK`. YDB session phases отложены как нестабильный техдолг; paging использует
только `query_execute`.

Metric `zvenfit_estetika_storage_errors_1m` и alert
`zvenfit_estetika_storage_errors` теперь имеют единое display name
**ZvenFit Estetika · Хранилище и outbox: ошибки**.

Функция пока публикует canonical queue gauge
`zvenfit_estetika_telegram_pending_notifications` и legacy alias
`zvenfit_estetika_telegram_pending_submissions`. Legacy удаляется отдельным следующим rollout после
наблюдения стабильности текущего dual-publish, не в том же окне миграции dashboard.

Осталось:

1. добавить на CDN `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` и
   `Referrer-Policy` из `TODO.md`;
2. включать HSTS только после стабильной проверки HTTPS;
3. после стабильного периода dual-publish удалить legacy queue gauge отдельным rollout.

## 5. Production-проверка с реальными данными

Production smoke 2026-08-17 обнаружил недоступность текущего DNS-адреса Telegram
`149.154.166.110` из сетевого контура Yandex Cloud: TCP/TLS заканчивался таймаутом, при этом YDB и
transactional outbox работали штатно. Для функции используется production environment variable
`TELEGRAM_API_FALLBACK_IPV4S=149.154.167.220`: DNS остаётся основным маршрутом, а перечисленные IPv4
используются только после короткой безопасной `HEAD`-пробы. Здоровый маршрут кэшируется на 5 минут,
поэтому функция автоматически возвращается к DNS после его восстановления. URL, TLS SNI и `Host`
остаются `api.telegram.org`; deploy preflight принимает от одного до пяти корректных IPv4.

После [первого production deploy](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/32041295899)
исходные заявка и подписка получили `status=sent` и `last_error=null`. После внедрения DNS-first
failover [deploy #32052911717](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/32052911717)
прошёл полностью, а новая тестовая заявка `b08d0be7-c445-45d3-a5dd-bea7d8dba913` сохранилась в
`leads` и доставилась из `telegram_outbox` с `status=sent`, `attempts=1`,
`delivered_at=2026-08-17T18:07:27.277Z`, `last_error=null`.

Осталось:

1. проверить production-визит в Яндекс Метрике; цели включать после реализации `reachGoal` из `TODO.md`;
2. проверить security headers командой `curl -I` после распространения CDN-настроек.

Read-only проверка страниц прошла в deploy #32052911717. До пилотного приёма реальных заявок
остаётся юридическая проверка форм. API Gateway + Smart Web Security, CSP и budget alerts остаются
обязательным следующим уровнем до рекламного трафика.
