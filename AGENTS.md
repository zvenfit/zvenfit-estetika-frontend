# Agent guide — ZvenFit Estetika Frontend

Краткий контракт для AI-агента и новых контрибьюторов. Backlog: [`TODO.md`](TODO.md).

## Project isolation

- This is a standalone local project. Do not connect it to Stefania.
- Do not use Stefania-specific skills, knowledge bases, memory, personas, workflows, or external Yandex services for work in this repository.
- Rely only on this repository, its documentation, and general-purpose development tools unless the user explicitly requests otherwise for a specific task.

## Stack

- **Frontend:** static HTML (Webflow export) in `public/`
- **Build:** `scripts/build-static.cjs` → `dist/` (gitignored)
- **Runtime JS:** vanilla JS in `public/js/`
- **Backend:** 1 Yandex Cloud Function in `functions/telegram-lead/` (lead + newsletter)
- **CI:** `.github/workflows/main.yml` — deploy function → lint → build → S3

No React/Vite/Next. Almost no TypeScript.

## Source of truth

| Edit | Do not edit |
|------|-------------|
| `public/` | `dist/` |
| `scripts/` | generated `*.min.css` in dist |
| `functions/` | committed secrets |
| `upload/` | raw Webflow (gitignored staging) |

After HTML/CSS/JS/config changes: `npm run build` or `npm run dev:watch`.

## Architecture

```
Browser (estetika.zvenfit.ru)
  ├─ site bucket — HTML (including legal), app JS, min site CSS, robots, sitemap
  ├─ CDN zvenfit-estetika/ — images, vendor CSS, fonts, webflow.js
  └─ POST lead/newsletter → functions/telegram-lead → Telegram

Local dev (npm run dev):
  mock-server :3000  ← lead POST
  serve dist :4173   ← static site
```

Build injects API URL into `public/js/lead-config.js` → `window.ZVENFIT_LEAD_API`.

## Build pipeline

`build-static.cjs` injects at `</head>` (no HTML markers required in source):

| Injection | Source |
|-----------|--------|
| Yandex Metrika | `scripts/snippets/analytics-head.html` + `YANDEX_METRIKA_ID` |
| UTM attribution | `scripts/snippets/utm-head.html` |
| Open Graph + canonical | page meta + `scripts/structured-data.config.json` |
| JSON-LD | `scripts/structured-data.config.json` (skipped for `/404.html`) |

Also at build time:
- minifies `zvenfit-kosmetologiya.webflow.css` → `*.min.css`
- cache-busts listed JS via `ASSET_VERSION`
- prunes CDN assets from `dist/` (images, fonts, vendor CSS/JS); keeps legal HTML
- `public/robots.txt` + `public/sitemap.xml` copied to `dist/` (edit manually, like main repo)

## Task → file map

| Task | Files |
|------|-------|
| Landing markup | `public/index.html` |
| Lead form UI | `public/form/index.html`, `public/js/lead-form.js` |
| Newsletter form | `public/index.html` (footer), `public/js/newsletter-form.js` |
| Lead API / Telegram | `functions/telegram-lead/index.js` |
| UTM in leads | `public/js/utm-attribution.js`, `docs/utm-attribution-marketing.md` |
| SEO / JSON-LD | `scripts/structured-data.config.json`, page `<title>` |
| Site CSS | `public/css/zvenfit-kosmetologiya.webflow.css` |
| Mutable CDN assets upload (vendor CSS/webflow.js) | `scripts/prepare-cdn-assets.cjs`, `scripts/upload-assets.sh` |
| Deploy | `.github/workflows/main.yml`, `npm run deploy:yc` |

## Local development

```bash
cp .env.example .env.development
npm install
npm run dev:watch
```

Lead form posts to `http://localhost:3000` in dev (via injected `LEAD_API_URL`).

## Verification

```bash
npm run lint:public
npm run build
npm run test:build
```

Manual smoke:
- `/` — newsletter form in footer
- `/form/` — lead form submit, check mock-server log for `utm` when testing with `?utm_source=test`

## Secrets & security

- Never commit tokens, SA keys, or real `.env*`
- Bot token / chat ID: Cloud Function env + GitHub Secrets only
- CORS: `ALLOWED_ORIGINS` in workflow and function env

## Brand constraints

Cosmetology / beauty aesthetic — do not replace with generic fitness branding from main `zvenfit-frontend`.

## Common mistakes

1. Editing `dist/` directly — lost on next build
2. Forgetting `npm run upload:assets` after vendor CSS/Webflow JS changes
3. Using `lint` — use `lint:public` (no `src/`)
4. Putting images/fonts/vendor assets back into site bucket — `dist/` stays lean except for legal HTML
5. Expecting `upload:assets` to upload images/fonts — they are intentionally excluded and managed directly in CDN

## Pages

Primary pages: `index.html`, `form/index.html`, `404.html`.

Legal HTML is deployed with the site: `documents/privacy-policy.html`, `documents/personal-data-processing.html`.

## Docs index

| File | Purpose |
|------|---------|
| `README.md` | Architecture, deploy, Webflow workflow |
| `docs/setup.md` | YC + Telegram + GitHub Secrets |
| `docs/utm-attribution-marketing.md` | UTM for marketing |
| `TODO.md` | Backlog + launch blockers |
