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

Workflow [run #31947477061](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/31947477061)
выполнил preflight, integration-тест YDB, проверку готовой схемы, WIF deploy функции, отдельную
сборку и bucket-scoped загрузку сайта с негативными access-boundary тестами, затем безопасный
read-only production smoke без реальной заявки. В Monium созданы 8 log metrics, Telegram/email
channels, 13 alerts и dashboard из 7 operational charts плюс полноширинные INFO/ERROR log
shortcuts; нативный dashboard JSON хранится в Git, live retry/heartbeat и production logs
проверены.

Осталось:

1. добавить на CDN `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` и
   `Referrer-Policy` из `TODO.md`;
2. включать HSTS только после стабильной проверки HTTPS;
3. выполнить `bash scripts/test-monitoring-alerts.sh --confirm` и дождаться уведомлений и возврата
   в `OK`.

## 5. Единственная проверка с реальными данными

1. открыть `/?utm_source=test` и отправить одну подписку;
2. открыть `/form/?utm_source=test` и отправить одну маркированную заявку;
3. проверить обе записи в Telegram/YDB и разделение `form_type` в метриках;
4. проверить визит в Яндекс Метрике; цели включать после реализации `reachGoal` из `TODO.md`;
5. проверить `/`, `/form/`, неизвестный URL и обе юридические страницы;
6. проверить security headers командой `curl -I` после распространения CDN-настроек.

После этого production можно считать полностью проверенным для пилотного приёма заявок. API Gateway
+ Smart Web Security, CSP и budget alerts остаются обязательным следующим уровнем до рекламного
трафика.
