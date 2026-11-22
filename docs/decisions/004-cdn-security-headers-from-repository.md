# ADR-004: заголовки безопасности CDN управляются из репозитория

Дата: 2026-11-22 (решение принято и внедрено 2026-11-17). Статус: внедрено,
[PR #44](https://github.com/zvenfit/zvenfit-estetika-frontend/pull/44) и
[PR #45](https://github.com/zvenfit/zvenfit-estetika-frontend/pull/45), релизы v0.4.0 и v0.4.1.

## Контекст

Сайт отдаётся из бакета Object Storage через CDN-ресурс `estetika.zvenfit.ru`, который
создан и настроен вручную в консоли. CI его не меняет. Заголовков безопасности ответа не
было: `smoke-production` только предупреждал об этом. Перед запуском рекламного трафика
нужны базовые заголовки, а сайт использует Яндекс Метрику и GTM `GTM-KQT53D6V`.

## Решение

- Отдавать заголовки как статические заголовки ответа CDN-ресурса, а не через HTML `<meta>`:
  `X-Content-Type-Options`, `X-Frame-Options`, `Permissions-Policy` и HSTS браузеры через `<meta>`
  не принимают.
- Набор: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()`.
- Источник правды — `scripts/cdn-security-headers.json`. Остальные настройки CDN-ресурса
  по-прежнему ручные.
- Применение — `scripts/configure-cdn-headers.sh`: по умолчанию dry-run, `--apply` отправляет
  PATCH в REST API CDN с `updateMask: options.staticHeaders`, снимает снимок ресурса до
  изменения, ждёт операцию и завершается ошибкой, если изменилась любая другая опция.
- `smoke-production` в каждом деплое проверяет заголовки на `/`, `/form/`, `/privacy/`,
  `/personal-data-processing/`, `/404.html` и 404 неизвестного пути. Расхождение повторяется в
  общем бюджете ретраев, затем валит smoke; при провале smoke релиз-тег не публикуется.
- Порядок изменения: сначала `--apply` на CDN и стабильные ответы, потом мерж PR с новым JSON.
- HSTS отложен: включается ступенчатым `max-age` после первого автообновления сертификата и
  появления оповещения об его истечении; `includeSubDomains` и `preload` не используются.
  Smoke проверяет HSTS правилом (`max-age` не ниже значения из конфига), а не точным значением.
- CSP — отдельное решение: на статическом CDN нет nonce, а GTM-теги вставляют inline-код.

## Отвергнутые варианты

- `yc cdn resource update --static-headers`: CLI делит значения по запятым и ломает
  `Permissions-Policy`.
- Terraform `yandex_cdn_resource` (`static_response_headers`): потребовал бы перевести под
  управление весь вручную настроенный ресурс; это отдельное, большее решение.
- Оставить предупреждение в smoke: регресс заголовков проходил бы незамеченным.

## Последствия и риски

- Edge-узлы подхватывают изменение неравномерно: 2026-11-17 около 20 минут часть узлов
  отвечала без заголовков. Ответы шли от источника (`cache-status: MISS`), очистка кеша не
  понадобилась.
- Для каждого URL smoke достаточно одного удачного ответа: так он не падает ложно, но
  отдельный отстающий узел может остаться незамеченным.
- Правку в консоли заметит только следующий деплой; регулярная проверка дрейфа — пункт `TODO.md`.
- `X-Frame-Options: DENY`, вероятно, мешает просмотру карт Метрики во фрейме (сбор данных не
  затронут). Нужны ли карты, решает владелец; решение — enforced CSP `frame-ancestors` с
  адресами Яндекса, см. `TODO.md`.
- Прямые адреса бакета обходят CDN и отдают страницы без заголовков; заявки с этих origin
  отклоняет проверка `Origin` в функции.

## Откат

PR, который возвращает прежний JSON, затем `--apply`. Экстренно —
`yc cdn resource update <id> --clear-static-headers`; до приведения JSON в соответствие
следующий smoke будет красным. HSTS отзывается только `max-age=0` по рабочему HTTPS.

## Проверка

2026-11-17: заголовки на всех шести URL в серии запросов без пропусков, smoke на production
зелёный, опции ресурса до и после совпадают. Холостой `--apply --force` подтвердил путь
маски: `options.static_headers` API отклонил с HTTP 400, `options.staticHeaders` принят.

Источники: [настройка HTTP-заголовков Cloud CDN](https://yandex.cloud/ru/docs/cdn/operations/resources/configure-headers),
[ResourceService.Update](https://github.com/yandex-cloud/cloudapi/blob/master/yandex/cloud/cdn/v1/resource_service.proto).
