# ZvenFit Estetika Frontend

Static Webflow landing, a small vanilla-JS runtime, and one Yandex Cloud Function that sends lead and newsletter forms to Telegram.

Production: `https://estetika.zvenfit.ru`.

## Architecture

```text
Browser (estetika.zvenfit.ru)
  ├─ site CDN → zvenfit-estetika-frontend bucket
  │    HTML, legal pages, app JS, minified site CSS, robots.txt, sitemap.xml
  ├─ storage.yandexcloud.net/zvenfit-estetika
  │    images, fonts, vendor CSS, webflow.js
  └─ POST lead/newsletter → Yandex Cloud Function → Telegram
```

Asset-CDN URLs are committed in `public/` HTML and CSS. The build creates a lean `dist/`: images, fonts, vendor CSS, and `webflow.js` are removed because they are served from the assets bucket.

## Source of truth and project layout

Edit `public/`, `scripts/`, and `functions/`; never edit generated `dist/`.

| Path | Purpose |
|------|---------|
| `public/` | Tracked HTML, site CSS, app JS, robots and sitemap |
| `public/form/` | Lead form page |
| `public/documents/` | Legal HTML, deployed without landing-page injections |
| `functions/telegram-lead/` | Lead/newsletter validation and Telegram delivery |
| `scripts/build-static.cjs` | Builds `public/` into `dist/` |
| `scripts/structured-data.config.json` | Site URL, assets CDN, page metadata and JSON-LD data |
| `tests/unit/` | Cloud Function unit tests |
| `tests/visual/` | Playwright screenshots for desktop, tablet and mobile |
| `upload/` | Raw Webflow export staging (gitignored, local only) |
| `dist/` | Generated deployment artifact (gitignored) |

Primary routes are `/`, `/form/`, `/404.html`, and the two files under `/documents/`.

## Requirements

- Node.js 22 and npm (`npm ci` is preferred when `package-lock.json` is unchanged)
- CDN access for images and Webflow assets during local rendering
- Optional for deployment: Yandex Cloud CLI (`yc`) and AWS CLI
- Optional for visual tests: Playwright Chromium (`npx playwright install chromium`)

## Local development

```bash
cp .env.example .env.development
npm ci
npm run dev:watch
```

Open `http://localhost:4173`; the local form endpoint listens on `http://localhost:3000`.

`dev:watch` rebuilds when `public/`, build snippets, or structured-data config changes. Without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, the mock API only logs the request and returns `{ "ok": true }`. If both are exported, it runs the real handler and sends to Telegram.

Use `npm run dev` for a one-time build without file watching.

## Build

```bash
LEAD_API_URL=https://example.invalid/lead \
YANDEX_METRIKA_ID=123456 \
ASSET_VERSION=local \
npm run build
```

Build inputs:

| Variable | Behavior |
|----------|----------|
| `LEAD_API_URL` | Injected into `dist/js/lead-config.js`; production forms cannot submit when empty |
| `YANDEX_METRIKA_ID` | Injects Yandex Metrika when set |
| `ASSET_VERSION` | Cache-busting value for app JS, site CSS and CDN `webflow.js`; defaults to `1` |
| `SITE_URL` | Canonical/OG base URL; defaults to `siteUrl` in structured-data config |
| `NODE_ENV=development` | Loads `.env.development` and defaults the form API to `http://localhost:3000` |

The build also minifies the site CSS, injects UTM attribution, Open Graph, canonical tags and JSON-LD, normalizes Webflow links, and prunes CDN-only assets. Legal pages receive none of the landing-page injections; `/404.html` remains `noindex` and receives no analytics or JSON-LD.

## Verification

```bash
npm test                 # lint + Function unit tests + production build checks
npm run test:visual      # compare Playwright screenshots
```

Visual baselines are platform-specific and currently local/gitignored. Create or intentionally refresh them with `npm run test:visual:update`, then rerun `npm run test:visual`.

For a manual smoke test, open `/?utm_source=test`, submit the newsletter, then submit `/form/` and verify the logged request or Telegram message includes the attribution.

## Deployment

A push to `main` or a manual workflow dispatch runs `.github/workflows/main.yml`:

1. deploy the Cloud Function and read its public invoke URL;
2. install dependencies, lint, and run Function unit tests;
3. build with the Function URL, Metrika ID and cache version;
4. validate `dist/` with `scripts/check-build.cjs`;
5. sync non-HTML files, then HTML with `no-cache`, to the site bucket.

Manual deployment:

```bash
export YC_FOLDER_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
npm run deploy:lead-fn

export LEAD_API_URL=...       # value printed by deploy:lead-fn
export YANDEX_METRIKA_ID=...
npm run build

export AWS_ACCESS_KEY_ID=...  # Yandex Object Storage static access key ID
export AWS_SECRET_ACCESS_KEY=...
npm run deploy:yc
```

`npm run upload:assets` uses `YC_ACCESS_KEY_ID` and `YC_SECRET_ACCESS_KEY` instead. It updates only minified vendor CSS and `webflow.js`; it never touches images or fonts.

Complete infrastructure and secret setup: [`docs/setup.md`](docs/setup.md). Marketing attribution rules: [`docs/utm-attribution-marketing.md`](docs/utm-attribution-marketing.md).

## Webflow re-export workflow

1. Export Webflow into `upload/zvenfit-kosmetologiya.webflow/`.
2. Port markup and site-CSS changes into `public/`, preserving CDN asset URLs.
3. Keep custom runtime code in `public/js/`.
4. Run `npm test`.
5. If `normalize.css`, `webflow.css`, or `webflow.js` changed, run `npm run upload:assets` with Object Storage credentials.

Images and fonts are managed directly in the assets bucket and are intentionally excluded from `upload:assets`.

## Security

Never commit bot tokens, service-account keys, static access keys, or real `.env*` files. If a Telegram bot token was exposed in a Webflow export or HTML, revoke it in BotFather before deployment.
