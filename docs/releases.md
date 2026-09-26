# Production-релизы Estetika

Push в `main` запускает **Deploy to Production**. После проверок, деплоя функции
и сайта и успешного **smoke-production** job **Publish production release**
публикует тег на точном SHA запуска и GitHub Release. Описание содержит
автоматический список изменений, SHA и ссылку на workflow run.
Ручной запуск workflow для другой ветки выполняет только quality checks.

## Номер версии

До внедрения автоматизации у Estetika нет тегов и GitHub Releases. Первый
проверенный деплой с новым job получает `v0.1.0` — начальную версию, согласованную
с текущим `package.json`. Предыдущим выкладкам версии задним числом не назначаются.
Далее источник версии — стабильные Git-теги `vMAJOR.MINOR.PATCH`, поле
`package.json.version` автоматически не меняется: сайт не публикуется в npm.

Учитываются сообщения всех коммитов после последнего стабильного тега.
При squash merge это итоговое сообщение PR; перед merge проверьте его заголовок.

| Изменения | Повышение | Пример |
|---|---|---|
| `fix:`, `chore:`, `docs:` и другие без специальных маркеров | patch | `v0.1.0` → `v0.1.1` |
| Есть `feat:` или `feat(scope):` | minor | `v0.1.1` → `v0.2.0` |
| Явный `feat!:`, `fix(scope)!:` или footer `BREAKING CHANGE:` | major | `v0.2.0` → `v1.0.0` |

Берётся наибольшее повышение; major требует осознанного breaking-маркера.
Коммиты с пропущенным CI войдут в следующую проверенную выкладку.
Архивные теги `archive/*` и prerelease-теги не участвуют в расчёте.

## Проверка и восстановление публикации

1. Перед merge дождитесь зелёного `quality-checks` в PR.
2. После merge проверьте `smoke-production` и **Publish production release**.
   Ссылка на релиз появится в summary; тег должен указывать на SHA этого run.
3. Если упал только release job, выберите **Re-run failed jobs** в том же run.
   Успешные deployment jobs повторять не нужно. Уже созданный тег используется
   повторно; существующий опубликованный релиз не изменяется.
4. Если тег занят другим SHA или история разошлась, разберите конфликт.
   Не удаляйте и не перемещайте стабильные теги ради повторной публикации.

Восстановление Release для старого существующего тега не меняет latest поверх
новой версии. Старому нетегированному коммиту после более новой версии номер
не назначается. Тег фиксирует исходники, но не выполняет откат сайта, функции или БД.

Просмотр предполагаемого номера без публикации (нужны актуальные теги и полная история):

```bash
git fetch origin --tags
RELEASE_SHA=$(git rev-parse HEAD) node scripts/publish-production-release.cjs --dry-run
```

Право `contents: write` получает только release job через встроенный
`GITHUB_TOKEN`; PAT и облачные credentials ему не нужны. Общая concurrency-группа
`deploy-production` охватывает деплой, smoke и публикацию версии.
Локальный ручной деплой из README сам по себе релиз не публикует.

Контракт проверяется через `npm run test:monitoring`: реальные временные
Git-репозитории, синтетический GitHub API и проверки зависимостей workflow.
Обоснование: [ADR-002](decisions/002-automated-production-releases.md).

Документация GitHub: [Releases API](https://docs.github.com/en/rest/releases/releases),
[повтор workflow и отдельных jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
