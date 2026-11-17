---
type: project
title: CDN security headers
---

# CDN security headers

- CDN-ресурс `estetika.zvenfit.ru` настроен вручную; из репозитория управляются только
  статические заголовки ответа: `scripts/cdn-security-headers.json` (источник правды,
  его же читает `smoke-production`) и `scripts/configure-cdn-headers.sh` (dry-run по умолчанию).
- Применяются через REST API CDN: `yc cdn resource update --static-headers` делит значения по
  запятым и ломает `Permissions-Policy`.
- Распространение по edge-узлам неравномерное: 2026-11-17 заголовки появлялись на узлах
  постепенно около 20 минут, часть узлов долго отдавала ответы без них. Очистка кеша не нужна
  (ответы шли от источника, `cache-status: MISS`). Проверять нужно серией запросов, а не одним `curl`.
- Порядок изменений: сначала CDN (`--apply`, дождаться стабильных ответов), потом мерж PR,
  иначе строгий smoke роняет деплой.
- HSTS (`max-age=31536000`, без `includeSubDomains`/`preload`) отложен до подтверждения стабильного
  HTTPS; выданный HSTS браузеры помнят, откат неполный.
- CSP не входит: нужны домены Яндекс Метрики и GTM `GTM-KQT53D6V`.

Runbook: [`docs/setup.md`](../docs/setup.md#заголовки-безопасности).
