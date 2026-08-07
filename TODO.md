# ZvenFit Estetika — backlog

Приоритет: **Launch blockers → High → Medium → Optional parity**. Agent guide: [`AGENTS.md`](AGENTS.md).

---

## Launch blockers

- [ ] **GitHub Secrets + vars** — `YC_*`, `TELEGRAM_*`, `YANDEX_METRIKA_ID`, optional `ASSET_VERSION`
- [ ] **CDN runtime assets** — run `npm run upload:assets` before go-live (images/fonts already live in CDN; command updates vendor CSS/webflow.js)
- [ ] **Cloud Function** — deploy + verify `LEAD_API_URL` in CI build
- [ ] **DNS + CDN** — `estetika.zvenfit.ru` → site bucket, 404 routing
- [x] **Initial commit + push** — repository is on `origin/main`; CI can run
- [ ] **Revoke old Telegram token** if ever exposed in Webflow export / HTML

---

## High (post-launch / UX)

- [x] **Lead form a11y** — custom select keyboard/ARIA; duplicate IDs if any
- [ ] **Touch targets** — mobile menu, form buttons ≥44px @ 375px
- [ ] **`:focus-visible`** on links, buttons, custom select
- [ ] **Footer / muted text contrast** — WCAG AA on dark background
- [ ] **`prefers-reduced-motion`** — reduce non-essential animations if added later

---

## Medium (polish / SEO)

- [ ] **Partner logos grid** — rename `partners/brand-01..12.webp` to real names when identified
- [ ] **OG image** — dedicated 1200×630 share image (currently webclip-180)
- [x] **Legal pages in sitemap** — served from the site bucket
- [ ] **Newsletter consent copy** — align with privacy policy wording
- [ ] **Stronger spam protection** — basic honeypot + per-instance IP throttling exist; add Turnstile/reCAPTCHA if abuse appears

---

## Infra / DX

- [x] `AGENTS.md` + `.cursor/rules/`
- [x] `upload/` for raw Webflow (was `export/`)
- [x] `scripts/structured-data.config.json` (SEO single source)
- [x] `npm run lint:public` + CI lint step
- [x] Cloud Function validation/security unit tests + CI unit-test step
- [x] Deterministic build artifact check (`npm run test:build` / `scripts/check-build.cjs`)
- [x] Local Playwright screenshot suite for desktop, tablet and mobile (baselines are gitignored)
- [x] UTM attribution (client + Cloud Function + marketing doc)
- [ ] **Security response headers** — configure on site bucket/CDN (HTML meta cannot set HTTP security headers)
- [x] Build injects Metrika, UTM, OG, JSON-LD
- [x] Static `public/robots.txt` + `public/sitemap.xml` (manual, like main)
- [x] Semantic image paths (`logo/`, `hero/`, `why-us/`, `services/`, `apparatus/`, `partners/`, …)
- [x] CSS `url(../images|fonts)` → CDN rewrite at build
- [ ] **Lean `public/`** — move CDN-only assets to `upload/` as sole source (images remain locally as upload source)
- [ ] **Lead logging** — Cloud Logging or table (optional)
- [ ] **Form smoke test in CI** — optional

---

## Optional parity with `zvenfit-frontend` (not needed for v1)

- [ ] **Top.Mail.Ru / GTM** — main site uses extra tags; estetika uses Yandex Metrika only
- [ ] **VK pixel** — not in scope unless marketing asks
- [ ] **Schedule / Fitbase** — N/A for estetika
- [ ] **App download badges** — N/A
- [ ] **Yandex Maps org photos fetch at build** — N/A (no embedded map block)
- [ ] **26-page snippet marker system** — overkill for 3 pages; build injects at `</head>` instead
- [ ] **Prettier + heavy eslint stack** — main has TS/React rules; estetika uses minimal `eslint:recommended`

---

## Done

- [x] CDN URLs hardcoded in `public/` (`zvenfit-estetika/`)
- [x] CI deploys full `dist/` to site bucket (HTML no-cache)
- [x] Legal docs renamed (`privacy-policy.html`, `personal-data-processing.html`)
- [x] Telegram handler: lead + newsletter + UTM block in message
- [x] `404.html` with noindex

---

## Pre-release checklist

- [ ] `npm test` passes (lint + unit tests + checked production build)
- [ ] Optional: `npm run test:visual` passes against local baselines
- [ ] Test lead + newsletter with `?utm_source=test`
- [ ] Metrika fires on production build (`YANDEX_METRIKA_ID` set)
- [ ] CDN assets load from `storage.yandexcloud.net/zvenfit-estetika`
