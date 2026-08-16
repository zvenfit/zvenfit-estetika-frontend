# Паритет с zvenfit-frontend

`zvenfit-frontend` — источник переносимых инженерных практик, а не шаблон интерфейса. Архитектура
Estetika остаётся статическим Webflow-сайтом, а косметологический бренд, контент и визуальная система
не копируются автоматически.

Текущий аудит выполнен 2026-08-16 до опубликованного commit
`184556357a237d4541ec2f8dcc37f3e70bc9da4e`. Перенесены архитектурные изменения production
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
