---
type: project
title: ZvenFit Estetika project knowledge base
---

# ZvenFit Estetika project knowledge base

Эта директория — версионируемая техническая база знаний проекта ZvenFit Estetika.

- Здесь хранятся технические знания; продуктовые цели и планы — в Personal AI
  Workspace. [Правила разделения и локальная связь](../docs/personal-ai-workspace.md).
- Источник удалённого хранения — только настроенный Git remote этого репозитория.
- Не хранить секреты, credentials, персональные данные, реальные заявки или
  production payloads.
- Не синхронизировать и не копировать материалы в Wiki, DataCatalog, Obsidian,
  внешние knowledge-base surfaces или межпроектную память.
- История review и Git служит аудитом изменений базы.
- Здесь хранятся устойчивые выводы и решения. Полные инструкции, selectors и
  восстанавливаемые артефакты остаются в профильных docs и config-файлах.
- Новое существенное техническое решение оформляется как ADR в `docs/decisions/`;
  из этого индекса добавляется ссылка. Папка создаётся при первом таком решении.
  Существующие заметки сохраняют свои адреса и историю.

## Operations

- [Production monitoring decisions](monitoring.md)
- [Полный monitoring runbook](../docs/monitoring.md)
- [Operator handoff](../docs/operator-handoff.md)
