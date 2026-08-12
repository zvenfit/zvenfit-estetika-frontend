# Паритет с zvenfit-frontend

`zvenfit-frontend` — источник переносимых инженерных практик, а не шаблон интерфейса. Архитектура
Estetika остаётся статическим Webflow-сайтом, а косметологический бренд, контент и визуальная система
не копируются автоматически.

Текущий аудит выполнен 2026-08-13 до опубликованного commit
`18fccbace173cf95ac0b48fd3c1d60349521355f`. В аудит вошли исправление OTLP heartbeat/нулевых
gauge, стабильность TTL integration-теста, обновление зависимостей и production smoke/release
readiness. Последующее изменение цены групповой тренировки не относится к продукту Estetika.
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
