# Мониторинг Cloud Function

Машиночитаемый desired state находится в `scripts/monitoring.config.json`. Функция отправляет
критичные счётчики и здоровье retry-контура напрямую в Monium по OTLP. Логи остаются резервным
источником диагностики и не содержат имя, телефон, Telegram username, IP, UTM, body, headers или
секреты.

## Источники

- Monium project: `folder__b1ge1e4iopttj79hfdfm`;
- direct metrics: `cluster="default"`, `service="zvenfit-estetika-frontend"`;
- Cloud Logging: группа `default`, retention 3 дня;
- application/environment: `zvenfit-estetika-frontend` / `production`;
- function/database: `zvenfit-estetika-telegram-lead` / `zvenfit-estetika-leads`.

Прямой экспорт включается переменной `MONIUM_METRICS_ENABLED=true`. Секрет `MONIUM_API_KEY`
должен иметь право записи метрик; `MONIUM_PROJECT` по умолчанию равен `folder__<YC_FOLDER_ID>`.
Функция использует DELTA temporality и одноразовый exporter на invocation, поэтому сброс процесса
не искажает счётчики. Ошибка экспорта логируется безопасным кодом и не влияет на приём заявки.

## События и прямые метрики

| Event | Прямая метрика | Назначение |
|---|---|---|
| `submission_storage_error` | `zvenfit_estetika_storage_errors` | Заявку не удалось сохранить |
| `telegram_delivery_retry_error` | `zvenfit_estetika_storage_errors` | Retry не смог обработать сохранённую запись |
| `telegram_delivery_failed_permanently` | `zvenfit_estetika_telegram_failed_1m` | Попытки Telegram исчерпаны |
| `submission_rate_limit_error` | `zvenfit_estetika_rate_limit_errors_5m` | Rate limiter недоступен, запрос пропущен fail-open |
| `submission_blocked` с `reason=rate_limit` | `zvenfit_estetika_rate_limited_5m` | Антиспам отклонил запрос |
| `submission_persisted` | `zvenfit_estetika_submissions_5m` + `form_type` | Сохранённая lead/newsletter запись |
| `ydb_retry` | `zvenfit_estetika_ydb_retries_5m` | YDB SDK повторил операцию |
| `ydb_slow_operation` | `zvenfit_estetika_ydb_slow_5m` | Превышен `YDB_SLOW_OPERATION_MS` |

Диагностические log-only события: `telegram_delivery_retry_scheduled`,
`ydb_operation_completed`, `ydb_operation_failed`.

Timer после retry pass экспортирует:

- `zvenfit_estetika_retry_worker_heartbeat=1`;
- `zvenfit_estetika_telegram_pending_submissions` — размер очереди для dashboard;
- `zvenfit_estetika_telegram_oldest_pending_age_seconds` — возраст старейшей записи.

## Алерты

В Monium вручную создаются два независимых канала: `zvenfit_estetika_telegram_alerts` и
`zvenfit_estetika_email_alerts`. Подключить оба канала ко всем алертам из конфига и уведомлять о
переходах `ALARM`, `WARNING`, `OK` с повтором каждые 30 минут.

| Alert ID | Сигнал | Warning / Alarm | No data |
|---|---|---|---|
| `zvenfit_estetika_storage_errors` | direct storage counter | `>0` / `>0.5` | OK |
| `zvenfit_estetika_permanent_telegram_failures` | direct permanent failure | `>0` / `>0.5` | OK |
| `zvenfit_estetika_ydb_retries` | direct retry sum | `>4.5` / `>5.5` | OK |
| `zvenfit_estetika_slow_ydb` | direct slow-operation sum | `>0.5` / `>2.5` | OK |
| `zvenfit_estetika_rate_limited` | direct blocked sum | `>0` / `>5` | OK |
| `zvenfit_estetika_submission_volume` | direct accepted volume | `>10` / `>20` | OK |
| `zvenfit_estetika_retry_worker_heartbeat` | latest heartbeat | `<0.9` / `<0.5` | ALARM |
| `zvenfit_estetika_telegram_backlog` | oldest pending, seconds | `>600` / `>1800` | OK |
| `zvenfit_estetika_rate_limit_health` | fail-open errors | `>0` / `>2` | OK |
| `zvenfit_estetika_function_runtime_errors` | Cloud Functions errors | `>0` / `>0.5` | OK |
| `zvenfit_estetika_ydb_storage_usage` | `(used / limit) * 100` | `>=70` / `>=85` | WARNING |

Heartbeat пишется только после успешного retry pass и чтения здоровья очереди. Он имеет корректно
упорядоченные пороги для оператора `<` и `No data = ALARM`: исчезновение timer, YDB или OTLP-точек
не выглядит как норма. Нулевые queue gauges экспортируются
как CUMULATIVE instant values, поэтому пустая очередь остаётся настоящей точкой, а не no-data.
Backlog предупреждает после 10 минут и алармит после 30 минут. Для storage отсутствие данных
считается `WARNING`.

Селекторы, агрегации, окна и задержки зафиксированы в `scripts/monitoring.config.json`. Они
создаются в консоли после первого успешного deploy, потому что notification channels и alerts не
представлены как управляемые ресурсы используемого публичного `yc` CLI/Terraform provider.

## Безопасная проверка

Скрипт ниже пишет только синтетические технические события и не создаёт заявок:

```bash
bash scripts/test-monitoring-alerts.sh --confirm
```

После настройки проверить доставку в Telegram и email, затем возврат алертов в `OK`. Контракт
репозитория проверяется командой `npm run test:monitoring`.
