# Паритет с zvenfit-frontend

`zvenfit-frontend` — источник переносимых инженерных практик, а не шаблон интерфейса. Архитектура
Estetika остаётся статическим Webflow-сайтом, а косметологический бренд, контент и визуальная система
не копируются автоматически.

Текущий аудит выполнен 2026-09-19 до опубликованного commit
`8e568f043f415b0b5109663dfa2662a4ff54e58b`. SHA проверен по GitHub `main` и локальному
`origin/main` основного проекта. Перенесены архитектурные изменения production
observability и доступов: event counts через log aggregates, safe error taxonomy, canonical labels
direct gauges, log-pipeline heartbeat, throttling alert, dashboard desired state, read-only drift
check, GitHub OIDC/WIF и bucket-scoped ephemeral Object Storage credentials.

Из диапазона `782cff989a9723191311fe888d8bad8082853689..184556357a237d4541ec2f8dcc37f3e70bc9da4e`
перенесены быстрые INFO/ERROR log shortcuts за последний час, нативный Monium dashboard JSON как
восстанавливаемый artifact и правило 36-column layout для непарного финального графика. В
Estetika сохранены семь её operational charts, сверху добавлена полноширинная строка shortcuts, а
непарный YDB-график остаётся полноширинным. Upstream traffic/FitBase widgets, traffic analytics,
FitBase future roadmaps и project-local knowledge base не применимы к этому статическому
lead/newsletter-проекту и не переносились.

Из диапазона `184556357a237d4541ec2f8dcc37f3e70bc9da4e..20251191a99e5e9b2c6153d4eab24aa3d425b24d`
перенесён стабильный `query_execute` timing, независимый log-based alert отказов Monium exporter,
общий трёхсекундный deadline OTLP lifecycle и строгая проверка наличия notification settings в live
drift snapshot. Dashboard Estetika дополнен одним полноширинным графиком exporter health.
`session_acquire` / `session_create` намеренно не перенесены: диагностические каналы пока флапают,
их повторная оценка зафиксирована как техдолг. После разделения доменов и transactional outbox
канонический direct queue gauge называется `zvenfit_estetika_telegram_pending_notifications`;
upstream/legacy `pending_submissions` временно публикуется параллельно для безразрывного rollout.
Staging gateway/E2E, traffic и FitBase изменения этого диапазона не переносились как неприменимые.

Из диапазона `20251191a99e5e9b2c6153d4eab24aa3d425b24d..5c386309a3b84151c0f9aca5454ac7a2c9967c1c`
перенесены DNS-first Telegram route failover с безопасными `HEAD`-пробами, одноразовый retry
transient YDB driver initialization и расширенный одноразовый retry transient session/query
ошибок только для read-only операций retry-worker. Медленный YDB alert теперь оставляет одно
событие диагностикой, переходит в `Warning` на двух и в `Alarm` на трёх событиях за 10 минут.
В Estetika route selection остаётся внутри её единственного Telegram delivery-модуля, а upstream
выносит этот же механизм в отдельный `routes.ts`; это структурное, не поведенческое расхождение.
Изменения upstream project-local knowledge base не копировались: адаптированный operational
контракт зафиксирован в `docs/monitoring.md` этого репозитория.

Из диапазона `5c386309a3b84151c0f9aca5454ac7a2c9967c1c..84c8e21324b55cee9b4d45e6c761d43819537363`
проверены изоляция alert-list в общем Monium project, семантика managed `functions_errors` и
диагностика подготовки YDB client. Применимые изменения уже независимо перенесены в Estetika:
dashboard использует allowlist четырнадцати полных alert ID без legacy `widgetScope`, runtime
alert агрегирует `DGAUGE` через `max`, а YDB initialization attempts отделены от query/session
retry и публикуют только безопасные allowlisted error codes. Дополнительный перенос кода не
потребовался; Estetika сохраняет exact single-function selectors и собственный namespace.

Из диапазона `84c8e21324b55cee9b4d45e6c761d43819537363..6065815a30fa03d4bcb2a05c45ac77967d9031a5`
перенесено усиление transient YDB driver discovery: до трёх попыток инициализации с
exponential backoff `250ms` / `500ms`, немедленный отказ для постоянных ошибок и тест
восстановления на третьей попытке. Query/session retry Estetika не изменялся: инцидент
25 августа исчерпал уже существующий read-only query retry и относится к отдельному
кратковременному сбою выполнения запроса, а не к driver discovery.

Диапазон `6065815a30fa03d4bcb2a05c45ac77967d9031a5..8e568f043f415b0b5109663dfa2662a4ff54e58b`
проверен полностью:

| Upstream commit | Решение для Estetika |
|---|---|
| `7abf056`, `6b30e85` — club card и её navigation | Страницы и продуктового сценария в Estetika нет; не переносились. |
| `12461d1` — версия club card CSS | Принцип уже реализован: сборка Estetika версионирует site и legal CSS через `ASSET_VERSION`. |
| `f479c2e` — независимый retry heartbeat | Уже адаптирован в `e09b007`: log-based heartbeat, отдельный deadline каждой OTLP-стадии, email-only exporter alert без повторов и проверка notification drift. |
| `2c3b608`, `01ca482`, `4863337`, `bd178b4` — цены тренировок и их E2E pins | Контент и тесты основного фитнес-сайта неприменимы. |
| `772fce1` — staging E2E rate-limit pin | Отдельного staging gateway и этих fixtures в Estetika нет. |
| `1acdc23` — Personal AI Workspace | Независимо принят для Estetika в `b4b0c6f`; upstream workspace mapping и knowledge base не копировались. |
| `8e568f0` — причины retry, Telegram phases и retention | Перенесены безопасные причины SDK/read-fallback retry, числовые YDB status codes, Telegram failure phase и desired retention 14 дней. |

В адаптации `8e568f0` сохранён контракт Estetika: наблюдается только `query_execute`;
неизвестная фаза остаётся `unknown`, без вымышленных session timings. Изоляция concurrent
операций и retry с нулевым backoff проверены тестами с настоящим `@ydbjs/retry`.
Число попыток, query timeout, outbox и правило одной отправки Telegram POST не менялись.
Дополнительно устранён обнаруженный у Estetika источник drift slow-log threshold:
workflow читает `ZVENFIT_ESTETIKA_YDB_SLOW_OPERATION_MS`, а runtime сохраняет имя
`YDB_SLOW_OPERATION_MS` и default `3000` мс.

Проверки 19 сентября: lint, TypeScript, тесты функции, monitoring/deploy contracts и сборка
прошли. Визуальная проверка была запущена, но остановилась до выполнения сценариев:
локально отсутствует Chromium Headless Shell требуемой версии Playwright. Разметка,
CSS и клиентский JS в этом переносе не менялись. История live-проверки и границы rollout
зафиксированы в [разборе мониторинга](monitoring-review-2026-09-18.md#доработка-19-сентября).

После локального security review WIF-паттерн усилен без смены базовой модели upstream:
dependency installation/build вынесены из OIDC jobs, live YDB probe получил отдельную identity, а
ephemeral issuer ограничен storage SA и подтверждается негативными live-проверками. На audited
commit deploy и verifier дополнительно разделены разными GitHub Environment exact subjects, а
verifier JWT негативно проверяется против deploy SA до положительного обмена. В upstream те же
WIF/ephemeral сущности используются в jobs с более широкой trust boundary;
это сознательное security hardening, которое следует предложить обратно в `zvenfit-frontend`, а не
считать продуктовым расхождением.

Адаптация сохраняет отдельную resource map Estetika:
`zvenfit-estetika-frontend`, `zvenfit-estetika`, `zvenfit-estetika-telegram-lead` и
`zvenfit-estetika-leads`. Fitbase, schedule, staging gateway/fixtures, traffic beacon/function,
CDN analytics основного сайта, fitness UI и project-local `knowledge-base/` не перенесены как
неприменимые к архитектуре и правилам этого репозитория.
Baseline хранится в
`scripts/upstream-parity.json`; локальная и еженедельная CI-проверки сообщат, когда `main`
основного проекта уйдёт вперёд.

```bash
npm run check:upstream-parity
```

Локально команда читает `origin/main` соседнего `../zvenfit-frontend`, а не текущую feature-ветку.
Другой checkout задаётся через
`ZVENFIT_FRONTEND_DIR`. В GitHub Actions SHA читается через API; для приватного upstream нужен
repository secret `UPSTREAM_READ_TOKEN` с read-only доступом к contents.

## Что сравнивать при каждом новом commit

| Контур upstream | Решение для Estetika |
|---|---|
| CI, supply chain, версии Actions | переносить, если применимо к статической сборке и одной функции |
| Приём заявок, YDB, rate limit, Telegram retry | сохранять функциональный паритет с адаптацией lead/newsletter |
| Structured logs, direct metrics, heartbeat, alerts | переносить с namespace `zvenfit_estetika_*` |
| Production smoke, performance budgets, visual tests | переносить и дополнять страницами Estetika |
| Accessibility и клиентская надёжность | переносить без изменения брендовых tokens и композиции |
| Fitbase, расписание, React/Vite и фитнес-функции | не переносить без отдельной продуктовой потребности |
| Фирменный UI, тексты, изображения и SEO | проектировать отдельно для косметологии |

## Как обновить baseline

1. Посмотреть compare URL из упавшей проверки.
2. Классифицировать каждый commit по таблице выше.
3. Перенести применимые изменения и добавить тесты либо письменно зафиксировать, почему перенос не
   нужен.
4. Запустить `npm test` и `npm run test:visual`.
5. Только после аудита заменить `baselineSha` и `auditedAt` в `scripts/upstream-parity.json`.

Проверка намеренно падает на любом новом SHA: это не означает, что код нужно слепо скопировать;
она не позволяет изменениям основного проекта пройти незамеченными.
