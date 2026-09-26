# Паритет архитектуры и алертов — 25 сентября 2026

Статус: исходный технический аудит на Estetika `069b804`, сохранён как обоснование.
По его результатам реализована адаптация: [ADR-001](decisions/001-queue-read-recovery.md),
[актуальный паритет](upstream-parity.md).
Ниже «сейчас» и результаты проверок относятся к исходному срезу до реализации.
Новый runtime-код и desired state подготовлены в репозитории; production rollout
пока не подтверждён.

## Источники и вывод

Проверен последний слитый [upstream PR #72](https://github.com/zvenfit/zvenfit-frontend/pull/72),
`fix: recover transient queue reads and page on delivery impact`:
29 файлов, head `c9dca8018cc49621e92e6fbbc031cedb736257b3`, merge
`3fe212e813f0d9f117eea14b246e63fc3bf73cdd`, 25 сентября 18:59 МСК.
Изучены diff, итоговый read-retry, worker, классификация ошибок, тесты и monitoring config.
Estetika проверена на `069b80457b541cf673f9545d0b6b4d3aafaa0c2c`:
[PR #27](https://github.com/zvenfit/zvenfit-estetika-frontend/pull/27) уже слит
и содержит адаптацию предыдущего upstream PR #71.

**Перенос #72 целесообразен одним согласованным изменением worker и мониторинга.**
Основная польза — более устойчивое чтение очереди и разделение краткого временного
отказа, повторяющегося нарушения работы worker и ошибок сохранения/доставки.
Новые сервисы, очередь сообщений или миграция схемы для этого не нужны.

В [разборе Estetika 24 сентября](monitoring-review-2026-09-24.md) подтверждены
шесть неудачных чтений очереди: пять примерно по 20 секунд и одно за 1,068 секунды.
После каждого успешный heartbeat появлялся через 12–33 секунды с пустой очередью.
Это обосновывает отдельный результат отложенного прохода, но не доказывает
устранение долгих задержек YDB или отсутствие проблем у каждой отдельной заявки.
Повторный доступ к production в этом аудите не выполнялся.

## Разница с текущей Estetika

| Область | Upstream #72 | Estetika сейчас | Рекомендация |
| --- | --- | --- | --- |
| Повторы двух чтений очереди | Ограничены общим временем; паузы 500 мс, 1 с, затем 2 с, jitter до 50% | Максимум 3 попытки; паузы 250–374 и 500–749 мс | Перенести политику, сохранить бюджет Estetika |
| Ответственность за retry | YDB adapter запускает retry; observability только наблюдает | `observability/ydb.ts` сам вызывает `retryRead` | Разделить выполнение и диагностику |
| Временная недоступность чтения | Adapter возвращает типизированную ошибку порта; worker выдаёт deferred-result | Ошибка `listCandidates`/`getQueueHealth` отклоняет timer invocation | Добавить узкий контракт временной недоступности |
| Timer orchestration | Отдельный worker: доставка, health, heartbeat | Код находится в `handler.ts` | Вынести в `application/retry-worker.ts` |
| Повторные deferred-проходы | Отдельные event, log metric и критический alert | Отсутствуют | Добавить одновременно с deferred-поведением |
| Успешные YDB retries | INFO, только email, без повторов | Общие Telegram/email, повтор 30 минут | Перенести диагностическую политику |
| Успешные медленные query | INFO, только email, без повторов | Только email, повтор раз в сутки | Убрать повтор, явно задать INFO |
| Ошибки сохранения и outbox | Storage metric включает оба класса событий | Уже включает `submission_storage_error` и `telegram_delivery_retry_error` | Сохранить существующее покрытие |
| Heartbeat | Только успешный проход и успешное чтение health | Уже такой же контракт, независимый log aggregate | Сохранить при введении deferred |

## Предлагаемые границы кода

- `ydb/read-retry-policy.ts`: классификация ошибок и capped backoff.
- `ydb/read-retry.ts`: deadline, AbortSignal и исполнение повторов.
- `ydb/read-operation.ts`: подготовка клиента, retry и подключение наблюдения.
- `ydb/queue-read.ts`: перевод только доказанного временного отказа чтения
  в ошибку контракта `application/queue-read-unavailable.ts`.
- `application/retry-worker.ts`: результат прохода, вызовы существующих
  `retryPendingNotifications`/`outbox.getQueueHealth`, heartbeat и gauges.
- `observability/ydb.ts`: tracing и безопасные поля без управления retry.
- Общий обход `error.cause` вынести из observability в нейтральный модуль,
  чтобы retry policy не зависела от логирования.

Существующие `application/ports.ts`, доменные repository и отдельный
`telegram_outbox` уже дают нужную основу. Копировать upstream `store` или
вводить его composition/staging-структуру для этого изменения не требуется.

## Что нужно адаптировать, а не копировать

1. **Две разновидности уведомлений.** Один outbox хранит `lead_created` и
   `newsletter_subscription_requested`. Deferred и восстановление должны работать
   для обоих типов. Запись доменных данных и outbox остаётся транзакционной;
   deferred не означает подтверждение подписки и не меняет consent state.
2. **Таймауты.** Сохранить query timeout 10 секунд и общий бюджет 20 секунд
   на каждое из двух чтений. Подготовка клиента имеет собственную политику;
   бюджет чтения не является бюджетом всего worker. Успешные ExecuteQuery
   6,29–9,954 секунды из предыдущего разбора не позволяют обосновать сокращение
   query timeout. Backoff помогает серии быстрых сбоев, но не устраняет саму
   причину долгих зависаний.
3. **Два уровня классификации.** Разрешение повторить SELECT шире разрешения
   завершить invocation как deferred. Неизвестный `ClientError`, произвольный
   текст «timeout», постоянный код и ошибка конфигурации должны оставаться
   ошибками. Общий `catch` с успешным результатом недопустим.
4. **Причина исчерпания бюджета.** В Estetika текущий timeout не сохраняет
   исходную ошибку в `cause`; её безопасный снимок хранится в `prior_error`.
   Для новой классификации нужно также сохранить последнюю причину в памяти,
   особенно при отмене во время backoff. Иначе неизвестный `ClientError`
   может превратиться в «известный» `ydb_read_budget_exhausted` и скрыться
   от runtime alert. Диагностический снимок до паузы (`onRetryScheduled`)
   сохранить независимо от нового `cause`; raw error/SQL/PII не логировать.
5. **Корректный результат worker.** Deferred не пишет `retry_worker_completed`
   и не публикует нулевые queue gauges. Стадии различаются: выборка/доставка
   и чтение health. Если доставка уже сохранена, отказ health не должен
   приводить к повторной отправке на следующем проходе.
6. **Расписание.** Runbook задаёт минутный timer с двумя повторами ошибки
   через 30 секунд. Успешный deferred-result будет полагаться на следующий
   плановый запуск, а не на повторы неуспешного invocation. Это осознанное
   изменение времени восстановления; live-параметры trigger перед rollout
   требуется сверить.
7. **Изоляция проекта.** Сохранить `zvenfit_estetika_*`, resource IDs, labels,
   query-only latency metrics, log heartbeat, lease/delivery token и правила
   Telegram POST. Session traces остаются диагностикой фазы; переносить
   upstream session latency dashboard для паритета #72 не требуется.

## Предлагаемые алерты

Новая log metric `zvenfit_estetika_retry_worker_deferred_1m`: событие
`retry_worker_deferred`, count за 1 минуту, taxonomy/groupBy как у heartbeat.
Новый alert `zfe_retry_worker_deferred` (короткий ID для ограничения полного
Monium ID): `sum`, окно 10 минут, delay 3 минуты, warning `>2`, alarm `>2.5`,
`No data = OK`, CRITICAL, Telegram + email. Это три прохода **в окне**, не
обязательно подряд; при целочисленном count оба порога достигаются на третьем
событии. Задержка ingestion означает, что уведомление не мгновенное.

Количество log metrics увеличится с 9 до 10, alerts — с 14 до 15. Новый ID
должен войти в allowlist единственного dashboard alertList. Сохранить
Estetika `labels.*` selector и запрет legacy `widgetScope`/внешнего `widget`.

Для `zvenfit_estetika_ydb_retries` и `zvenfit_estetika_slow_ydb` установить
INFO, только `zvenfit_estetika_email_alerts`, `repeatMinutes: 0`.
Их пороги и события можно оставить прежними: это диагностика успешно
завершившихся операций. Storage/outbox, terminal delivery, runtime unknown,
heartbeat, backlog и trigger errors сохраняют существующую срочность.

Backlog не заменяет deferred alert: если health не прочитан, нового измерения
возраста очереди нет, а его `No data = OK`. Независимый heartbeat остаётся
резервным сигналом длительного отсутствия успешных проходов.

## Проверки и порядок внедрения

Один PR должен включать код, ADR с границами восстановления, runbook,
desired state/dashboard и тесты:

- восстановление после трёх быстрых ошибок на четвёртой попытке;
- общий deadline, постоянные/неизвестные ошибки, отмена во время backoff
  с неизвестной причиной и сохранение `prior_error`;
- реальный SDK с синтетическим транспортом: освобождение session pool и
  независимость параллельной транзакции доменных данных/outbox;
- deferred для двух типов уведомлений; следующий проход доставляет их;
  отказ health после сохранённой доставки не создаёт дополнительную отправку;
- длительная недоступность без ложного heartbeat/gauges; неизвестная ошибка
  отклоняет invocation; ошибки записи не переходят в deferred;
- новый event/selector/alert, 15-ID allowlist, email-only политика и drift.

При добавлении тестов в `application/__tests__/` расширить test glob:
нынешний `package.json` эту папку не запускает. Monitoring contract-тесты
также читают явный список source-файлов — включить новый worker.

При согласованном rollout сначала создать и проверить новый metric/alert,
затем развернуть worker, сверить heartbeat, queue health и правила уведомлений.
Просто изменить JSON недостаточно: требуется применение и live drift check.
Откат функции на предыдущую версию сохраняет старое runtime-покрытие;
неиспользуемая deferred metric безопасна при `No data = OK`.

Открытые p95 «Нет данных», причина длительных YDB-задержек и полная live-сверка
остаются отдельными задачами; #72 их не решает.

В этом аудите через reviewed `scripts/check.py` успешно выполнены TypeScript,
97 unit-тестов функции, тест CommonJS deploy artifact и 45 monitoring/deploy
contract-тестов. Это проверка текущего состояния, не ещё не выполненного переноса.
Live cloud и доставка уведомлений не проверялись.

На этапе исходного аудита `scripts/upstream-parity.json` содержал baseline `8e568f0` от
19 сентября. Он тогда не продвигался: применимые изменения #72 ещё не были реализованы,
а для полного обновления baseline нужно классифицировать весь промежуточный
диапазон commit по [процедуре паритета](upstream-parity.md#как-обновить-baseline).
