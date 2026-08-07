# ZvenFit Estetika Frontend

Static landing (Webflow HTML) + build pipeline + Yandex Cloud Function for Telegram leads.

## Architecture

```
Browser → CDN (estetika.zvenfit.ru) → site bucket (HTML + app JS + site CSS)
       → storage.yandexcloud.net/zvenfit-estetika/ (images, vendor CSS, fonts, webflow.js)
       → Cloud Function → Telegram
```

CDN URLs for static assets are **hardcoded in `public/` HTML** (same pattern as `zvenfit-frontend`).
Build minifies site CSS and injects OG/JSON-LD/analytics. CI syncs full `dist/` to the site bucket.

## Project layout

| Path | Purpose |
|------|---------|
| `public/` | Tracked site source (HTML references assets CDN) |
| `upload/` | Raw Webflow export (gitignored, local only) |
| `dist/` | Build output (gitignored) |
| `functions/telegram-lead/` | Lead + newsletter handler |
| `scripts/build-static.cjs` | `public/` → `dist/` |
| `scripts/structured-data.config.json` | SEO, OG, JSON-LD, `assetsCdnBase` |

**Buckets:**
- `zvenfit-estetika-frontend` — CI deploys full `dist/` (pages, legal HTML, app JS, min site CSS, robots, sitemap)
- `zvenfit-estetika/` — CDN assets; images and fonts are CDN-only, while `npm run upload:assets` updates vendor CSS and `webflow.js`

## Local development

```bash
cp .env.example .env.development
npm install
npm run dev          # build + mock API :3000 + site :4173
npm run dev:watch    # rebuild on file changes
```

Local dev loads images/vendor CSS from CDN (same as production HTML).

## Build

```bash
npm run lint:public
LEAD_API_URL=https://... YANDEX_METRIKA_ID=123456 npm run build
```

## Deploy

Push to `main` → GitHub Actions: Cloud Function + build + S3 sync (like `zvenfit-frontend`).

Manual:

```bash
npm run deploy:lead-fn
npm run build
npm run deploy:yc        # full dist/ → site bucket
npm run upload:assets    # vendor CSS + webflow.js only
```

Setup details: [`docs/setup.md`](docs/setup.md)

## Webflow re-export workflow

1. Export from Webflow → save to `upload/zvenfit-kosmetologiya.webflow/`
2. Port markup changes to `public/` — keep CDN URLs for static assets
3. Keep custom JS in `public/js/`
4. `npm run upload:assets` if vendor CSS or `webflow.js` changed

Images and fonts live only in the CDN bucket. Their absolute URLs are committed
in the HTML and site CSS; they are intentionally excluded from `upload:assets`.

## Security

If a Telegram bot token was ever committed or exposed in HTML export, **revoke it in @BotFather** before production deploy.
