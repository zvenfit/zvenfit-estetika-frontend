# Monitoring and alerts

Машиночитаемый desired state находится в
[`scripts/monitoring.config.json`](../scripts/monitoring.config.json). Он описывает девять log
metrics, четырнадцать alerts, два notification channels и компактный production dashboard. Эти
ресурсы относятся только к Estetika и не используют функции, YDB или бакеты `zvenfit-frontend`.

Log metrics, alert rules и channels остаются console-managed: публичные `yc` CLI и Terraform
provider не покрывают полный жизненный цикл этих ресурсов Monium. Dashboard переносится через
нативный JSON settings export/import из
[`scripts/monitoring.dashboard.json`](../scripts/monitoring.dashboard.json). Git хранит точную
проверенную конфигурацию, а read-only drift check сравнивает семантический desired state с
экспортированным live snapshot.

## Taxonomy и источники

| Уровень | Значение |
| --- | --- |
| Monium project | `folder__b1ge1e4iopttj79hfdfm` |
| Application | `zvenfit-estetika-frontend` |
| Environment | `production` |
| Component / log service | `zvenfit-estetika-telegram-lead` |
| Function resource | `zvenfit-estetika-telegram-lead` |
| YDB | `zvenfit-estetika-leads` |
| Retry trigger | `a1sc2t1ro4alukatrf99` |
| Raw logs | `cluster="default"`, `service="default"`, retention 3 дня |
| Log metric output | `cluster="default"`, `service="logging_aggregates"` |
| Direct gauges | `cluster="default"`, `service="zvenfit-estetika-frontend"` |

Cloud Function runtime errors приходят из системной серии
`cluster="default"`, `service="__serverless-functions__"`; duration и throttling остаются в
provider-серии `service="serverless-functions"`. Эти источники не взаимозаменяемы.

Pino пишет structured JSON в stdout Cloud Function. Во всех application logs присутствуют
`application`, `environment`, `service`, `event`, уровень и при наличии `request_id`. Логгер
редактирует имя, телефон, Telegram username, IP/rate key, UTM, body, headers, токены и секреты.
Ошибки представлены только безопасными полями `error_type`, `error_code`, `retriable`,
`upstream_status` и `stack_fingerprint`; исходный message и stack в лог не попадают. События
Telegram outbox дополнительно используют безопасные `notification_id`, `notification_kind`,
`attempts` и `outbox_pending`, не раскрывая payload уведомления.

Открыть raw logs:

```text
https://monium.yandex.cloud/projects/folder__b1ge1e4iopttj79hfdfm/logs
```

Базовый фильтр: `application=zvenfit-estetika-frontend`, `environment=production`,
`service=zvenfit-estetika-telegram-lead`. Для разбора инцидента добавьте `event`, `request_id`,
`submission_id`, `error_code` или `stack_fingerprint`.

## Log metrics

Дискретные события считаются log-derived metrics. Прямые invocation counters не используются:
одно событие, экспортированное за короткий invocation, могло интерпретироваться Monium как rate и
дать значение больше `1`. Log aggregate с `count` сохраняет настоящую семантику количества и
переживает обработанные приложением ошибки, которые не видны в platform `functions_errors`.

| Metric ID | События / фильтр | Окно |
| --- | --- | --- |
| `zvenfit_estetika_storage_errors_1m` | `submission_storage_error`, `telegram_delivery_retry_error` — домен/outbox | 1m |
| `zvenfit_estetika_telegram_failed_1m` | `telegram_delivery_failed_permanently` | 1m |
| `zvenfit_estetika_ydb_retries_5m` | `ydb_retry` | 5m |
| `zvenfit_estetika_ydb_slow_5m` | `ydb_slow_operation` | 5m |
| `zvenfit_estetika_rate_limit_errors_5m` | `submission_rate_limit_error` | 5m |
| `zvenfit_estetika_rate_limited_5m` | `submission_blocked`, `meta.reason=rate_limit` | 5m |
| `zvenfit_estetika_submissions_5m` | `submission_persisted`, group by `meta.form_type` | 5m |
| `zvenfit_estetika_retry_worker_log_heartbeat_1m` | `retry_worker_completed`, реальные timer logs | 1m |
| `zvenfit_estetika_monium_metrics_failures_5m` | ошибки init/config/export direct metrics | 5m |

`telegram_delivery_retry_scheduled`, `ydb_operation_completed` и `ydb_operation_failed` остаются
диагностическими log-only событиями. `ydb_operation_completed` содержит полную длительность,
retry count и агрегаты `query_execute_*`, но не SQL, параметры или данные обращения. Alert
`zvenfit_estetika_slow_ydb` реагирует только на медленный `query_execute`. Нестабильные YDB session
phases (`session_acquire` / `session_create`) намеренно не собираются и остаются техдолгом до
стабилизации диагностических каналов. Read-only операции `list_telegram_candidates` и
`get_telegram_queue_health` один раз повторяют transient `AbortError`, `TimeoutError`,
неклассифицированный `ClientError` и известные временные gRPC/transport-коды через новую query.
Явные постоянные коды, например `PERMISSION_DENIED`, не повторяются; write-path заявок этим
механизмом не затрагивается. Log heartbeat не имеет paging-alert: он независимо показывает работоспособность
цепочки Cloud Logging → log metric, а недоступность retry-worker уже покрыта прямым heartbeat.

## Direct gauges

Direct OTLP включается `MONIUM_METRICS_ENABLED=true`. Функция использует cumulative gauges и
добавляет ко всем точкам полный набор labels:

```text
application="zvenfit-estetika-frontend"
environment="production"
component="zvenfit-estetika-telegram-lead"
resource_id="zvenfit-estetika-telegram-lead"
```

Timer после успешного retry pass и чтения YDB экспортирует:

- `zvenfit_estetika_retry_worker_heartbeat=1`;
- `zvenfit_estetika_telegram_pending_notifications` — текущее число уведомлений в transactional outbox;
- `zvenfit_estetika_telegram_pending_submissions` — временный legacy alias того же значения на один
  rollout, чтобы старый live dashboard не потерял очередь;
- `zvenfit_estetika_telegram_oldest_pending_age_seconds` — возраст старейшей записи.

Явный ноль очереди экспортируется настоящей cumulative-точкой. Если retry pass, чтение YDB или
экспорт не завершились, heartbeat не записывается. Ошибка OTLP безопасно логируется как
`monium_metrics_init_error` или `monium_metrics_export_error` и не меняет результат приёма заявки.
Весь OTLP lifecycle — collect, export, force flush и shutdown — получает единый deadline 3 секунды
по умолчанию, жёстко ограниченный диапазоном `100–5000` мс. Поэтому зависший exporter не удерживает
invocation до общего timeout функции.

Эти ошибки вместе с `monium_metrics_misconfigured` считаются независимым log aggregate
`zvenfit_estetika_monium_metrics_failures_5m`: он остаётся видимым при поломке самого direct OTLP
path. Alert берёт максимум 5-минутного счётчика за последние 30 минут: три ошибки в одном
5-минутном интервале дают `Warning`, шесть — `Alarm`. Повторное суммирование точек скользящего
счётчика намеренно не используется, поэтому одиночный сетевой таймаут остаётся диагностической
точкой и не создаёт цикл `Warning → OK`. Задержка вычисления равна 5 минутам и совпадает с окном
исходной log metric, чтобы поздняя поставка точки не меняла уже вычисленное состояние.

## Notification channels

В Monium создаются два независимых канала:

- `zvenfit_estetika_telegram_alerts` — **ZvenFit Estetika · production · Telegram**, со screenshot;
- `zvenfit_estetika_email_alerts` — **ZvenFit Estetika · production · Email**.

По умолчанию оба канала подключаются к alerts доступности и доставки. Уведомления отправляются
при переходах `ALARM`, `WARNING` и `OK`, повтор активного состояния — каждые 30 минут.
Диагностический `zvenfit_estetika_slow_ydb` не пейджит в Telegram: для него остаётся только email
с повтором раз в сутки. Ошибки YDB, retry и backlog продолжают использовать обычную paging-политику.

## Alerts

| Alert ID | Сигнал | Warning / Alarm | No data |
| --- | --- | --- | --- |
| `zvenfit_estetika_storage_errors` | log count ошибок доменных записей/outbox | `>0` / `>0.5` | OK |
| `zfe_permanent_telegram_failures` | log count окончательных сбоев Telegram | `>0` / `>0.5` | OK |
| `zvenfit_estetika_ydb_retries` | log count YDB retries | `>4.5` / `>5.5` | OK |
| `zvenfit_estetika_slow_ydb` | log count медленных YDB операций | `>1.5` / `>2.5` | OK |
| `zvenfit_estetika_rate_limited` | log count блокировок | `>0` / `>5` | OK |
| `zvenfit_estetika_submission_volume` | log count lead + newsletter | `>10` / `>20` | OK |
| `zvenfit_estetika_rate_limit_health` | log count fail-open ошибок | `>0` / `>2` | OK |
| `zfe_monium_metrics_failures` | максимум 5m log count сбоев direct metrics exporter за 30m | `>2` / `>5` | OK |
| `zfe_retry_worker_heartbeat` | direct heartbeat, last | `<0.9` / `<0.5` | ALARM |
| `zvenfit_estetika_telegram_backlog` | direct oldest pending age | `>600` / `>1800` | OK |
| `zfe_function_runtime_errors` | Cloud Functions `functions_errors` | `>0` / `>0.5` | OK |
| `zvenfit_estetika_function_throttles` | Cloud Functions `functions_throttles` | `>0` / `>0.5` | OK |
| `zfe_retry_trigger_errors` | trigger access/runtime errors | `>0` / `>0.5` | OK |
| `zvenfit_estetika_ydb_storage_usage` | `(used_bytes / limit_bytes) * 100` | `>=70` / `>=85` | WARNING |

Префикс `zfe_` используется только для технических ID, которые вместе с обязательным
префиксом проекта Monium иначе превысили бы лимит в 64 символа. Полные display name и
таксономия `zvenfit-estetika-*` при этом не сокращаются.

Log aggregate alerts используют delay `3m`, чтобы дождаться поставки логов. Direct gauges и
platform metrics используют `30s`. Для `zvenfit_estetika_slow_ydb` учитывается только
`ExecuteQuery` дольше 3 секунд; инициализация YDB-клиента, получение и создание сессии исключены
из paging-сигнала и пока не экспортируются как отдельная telemetry.
Единичное превышение остаётся диагностикой, `Warning` требует минимум два превышения за 10 минут,
а `Alarm` — минимум три. Backlog предупреждает после 10
минут и алармит после 30. Только исчезновение retry heartbeat считается `Alarm`; отсутствие
storage metrics считается `Warning`, остальные no-data состояния — `OK`.

## Dashboard

Desired dashboard: **ZvenFit Estetika · production**,
ID `zvenfit-estetika-production-monitoring`.

```text
https://monium.yandex.cloud/projects/folder__b1ge1e4iopttj79hfdfm/dashboards/zvenfit-estetika-production-monitoring
```

Он содержит:

1. полноширинную строку **Быстрый доступ к логам**: канонические `INFO за час` и `ERROR за час`
   links с готовой Estetika taxonomy и диапазоном `now-1h` → `now`;
2. полноширинную памятку **Как читать дашборд** с порядком разбора потока
   Cloud Function → YDB/outbox → Telegram → retry-worker;
3. полноширинный **Состояние production** со статусами всех Estetika alerts;
4. ошибки и ограничения запуска единственной Cloud Function;
5. p95 длительности функции и прямой retry heartbeat;
6. ошибки хранения/outbox и окончательные сбои Telegram;
7. сохранённые обращения с разложением `lead` / `newsletter`;
8. полноширинный размер и возраст Telegram-очереди;
9. YDB retries и медленные `query_execute` рядом с заполнением отдельной
   `zvenfit-estetika-leads`;
10. ошибки rate limiter и retry-trigger рядом с диагностическим log-pipeline heartbeat;
11. независимый log-based график и alert сбоев Monium exporter.

Alert overview и четыре incident-triage графика повторяют operational-путь основной ZvenFit-борды,
но exact single-function selectors не создают ненужные multialerts. Empty error graph при зелёном
alert — нормальное состояние.

Dashboard намеренно не содержит Fitbase, расписание, traffic-function, CDN основного сайта или
бакеты `zvenfit-frontend`. Точные queries и selectors хранятся в конфиге.

## Provisioning и drift

После первого успешного deploy вручную создайте/обновите ресурсы в таком порядке:

1. девять log metrics;
2. Telegram и email channels;
3. четырнадцать alerts и общую notification policy;
4. импортировать `scripts/monitoring.dashboard.json` через Dashboard → Settings → JSON → Apply.

Нативный JSON содержит пятнадцать widgets: строку быстрых ссылок, памятку **Как читать дашборд**,
alert overview и двенадцать operational charts. После ручной правки live dashboard экспортируйте
его тем же экраном обратно в этот файл и запустите
`npm run test:monitoring`. Artifact предназначен только для dashboard import/export: log metrics,
alerts, channels и read-only drift snapshot у него отдельные контракты.

Затем экспортируйте live metadata в JSON с массивами `logMetrics`, `alerts`,
`notificationChannels`, объектами `notificationPolicy` и `dashboard`. Сравнение read-only и ничего
не меняет в Monium:

```bash
npm run check:monitoring-drift -- --snapshot /path/to/monium-live.json
```

Exit code `0` означает совпадение, `1` — drift, `2` — неверный input. Проверяются IDs,
display names, selectors, thresholds, delay/no-data, labels, channels, policy и dashboard. При
расхождении `notificationChannels.recipient` фактический email/chat identity заменяется на
`[redacted]` и не попадает в терминал или CI-log.

## Безопасная проверка

Smoke всегда пишет `environment=production`, независимо от локального `NODE_ENV`, и явно передаёт
`resource_type=serverless.function` / `resource_id=zvenfit-estetika-telegram-lead`, чтобы записи
совпадали с resource-aware selectors log metrics. Он содержит только синтетические технические
события без заявок и персональных данных. Smoke
намеренно переводит application log alerts в Warning/Alarm, поэтому требует явного подтверждения:

```bash
bash scripts/test-monitoring-alerts.sh --confirm
```

Проверьте доставку в Telegram и email, затем уведомления о возврате в `OK`. Runtime, throttling,
trigger, direct heartbeat и YDB storage проверяются только реальными platform metrics: намеренно
ронять функцию, timer или заполнять production YDB запрещено.

Контракты runtime/config/drift проверяются командами `npm run test:lead-fn` и
`npm run test:monitoring`.
