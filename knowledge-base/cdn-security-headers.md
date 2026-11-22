---
type: project
title: CDN security headers
---

# CDN security headers

- CDN-ресурс `estetika.zvenfit.ru` настроен вручную; из репозитория управляются только
  статические заголовки ответа: `scripts/cdn-security-headers.json` (источник правды,
  его же читает `smoke-production`) и `scripts/configure-cdn-headers.sh` (dry-run по умолчанию).
- Применяются через REST API CDN с `updateMask: options.staticHeaders`: `yc cdn resource update
  --static-headers` делит значения по запятым и ломает `Permissions-Policy`. Путь маски в REST
  только camelCase: `options.static_headers` API отклоняет с HTTP 400 (проверено 2026-11-17).
  Поведение PATCH без маски описано в документации по-разному; 2026-11-17 запрос без маски опции
  не сбросил. Маска ограничивает изменение заголовками; скрипт снимает снимок ресурса и сверяет
  остальные опции после.
- Распространение по edge-узлам неравномерное: 2026-11-17 заголовки появлялись на узлах
  постепенно около 20 минут, часть узлов долго отдавала ответы без них. Очистка кеша не понадобилась
  (`cache-status: MISS`). Проверять серией запросов, а не одним `curl`. Smoke повторяет и
  несовпадение заголовков.
- Порядок изменений: сначала CDN (`--apply`, дождаться стабильных ответов), потом мерж PR,
  иначе строгий smoke роняет деплой.
- HSTS отложен: отозвать можно только `max-age=0` по рабочему HTTPS, поэтому ступенчато после
  первого автообновления сертификата и с оповещением об истечении. `includeSubDomains`/`preload`
  не использовать (smoke их отклоняет). На апексе `zvenfit.ru` HSTS и preload нет (проверено 2026-11-17).
- Риск: `X-Frame-Options: DENY` может сломать просмотр карт Метрики; решение владельца, см. `TODO.md`.
- `COEP: require-corp` не добавлять: `tag.js` Метрики и ассеты бакета не отдают
  `Cross-Origin-Resource-Policy` и будут заблокированы (`gtm.js` его отдаёт; проверено 2026-11-22).
  `COOP: same-origin` без проверки не добавлять: польза для статического сайта мала, а влияние на
  GTM Tag Assistant не проверено.
- CSP не входит: нужны домены Яндекс Метрики и GTM `GTM-KQT53D6V`; статический CDN не умеет nonce,
  GTM-теги с inline-кодом потребуют `'unsafe-inline'` либо перевода на шаблон Метрики.

Решение: [ADR-004](../docs/decisions/004-cdn-security-headers-from-repository.md).
Runbook: [`docs/setup.md`](../docs/setup.md#заголовки-безопасности).
