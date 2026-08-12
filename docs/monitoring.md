# Мониторинг Cloud Function

Машиночитаемый desired state находится в `scripts/monitoring.config.json`. Создание log metrics,
notification channels и alerts выполняется один раз после первого production-деплоя через Monium:
эти ресурсы пока не управляются используемым проектом через `yc` или CI.

## Источник логов

- project: `folder__b1ge1e4iopttj79hfdfm`;
- log group: `default`, retention 3 дня;
- `application="zvenfit-estetika-frontend"`;
- `environment="production"`;
- function: `zvenfit-estetika-telegram-lead`.

Функция пишет structured JSON через Pino. Имя, телефон, Telegram username, IP, UTM, body,
headers и секреты автоматически заменяются на `[REDACTED]`. Для корреляции используются только
`request_id`, технический `submission_id`, `event`, безопасный `error_code` и счётчики.

## События

| Event | Назначение |
|---|---|
| `submission_storage_error` | Заявку или подписку не удалось сохранить |
| `submission_blocked` | Origin, honeypot, размер или rate limit заблокировал запрос |
| `submission_rate_limit_error` | Rate limit недоступен; запрос пропущен fail-open |
| `submission_persisted` | Новая запись сохранена; поле `form_type` разделяет lead/newsletter |
| `telegram_delivery_retry_error` | Timer не обработал сохранённую запись |
| `telegram_delivery_retry_scheduled` | Telegram временно недоступен, назначен retry |
| `telegram_delivery_failed_permanently` | Попытки Telegram исчерпаны |
| `ydb_operation_completed` | Длительность операции и число retry YDB SDK |
| `ydb_retry` | YDB SDK повторил временно неуспешную операцию |
| `ydb_slow_operation` | Превышен `YDB_SLOW_OPERATION_MS` |
| `ydb_operation_failed` | Операция YDB завершилась ошибкой |

## Что создать после деплоя

Создать две независимые точки доставки:

- `zvenfit_estetika_telegram_alerts` — Telegram через Yandex Cloud Notify bot;
- `zvenfit_estetika_email_alerts` — резервная email-доставка.

Оба канала подключить ко всем алертам из конфига:

- `zvenfit_estetika_storage_errors`;
- `zvenfit_estetika_permanent_telegram_failures`;
- `zvenfit_estetika_ydb_retries`;
- `zvenfit_estetika_slow_ydb`;
- `zvenfit_estetika_rate_limited`;
- `zvenfit_estetika_function_runtime_errors`;
- `zvenfit_estetika_ydb_storage_usage`.

Log metrics создаются по массиву `logMetrics` из конфига. Метрику
`zvenfit_estetika_submissions_5m` группировать по `form_type`, чтобы отдельно видеть заявки и
подписки. Runtime errors брать из автоматической метрики Cloud Functions, заполнение базы — как
процент `resources.storage.used_bytes / resources.storage.limit_bytes`.

После настройки выполнить безопасный smoke-тест, который пишет только синтетические технические
события и не создаёт заявок:

```bash
bash scripts/test-monitoring-alerts.sh --confirm
```

Проверить получение уведомлений в Telegram и email и последующий возврат алертов в `OK`.

Контракт репозитория проверяется командой `npm run test:monitoring`.
