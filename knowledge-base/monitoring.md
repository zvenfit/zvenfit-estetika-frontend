---
type: decision
title: ZvenFit Estetika production monitoring decisions
updated: 2026-08-26
---

# Production monitoring decisions

## Sources of truth

- Dashboard: https://monium.yandex.cloud/projects/folder__b1ge1e4iopttj79hfdfm/dashboards/zvenfit-estetika-production-monitoring
- Native dashboard snapshot: [`scripts/monitoring.dashboard.json`](../scripts/monitoring.dashboard.json).
- Metrics, alerts and notification desired state: [`scripts/monitoring.config.json`](../scripts/monitoring.config.json).
- Operational procedure: [`docs/monitoring.md`](../docs/monitoring.md).

## Alert-list isolation in the shared Monium project

ZvenFit и ZvenFit Estetika используют один Monium project. Проверка 22 августа
2026 года показала, что смешивание алертов было не live drift самих alert rules и
не общей неспособностью Monium фильтровать `alertList`. Причиной была legacy-схема
виджета: `widgetScope: "projectId"` вместе с внешним `widget: "alertList"`
заставляли runtime игнорировать прикладной selector.

Принятое решение:

- сохранить один компактный `alertList`, а не набор отдельных status tiles;
- добавить в selector явный allowlist всех четырнадцати fully-qualified alert ID,
  построенный из массива `alerts` в `scripts/monitoring.config.json`;
- сохранить Estetika taxonomy `labels.application`, `labels.environment` и
  `labels.service` как дополнительную защиту и читаемый контекст;
- не возвращать `widgetScope` и внешний `widget` в JSON виджета;
- проверять контракт тестом: один список, четырнадцать ID, отсутствие legacy-полей.

После применения и перезагрузки live dashboard показал 14 алертов Estetika и
0 алертов основного ZvenFit. Это и есть критерий корректной изоляции.

## Metrics-exporter alert

`zfe_monium_metrics_failures` должен оставаться наблюдаемым даже при поломке
direct OTLP path, поэтому он использует независимый log aggregate
`zvenfit_estetika_monium_metrics_failures_5m`.

Принятая семантика alert rule:

- aggregation: `sum`;
- evaluation window: `30m`;
- delay: `5m`;
- `Warning`: результат `> 2`;
- `Alarm`: результат `> 5`.
- уровень карточки `Info`;
- уведомление только по email, без Telegram и повторной отправки.

`max` был недостаточен: ошибки, распределённые по нескольким 5-минутным buckets,
не складывались и могли не достигнуть порога. Сразу после исправления live rule
получил результат `5` и корректно перешёл в `Warning`; это наблюдение относится
к окну проверки 22 августа 2026 года, а не является постоянным статусом сервиса.

## Cloud Function runtime errors

Managed `functions_errors` имеет тип `DGAUGE`. Для сигнала «был хотя бы один упавший
invocation» используется `max` за 5 минут с порогами `>0` / `>0.5`, а не `sum`:
один platform error продолжает давать `Alarm`, но несколько поставленных точек одной
ошибки не выглядят как несколько независимых Request ID. Точное число invocation
восстанавливается по системным Cloud Function logs.

YDB client-preparation failures дополнительно фиксируют `initialization_attempts`.
Это отдельный счётчик от `retry_attempts`, который относится к read-only
query/session retry. Safe error normalization может извлечь только фиксированный
allowlist технических transient-кодов из message/details; произвольный текст ошибки
в structured event по-прежнему не попадает.
Transient YDB driver discovery использует до трёх попыток инициализации с
exponential backoff `250ms` / `500ms`; постоянные ошибки завершаются сразу.

## Retry-worker heartbeat isolation

Критичный `zfe_retry_worker_heartbeat` использует независимый log aggregate
`zvenfit_estetika_retry_worker_log_heartbeat_1m` по событию `retry_worker_completed`.
Direct gauge `zvenfit_estetika_retry_worker_heartbeat` остаётся диагностическим, поэтому
таймаут технического OTLP export больше не может создать ложный критичный сигнал о падении
retry-worker.

## OTLP lifecycle timeout

Collect, export, force flush и shutdown — последовательные стадии, поэтому один
общий deadline создавал ложный `metrics_flush_timeout`, когда каждая стадия сама
укладывалась в допустимое время.

Принятое решение:

- каждая стадия получает независимый timeout; default — 5 секунд, допустимый
  диапазон конфигурации `100–5000` мс;
- зависший force flush возвращает `metrics_force_flush_timeout`;
- зависший exporter shutdown возвращает `metrics_shutdown_timeout`;
- callback export очищает собственный timer при любом исходе;
- успешный flush логирует `monium_metrics_export_completed` с `duration_ms`;
- ошибка экспорта логируется как warning с `outcome`, `duration_ms`, безопасными
  `error_type` и `error_code`, но не меняет результат приёма уже сохранённой заявки.

Реализация: [`otel-transport.ts`](../functions/telegram-lead/src/observability/otel-transport.ts).

## GitHub Actions variable isolation

Production-проверка 22 августа 2026 года выявила отдельный configuration drift:
workflow читал общее `vars.MONIUM_METRICS_TIMEOUT_MS`, а одноимённая
organization-level variable передала в функцию `1000` мс вместо проектного
на тот момент default `3000` мс. Новая версия функции корректно разделяла lifecycle deadlines,
но зафиксировала реальные `metrics_export_timeout` примерно через одну секунду.

Принятое решение:

- workflow читает только проектно-специфичную GitHub Actions variable
  `ZVENFIT_ESTETIKA_MONIUM_METRICS_TIMEOUT_MS` с fallback `5000`;
- в runtime функции значение по-прежнему называется
  `MONIUM_METRICS_TIMEOUT_MS`;
- контрактный тест запрещает возвращать общее `vars.MONIUM_METRICS_TIMEOUT_MS`,
  чтобы organization-level настройка не могла снова молча изменить Estetika;
- после deploy сначала проверяется фактическое значение в логе workflow, затем
  частота новых `metrics_export_timeout`; старое состояние может сохраняться до
  выхода событий из окна `30m` с задержкой `5m`.

## Verification and delivery state

Анализ и production-rollout 26 августа 2026 года подтвердили:

- live dashboard: 14 Estetika alerts, 0 ZvenFit alerts;
- live exporter alert за последний час получил три `metrics_export_timeout` и входил в
  `Warning`, хотя direct retry heartbeat оставался равен `1`;
- до синхронизации exporter alert отправлял Telegram и email с повтором каждые 30 минут;
- workflow [#32971698420](https://github.com/zvenfit/zvenfit-estetika-frontend/actions/runs/32971698420)
  успешно развернул функцию с timeout `5000` мс и прошёл production smoke;
- после deploy появился `monium_metrics_export_completed` с `outcome=success` и
  `duration_ms=1054`; новых exporter timeout/error к моменту проверки не было;
- live `zfe_monium_metrics_failures` совпадает с desired state: `sum`, `30m`, delay `5m`,
  thresholds `>2` / `>5`, уровень `Info`, только email, без повторов;
- live `zfe_retry_worker_heartbeat` использует log aggregate по `retry_worker_completed`, `max`,
  окно `5m`, delay `3m`, `No data = Alarm`; проверка вернула `1`, статус `OK`.
