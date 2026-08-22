---
type: decision
title: ZvenFit Estetika production monitoring decisions
updated: 2026-08-22
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

`max` был недостаточен: ошибки, распределённые по нескольким 5-минутным buckets,
не складывались и могли не достигнуть порога. Сразу после исправления live rule
получил результат `5` и корректно перешёл в `Warning`; это наблюдение относится
к окну проверки 22 августа 2026 года, а не является постоянным статусом сервиса.

## OTLP lifecycle timeout

Collect, export, force flush и shutdown — последовательные стадии, поэтому один
общий deadline создавал ложный `metrics_flush_timeout`, когда каждая стадия сама
укладывалась в допустимое время.

Принятое решение:

- каждая стадия получает независимый timeout; default — 3 секунды, допустимый
  диапазон конфигурации `100–5000` мс;
- зависший force flush возвращает `metrics_force_flush_timeout`;
- зависший exporter shutdown возвращает `metrics_shutdown_timeout`;
- callback export очищает собственный timer при любом исходе;
- ошибка метрик логируется, но не меняет результат приёма уже сохранённой заявки.

Реализация: [`otel-transport.ts`](../functions/telegram-lead/src/observability/otel-transport.ts).

## GitHub Actions variable isolation

Production-проверка 22 августа 2026 года выявила отдельный configuration drift:
workflow читал общее `vars.MONIUM_METRICS_TIMEOUT_MS`, а одноимённая
organization-level variable передала в функцию `1000` мс вместо проектного
default `3000` мс. Новая версия функции корректно разделяла lifecycle deadlines,
но зафиксировала реальные `metrics_export_timeout` примерно через одну секунду.

Принятое решение:

- workflow читает только проектно-специфичную GitHub Actions variable
  `ZVENFIT_ESTETIKA_MONIUM_METRICS_TIMEOUT_MS` с fallback `3000`;
- в runtime функции значение по-прежнему называется
  `MONIUM_METRICS_TIMEOUT_MS`;
- контрактный тест запрещает возвращать общее `vars.MONIUM_METRICS_TIMEOUT_MS`,
  чтобы organization-level настройка не могла снова молча изменить Estetika;
- после deploy сначала проверяется фактическое значение в логе workflow, затем
  отсутствие новых `metrics_export_timeout`; старый `Warning` может сохраняться
  до выхода событий из окна `30m` с задержкой `5m`.

## Verification and delivery state

На момент фиксации решения:

- live dashboard: 14 Estetika alerts, 0 ZvenFit alerts;
- live exporter alert: `sum`, `30m`, delay `5m`, thresholds `>2` / `>5`;
- monitoring contract tests: 44 passed;
- telegram-lead unit tests: 63 passed, deploy artifact check passed;
- dashboard и alert rule уже исправлены live;
- код независимых OTLP deadlines входит в тот же change set, что эта запись;
  до успешного production deploy старая версия продолжает выдавать
  `metrics_flush_timeout`. После доставки нужно проверить отсутствие новых
  событий с этим legacy-кодом и последующий переход alert в `OK`.
