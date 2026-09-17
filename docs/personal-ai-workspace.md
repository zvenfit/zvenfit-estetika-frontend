# Personal AI Workspace

Репозиторий подключается по контракту Personal AI Workspace **1.0.4**:

- Repository: `REP-002`, `zvenfit-estetika-frontend`.
- Product: `PROD-002`, «Сайт ZvenFit Estetika».
- Domain: `zvenfit`.
- Карточки внутри Workspace `vault/`:
  `10 Domains/Zvenfit/Repositories/zvenfit-estetika-frontend` и
  `10 Domains/Zvenfit/Products/Сайт ZvenFit Estetika`.

Карточки каноничны, а `repo-manifest.json` отражает их идентификаторы и связи.
`project_ids` пуст: отдельная инициатива с конечной целью пока не задана.
Основной `zvenfit-frontend` имеет собственную карточку и отдельный bridge.

## Где хранить знания

| Материал | Источник правды |
|---|---|
| Бизнес-контекст и подтверждённые знания о косметологическом направлении | Workspace `vault/10 Domains/Zvenfit/`, тематические knowledge notes |
| Цели, исследования, планы и продуктовые статусы | Заметки Product, Exploration, Project и Plan в том же домене Workspace |
| Код, тесты, сборка, конфигурация | Этот репозиторий |
| Подтверждённые технические выводы и существующие решения | `knowledge-base/` этого репозитория |
| Новое существенное техническое решение с альтернативами и последствиями | ADR в `docs/decisions/` этого репозитория, создаваемый вместе с первым решением |
| Подробные инструкции эксплуатации | `docs/` и README этого репозитория |
| Физические пути на конкретной машине | Machine-local `config/local.json` Workspace |
| Значения секретов и реальные production-данные | Их отдельные защищённые хранилища |

Для материала выбирается один источник правды, из другого места ставится ссылка.
`knowledge-base/` не переносится и не копируется в Workspace или Obsidian.
Подключение не меняет самостоятельность проекта и его изоляцию от Стефании.

Это следует из `docs/content-routing.md`, раздела об источниках правды в
`docs/architecture.md` и `docs/information-architecture.md` Workspace 1.0.4.
Его `docs/importing-existing-products.md` рекомендует при adopt сохранять
существующую рабочую структуру. Поэтому текущая `knowledge-base/` остаётся
технической KB репозитория; переименование папки для подключения не требуется.

### Как добавлять новые знания

- «Почему алерт считает сумму за 30 минут» — техническая заметка или ADR в repo;
  точный selector и инструкция проверки остаются в config и runbook.
- «Какие обращения приводят к записи на процедуру» — knowledge note домена
  `zvenfit` в Workspace с источником и датой проверки.
- «Проверить гипотезу новой услуги» — Exploration; согласованное изменение с
  конечным результатом — Project, связанный с `PROD-002`.
- Для заметки в vault указываются `title`, `domain`, `content_type`,
  `sensitivity` и `tags` по схеме Workspace. Новые папки создаются вместе с
  первой содержательной заметкой. Междоменное знание относится к
  `vault/30 Knowledge/`, знание о ZvenFit — к его домену.
- Если материал нужен в двух местах, полное содержание хранится в одном,
  выбранном по этим правилам; во втором остаётся ссылка.

Текущая `knowledge-base/monitoring.md` содержит технические решения и остаётся
каноническим источником их обоснований. В Workspace достаточно ссылки на неё
из Repository card; отдельная копия заметки не создаётся.

## Перенесённый продуктовый контекст

Разбор 2026-09-17 охватил `knowledge-base/`, README, TODO и документацию `docs/`.
Техническая KB мониторинга сохранена целиком. Нетехнические части смешанных
документов перенесены в следующие канонические заметки внутри Workspace `vault/`:

| Заметка | Точный путь относительно `vault/` | Что перенесено |
|---|---|---|
| Сайт ZvenFit Estetika (`PROD-002`) | `10 Domains/Zvenfit/Products/Сайт ZvenFit Estetika.md` | Границы продукта, бренд, production-домен и возможности, которые не заимствуются автоматически |
| ZvenFit Estetika — запуск и развитие | `10 Domains/Zvenfit/Plans/ZvenFit Estetika — запуск и развитие.md` | Условия запуска, юридические вопросы, исходные приоритеты и восемь пунктов контента/конверсии |
| ZvenFit Estetika — рекламная разметка | `10 Domains/Zvenfit/Knowledge/ZvenFit Estetika — рекламная разметка.md` | Параметры и примеры рекламных ссылок, рекомендации маркетингу и границы атрибуции |

В исходных разделах TODO, operator handoff и UTM-документа оставлены ссылки
вместо параллельных списков. Технические задачи, алгоритмы и runbook остаются
в repo. Датированные сведения о production сохранены как исторические;
незакрытые пункты не объявлены выполненными. Расхождение в требованиях к
согласиям отмечено в плане как открытый вопрос.

План имеет `content_type: plan`, `status: draft`: это импортированный backlog,
а не новая согласованная инициатива с вымышленными сроками или исполнителем.
`project_ids` остаётся пустым. Карточка `PROD-002` связывает эти материалы;
для чтения каждой заметки применяется отдельный preflight Workspace.

## Локальная связь

Машинный указатель находится внутри Git metadata; точный путь возвращает Git:

```bash
git rev-parse --git-path personal-ai-workspace/local.json
```

Указатель и mapping `repositories.REP-002` в `config/local.json` Workspace не
входят в Git. Обычный clone переносит manifest и инструкции, после чего локальный
bridge на новой машине настраивается заново.

Текущие технические документы читаются из подключённой локальной рабочей копии.
GitHub-ссылки показывают опубликованную версию и могут отставать до отдельного
commit/push; ссылки на конкретный commit сохраняют исторический источник.

Из корня установленного Workspace с Python 3.14 или новее:

```bash
python3.14 -B scripts/repo_bridge.py locate --repo-id REP-002 --client codex \
  --purpose "Работа с zvenfit-estetika-frontend" --allow-sensitive
```

`locate` возвращает метаданные. Перед чтением каждой конкретной заметки нужен
отдельный `cloud_preflight.py` с той же целью и применимыми allow-флагами.
Недоступная связь не разрешает читать весь vault или соседние репозитории.

## Проверки

`project-checks.json` перечисляет существующие команды из `package.json`:
lint, unit/artifact-тесты функции, monitoring и static build с performance budget.
Runner по умолчанию только показывает команды и digest точного файла:

```bash
python3 scripts/check.py --list
python3 scripts/check.py --execute-reviewed <review_digest> --check lint-public
python3 scripts/check.py --execute-reviewed <review_digest> --allow-writes
```

Build и тесты функции создают локальные артефакты и требуют `--allow-writes`.
Текущий набор не требует сети. Runner фильтрует окружение, но не является
sandbox: команды запускаются в отдельном tool/OS sandbox.
Визуальные Playwright-тесты остаются необязательной локальной проверкой по README.
CI продолжает использовать собственные workflow.

`scripts/check.py`, `scripts/secret_scan.py` и `scripts/bip39-english.txt` взяты
без изменений из `blueprints/code-repo/scripts/` Workspace 1.0.4, commit
`7059c314d4713480323fd715794d2bd87781a234`. Словарь — стандартный корпус детектора,
не пользовательская seed-фраза. Обновление Workspace автоматически этот bundle
в кодовом репозитории не меняет.

Adopt создаёт локальную связь. Commit, push, deploy и изменения внешних систем
выполняются только по отдельной задаче владельца.
