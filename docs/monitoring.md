# Monitoring and alerts

Машиночитаемый desired state находится в
[`scripts/monitoring.config.json`](../scripts/monitoring.config.json). Он описывает десять log
metrics, пятнадцать alerts, два notification channels и компактный production dashboard. Эти
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
| Raw logs | `cluster="default"`, `service="default"`, desired retention 14 дней; фактическое значение проверяется у общей Cloud Logging group |
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
| `zvenfit_estetika_retry_worker_deferred_1m` | `retry_worker_deferred`, временный отказ чтения очереди | 1m |
| `zvenfit_estetika_retry_worker_log_heartbeat_1m` | `retry_worker_completed`, реальные timer logs | 1m |
| `zvenfit_estetika_monium_metrics_failures_5m` | ошибки init/config/export direct metrics | 5m |

`telegram_delivery_retry_scheduled`, `ydb_operation_completed` и `ydb_operation_failed` остаются
диагностическими log-only событиями. `ydb_operation_completed` содержит полную длительность,
retry count и агрегаты `query_execute_*`, но не SQL, параметры или данные обращения. Alert
`zvenfit_estetika_slow_ydb` реагирует только на медленный `query_execute`. Session traces
(`session_acquire` / `session_create`) используются только для локализации ошибки:
агрегаты `session_*`, отдельные slow-события и графики session latency не добавляются.

Read-only операции `list_telegram_candidates` и `get_telegram_queue_health` выполняют
повторы через YDB adapter в пределах общего бюджета, без ограничения тремя попытками.
Паузы — 500–749 мс, 1000–1499 мс, затем 2000–2999 мс. Каждый повтор создаёт новую
query. Один общий AbortSignal ограничивает получение сессии, query, внутренние
повторы SDK и паузы. Бюджет каждого чтения после подготовки клиента —
`min(2 × YDB_QUERY_TIMEOUT_MS, 20000)` мс; при default Estetika `10000` это 20 секунд.
Таймаут отдельной query остаётся 10 секунд. Если следующая пауза не помещается,
возвращается последняя ошибка. Просроченный результат не принимается даже при
задержке таймера event loop. Исчерпание бюджета отменяет запрос и даёт
`ydb_read_budget_exhausted`. Подготовка клиента имеет собственную retry policy;
20 секунд ограничивают одно чтение, не весь worker. Границы модулей и альтернативы —
[ADR-001](decisions/001-queue-read-recovery.md).

Явные постоянные коды, например `PERMISSION_DENIED`, не повторяются даже через wrapper
с именем `TimeoutError`. `AbortError/ABORT_ERR` от отмены паузы SDK допускает повтор
только в пределах общего бюджета и при отсутствии постоянного протокольного кода.
Запись заявки, события согласия рассылки и transactional outbox, claim/mark уведомления
этим механизмом не повторяются. Log heartbeat — основной paging-сигнал активности retry-worker:
он строится по `retry_worker_completed` и не зависит от direct OTLP exporter. Direct heartbeat
остаётся диагностическим вторым сигналом для разбора расхождений между Cloud Logging и Monium
metrics ingestion.

`ydb_retry` означает успешное восстановление и содержит безопасные поля последней
ошибки, приведшей к повтору: `error_type`, `error_code`, `retry_source=sdk|read_fallback`,
`phase` и, при наличии trace, `failed_phase_duration_ms`. `phase_source=error_trace`
означает точную связь с ошибкой trace; `active_trace` — снимок активной фазы при отмене,
когда SDK вернул deadline раньше завершения RPC. Это длительность до снимка, а не
до завершения RPC. Фазы принадлежат попыткам SDK: вложенный retry получения credentials
не удаляет внешнюю фазу, поздняя отмена старой попытки не описывает следующую.
Общая `duration_ms` включает повторы; `query_execute_*` описывают только ExecuteQuery.
Без соответствующего trace используется `phase=unknown`; отсутствие ExecuteQuery
само по себе не назначает session-фазу. Эти поля доступны также в `ydb_operation_failed`.
Событие `ydb_retry` остаётся одним на восстановленную операцию; `retry_attempts`
считает начатые повторы, а не ожидание backoff.

В `ydb_operation_failed.prior_error` сохраняются только безопасные диагностические
поля предыдущей прикладной ошибки, снятые до backoff; если её нет — последнего повтора
SDK. Текущая ошибка остаётся в верхних полях. При отмене во время backoff исходная
ошибка также сохраняется в `cause` только в памяти: это не позволяет превратить
неизвестный сбой в известный timeout. Перед началом следующей query `cause`
сбрасывается, а безопасный `prior_error` остаётся. При отмене в backoff `phase`
остаётся `unknown`, trace предыдущего RPC находится в `prior_error.phase`;
в селекторах используйте полный путь поля.
`prior_error.retry_source` обозначает механизм, назначивший повтор, и может быть
`read_fallback` при `retry_attempts=0`, если бюджет закончился до старта повтора.
Неудачная операция не пишет
`ydb_retry`: явно временный отказ чтения учитывается deferred/heartbeat alerts,
неизвестная или постоянная ошибка — runtime alert. Для сравнения со старыми
двойными таймаутами используйте также `prior_error.error_code`, `phase` и число попыток:
общий бюджет включает backoff, поэтому может завершить вторую query раньше её
собственного deadline. Новое имя ошибки не доказывает новый инцидент или его устранение.
Числовые статусы YDB/gRPC сохраняются как технические коды без SQL, параметров и issues.

Для Telegram поле `telegram_phase=route_probe|send_message` различает проверку маршрута
и отправку. Неоднозначный таймаут POST не вызывает немедленную отправку по другому
маршруту; следующая попытка по-прежнему выполняется через transactional outbox.

Порог slow-события в runtime — `YDB_SLOW_OPERATION_MS`, default `3000` мс.
CI читает только `vars.ZVENFIT_ESTETIKA_YDB_SLOW_OPERATION_MS`, чтобы общая переменная
Environment/organization не меняла настройку Estetika. Desired Warning остаётся `>1.5`
(два события за 10 минут), Alarm — `>2.5`; синхронизация live rule выполняется отдельно
от deploy функции. Изменение порога не является исправлением таймаутов чтения YDB.

Общая группа `default` (`e23fnr42117phjg4r2oe`) должна хранить 14 дней логов в паритете
с upstream. Проверка: `yc logging group get --id e23fnr42117phjg4r2oe --format json`;
ожидается `retention_period=1209600s`. Она содержит источники обоих проектов, поэтому
изменение её политики действует на всю группу. Уже удалённые записи не восстанавливаются.
Изменение `source.retentionDays` в Git само по себе не меняет retention в облаке.

## Direct gauges

Direct OTLP включается `MONIUM_METRICS_ENABLED=true`. Функция использует cumulative gauges и
добавляет ко всем точкам полный набор labels:

```text
application="zvenfit-estetika-frontend"
environment="production"
component="zvenfit-estetika-telegram-lead"
resource_id="zvenfit-estetika-telegram-lead"
```

Timer после успешного retry pass и чтения YDB экспортирует диагностические gauges:

- `zvenfit_estetika_retry_worker_heartbeat=1`;
- `zvenfit_estetika_telegram_pending_notifications` — текущее число уведомлений в transactional outbox;
- `zvenfit_estetika_telegram_pending_submissions` — временный legacy alias того же значения на один
  rollout, чтобы старый live dashboard не потерял очередь;
- `zvenfit_estetika_telegram_oldest_pending_age_seconds` — возраст старейшей записи.

Явный ноль очереди экспортируется настоящей cumulative-точкой. Если retry pass, чтение YDB или
экспорт не завершились, direct heartbeat не записывается, но отказ OTLP сам по себе больше не
ломает критичный heartbeat alert. Ошибка OTLP безопасно логируется как
`monium_metrics_init_error` или `monium_metrics_export_error` и не меняет результат приёма заявки.
Успешный flush пишет диагностическое `monium_metrics_export_completed` с `outcome=success` и
`duration_ms`; сбой пишет `WARN` с `outcome=failure`, `duration_ms`, безопасными `error_type` и
`error_code`. Каждый этап OTLP lifecycle — collect, export, force flush и shutdown — получает
собственный deadline 5 секунд по умолчанию, жёстко ограниченный диапазоном `100–5000` мс.
Последовательные этапы не расходуют один общий таймер, поэтому нормальный медленный export не
превращается в ложный `metrics_flush_timeout`, а зависший cleanup остаётся ограничен по времени.

Эти ошибки вместе с `monium_metrics_misconfigured` считаются независимым log aggregate
`zvenfit_estetika_monium_metrics_failures_5m`: он остаётся видимым при поломке самого direct OTLP
path. Alert суммирует 5-минутные счётчики за последние 30 минут: три ошибки за 30 минут дают
`Warning`, шесть — `Alarm`. Поэтому распределённые по разным buckets сбои больше не скрываются
агрегацией `max`. Задержка вычисления равна 5 минутам и совпадает с окном исходной log metric,
чтобы поздняя поставка точки не меняла уже вычисленное состояние. Это непейджинговый технический
alert уровня `Info`: он отправляет одно email-уведомление без Telegram и без повторов.

## Notification channels

В Monium создаются два независимых канала:

- `zvenfit_estetika_telegram_alerts` — **ZvenFit Estetika · production · Telegram**, со screenshot;
- `zvenfit_estetika_email_alerts` — **ZvenFit Estetika · production · Email**.

По умолчанию оба канала подключаются к alerts доступности и доставки. Уведомления отправляются
при переходах `ALARM`, `WARNING` и `OK`, повтор активного состояния — каждые 30 минут.
Диагностические `zvenfit_estetika_ydb_retries` и `zvenfit_estetika_slow_ydb` имеют
уровень INFO: только email без повторной отправки. `zfe_monium_metrics_failures`
также использует только email без повторов (`0s`, «Никогда» в UI).
Повторные deferred-проходы, storage errors, отсутствие heartbeat, backlog,
окончательные сбои доставки и неизвестные runtime failures сохраняют paging-политику.

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
| `zfe_monium_metrics_failures` | сумма 5m log count сбоев exporter за 30m; email only, no repeat | `>2` / `>5` | OK |
| `zfe_retry_worker_deferred` | sum отложенных проходов за 10m | `>2` / `>2.5` | OK |
| `zfe_retry_worker_heartbeat` | log aggregate `retry_worker_completed`, max | `<0.9` / `<0.5` | ALARM |
| `zvenfit_estetika_telegram_backlog` | direct oldest pending age | `>600` / `>1800` | OK |
| `zfe_function_runtime_errors` | Cloud Functions `functions_errors` | `>0` / `>0.5` | OK |
| `zvenfit_estetika_function_throttles` | Cloud Functions `functions_throttles` | `>0` / `>0.5` | OK |
| `zfe_retry_trigger_errors` | trigger access/runtime errors | `>0` / `>0.5` | OK |
| `zvenfit_estetika_ydb_storage_usage` | `(used_bytes / limit_bytes) * 100` | `>=70` / `>=85` | WARNING |

Managed `functions_errors` — это `DGAUGE`, а не дискретный log count. Runtime-error alert
использует `max` за окно 5 минут: одна ошибка по-прежнему немедленно даёт `Alarm`, но повторные
точки одной platform-серии не складываются в вводящий в заблуждение псевдосчётчик invocation.
Точное число упавших запусков подтверждается по системным `ERROR ... RequestID` в raw logs.

Префикс `zfe_` используется только для технических ID, которые вместе с обязательным
префиксом проекта Monium иначе превысили бы лимит в 64 символа. Полные display name и
таксономия `zvenfit-estetika-*` при этом не сокращаются.

Log aggregate alerts используют delay `3m`, чтобы дождаться поставки логов; exporter alert
с 5-минутными buckets использует `5m`. Direct gauges и platform metrics используют `30s`.
Для `zvenfit_estetika_slow_ydb` учитывается только
`ExecuteQuery` дольше 3 секунд; инициализация YDB-клиента, получение и создание сессии исключены
из slow-query paging-сигнала. Ошибка подготовки клиента пишет отдельные
`phase=client_preparation` и `initialization_attempts`; `retry_attempts` остаётся счётчиком
повторов read-only query/session path и не смешивается с инициализацией driver.
Transient discovery-сбой при подготовке driver допускает до трёх попыток с
exponential backoff `250ms` / `500ms`; постоянные ошибки не повторяются.
Единичное превышение остаётся диагностикой, `Warning` требует минимум два превышения за 10 минут,
а `Alarm` — минимум три. Backlog предупреждает после 10
минут и алармит после 30. Только исчезновение log-derived retry heartbeat считается `Alarm`; отсутствие
storage metrics считается `Warning`, остальные no-data состояния — `OK`.

### Повторные отложенные проходы

YDB adapter переводит в `QueueReadUnavailableError` только доказанный transient-код,
DOM `TimeoutError` или собственный deadline без неизвестной причины. Обычный
`ClientError`, generic `TimeoutError`, текст ошибки и постоянные коды не дают
основания для deferred. При отмене в backoff неизвестная причина остаётся runtime
failure. Классификация для deferred строже разрешения попробовать SELECT снова.

Timer пишет `retry_worker_deferred` и возвращает `{deferred: true, stage}`;
`stage=delivery` означает сбой выборки до доставки, `queue_health` — сбой последующего
чтения состояния. Успешный heartbeat и queue gauges не публикуются. Уже сохранённая
доставка не откатывается и не отправляется заново из-за отказа health. Доменные
записи, состояния согласий рассылки, lease и delivery token не меняются от чтения.
HTTP storage failures по-прежнему возвращают 503; ошибки обработки отдельной записи
outbox сохраняют `telegram_delivery_retry_error` и критический storage alert.

Алерт `zfe_retry_worker_deferred`: count за 1 минуту, `sum > 2.5` за 10 минут,
delay 3 минуты, `No data = OK`, CRITICAL, Telegram/email. Три прохода в окне,
не обязательно подряд, дают Alarm; один-два остаются логами. Warning `>2` при
целочисленном count достигается одновременно с Alarm. Полная остановка дополнительно
покрывается log heartbeat (`5m`, delay `3m`, `No data = ALARM`). Backlog с `No data = OK`
не заменяет эти сигналы, если health невозможно прочитать.

Deferred-result успешен на уровне платформы: восстановление ожидается на следующем
минутном timer, а не через настроенные повторы неуспешного invocation через 30 секунд.
Уведомление по deferred alert учитывает задержку поставки логов и не мгновенно.

### Согласованный rollout и откат

Desired state содержит 10 log metrics и 15 alerts. Сначала создать deferred metric/alert
и включить его в 15-ID dashboard allowlist, проверить каналы и selectors. Затем
развернуть функцию и подтвердить успешные heartbeat, gauges и восстановление worker.
Сверить live INFO/email/no-repeat у retry/slow alerts. До внедрения новый event metric
может быть пустым; это не проверка доставки. JSON в Git сам настройки Monium не меняет.

При откате вернуть предыдущую версию функции; runtime, storage, heartbeat и backlog
продолжают покрывать отказы. Deferred metric можно оставить пустой (`No data = OK`).
Первопричина длинных YDB-задержек, p95 и live drift проверяются отдельно.

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
3. компактный `alertList` с явным allowlist полных ID всех Estetika alerts; legacy-поля
   `widgetScope: "projectId"` и внешний `widget: "alertList"` не используются, потому что
   с ними Monium игнорировал прикладной selector и смешивал alerts shared project;
4. ошибки и ограничения запуска единственной Cloud Function;
5. p95 длительности функции и диагностический direct retry heartbeat;
6. ошибки хранения/outbox и окончательные сбои Telegram;
7. сохранённые обращения с разложением `lead` / `newsletter`;
8. полноширинный размер и возраст Telegram-очереди;
9. YDB retries и медленные `query_execute` рядом с заполнением отдельной
   `zvenfit-estetika-leads`;
10. ошибки rate limiter и retry-trigger рядом с основным log-derived paging heartbeat;
11. независимый log-based график и непейджинговый alert сбоев Monium exporter.

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
компактный alert-list с allowlist четырнадцати alert ID и двенадцать operational charts. После ручной правки live dashboard экспортируйте
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

Проверьте доставку в Telegram и email, затем уведомления о возврате в `OK`. Для
`zfe_monium_metrics_failures`, `zvenfit_estetika_ydb_retries` и `zvenfit_estetika_slow_ydb`
ожидается только email без Telegram и повторной отправки. Новый deferred alert
проверяется естественными событиями; синтетический smoke его не генерирует. Runtime,
throttling, trigger, direct gauges и YDB storage проверяются только реальными platform metrics:
намеренно ронять функцию, timer или заполнять production YDB запрещено.

Контракты runtime/config/drift проверяются командами `npm run test:lead-fn` и
`npm run test:monitoring`.
