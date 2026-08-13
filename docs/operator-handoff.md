# Что осталось сделать владельцу проекта

Код, тесты и CI-контур подготовлены. Ниже только действия, которые требуют ваших аккаунтов,
секретов, юридических решений или проверки реального сообщения. Значения секретов не присылайте в
чат и не коммитьте.

## 1. GitHub Environment `production` настроен

Уже настроены отдельными реквизитами Estetika:

- `YC_SA_JSON_KEY`;
- `YC_FOLDER_ID`;
- `LEAD_RATE_LIMIT_SECRET` — минимум 32 символа;
- `MONIUM_API_KEY`;
- `YC_ACCESS_KEY_ID`;
- `YC_SECRET_ACCESS_KEY`.

Настроены Variables:

- `YC_LEAD_SERVICE_ACCOUNT_ID`;
- параметры YDB, retry, таймаутов и Monium из `docs/setup.md`.

Также настроены отдельные `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `YANDEX_METRIKA_ID` и
`YDB_DATABASE_ID`. Все обязательные значения прошли production preflight и полный deploy; значения
секретов не выводились. Остальные variables имеют безопасные defaults и перечислены в
`docs/setup.md`. `zvenfit/zvenfit-frontend` публичный, поэтому отдельный `UPSTREAM_READ_TOKEN` не
требуется.

## 2. Yandex Cloud подготовлен

Созданы отдельные serverless YDB `zvenfit-estetika-leads`, функция
`zvenfit-estetika-telegram-lead`, runtime/CI service accounts и retry timer. Выданы только
resource-level роли YDB/Function, а CI получил ACL только бакета `zvenfit-estetika-frontend`.
Бакеты, YDB, функция и service accounts основного `zvenfit-frontend` не используются.

CI не выдаёт себе административные роли и намеренно остановится с понятным сообщением, если
одноразовая инфраструктура или binding отсутствуют.

## 3. Принять продуктовые решения до трафика

- подтвердить реквизиты и владельца персональных данных в юридических документах;
- согласовать отдельные согласия на обработку ПД и рекламную рассылку;
- считать `estetika.zvenfit.ru` единственным production-доменом; `www.estetika.zvenfit.ru` не поддерживать;
- отозвать Telegram token, если он когда-либо попадал в экспорт или HTML.

## 4. Первый deploy выполнен

Workflow [run #31722995673](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/31722995673)
выполнил preflight, integration-тест YDB, проверку готовой схемы, создание версии функции, сборку,
загрузку сайта и безопасный smoke-test без реальной заявки. Кеш CDN после первого deploy очищен.

После успеха:

1. добавить на CDN `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` и
   `Referrer-Policy` из `TODO.md`;
2. включать HSTS только после стабильной проверки HTTPS;
3. создать или проверить в Monium оба notification channel и 12 alerts строго по
   `scripts/monitoring.config.json` / `docs/monitoring.md`;
4. выполнить `bash scripts/test-monitoring-alerts.sh --confirm` и дождаться уведомлений и возврата
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
