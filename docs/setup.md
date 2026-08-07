# Setup: Telegram Bot + Yandex Cloud

Deploy Cloud Function for lead/newsletter forms + static site to Object Storage.

## Architecture

```
Form on site → Cloud Function (token in env) → Telegram group

Site bucket (CI):     zvenfit-estetika-frontend  → full dist/ (HTML, app JS, site CSS)
Assets CDN (manual):  zvenfit-estetika/          → images, vendor CSS, fonts, webflow.js

CDN estetika.zvenfit.ru → site bucket
HTML references CDN assets directly in public/ (like zvenfit-frontend → zvenfit/v2/)
```

One workflow deploys function first, then builds site and syncs full `dist/` to S3.

---

## 1. Telegram

```bash
# @BotFather → /newbot (or /revoke if old token was exposed in Webflow export)
# Add bot to group, get chat_id:
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

---

## 2. Yandex Cloud

```bash
curl -sSL https://storage.yandexcloud.net/yandexcloud-yc/install.sh | bash
yc init
yc config get folder-id   # b1g...
```

### Service Account (CI)

```bash
export YC_FOLDER_ID=$(yc config get folder-id)
export SA_NAME=github-ci-zvenfit-estetika

yc iam service-account create --name $SA_NAME
SA_ID=$(yc iam service-account get --name $SA_NAME --format json | jq -r '.id')

yc resource-manager folder add-access-binding \
  --id $YC_FOLDER_ID \
  --role serverless.functions.admin \
  --service-account-id $SA_ID

yc resource-manager folder add-access-binding \
  --id $YC_FOLDER_ID \
  --role iam.serviceAccounts.user \
  --service-account-id $SA_ID

yc iam key create --service-account-name $SA_NAME --output sa-key.json
cat sa-key.json   # → GitHub Secret YC_SA_JSON_KEY
rm sa-key.json
```

### Object Storage — два бакета

| Бакет | Назначение | Кто заливает |
|-------|-----------|--------------|
| `zvenfit-estetika-frontend` | HTML (including legal), robots, sitemap, app JS, min site CSS | **CI** (push main) |
| `zvenfit-estetika` | vendor CSS, images, fonts, webflow.js | Images/fonts live only in the bucket; CSS/webflow.js via `upload:assets` |

```bash
export YC_FOLDER_ID=$(yc config get folder-id)
npm run setup:storage   # создаёт оба бакета
```

**Site bucket** (CI syncs full `dist/`):

```
index.html
form/index.html
documents/privacy-policy.html
documents/personal-data-processing.html
robots.txt
sitemap.xml
css/zvenfit-kosmetologiya.webflow.min.css
js/*.js (app scripts, not webflow.js)
```

**Assets CDN** (`zvenfit-estetika/`):

```
css/normalize.min.css
css/webflow.min.css
images/
fonts/
js/webflow.js
```

CDN base (hardcoded in `public/` HTML):

`https://storage.yandexcloud.net/zvenfit-estetika`

**Заливка изменяемых CDN-ассетов** (vendor CSS and `webflow.js`):

```bash
YC_ACCESS_KEY_ID=... YC_SECRET_ACCESS_KEY=... npm run upload:assets
```

The command synchronizes only `css/` and `js/`. Images and fonts live only in
the CDN bucket and cannot be deleted by this upload.

**Заливка сайта** — CI или вручную:

```bash
LEAD_API_URL=... YANDEX_METRIKA_ID=... npm run build
YC_ACCESS_KEY_ID=... YC_SECRET_ACCESS_KEY=... npm run deploy:yc
```

Static access keys (SA → Create static access key) → `YC_ACCESS_KEY_ID` / `YC_SECRET_ACCESS_KEY`.

### CDN + DNS

1. CDN resource → origin: **`zvenfit-estetika-frontend`** (site bucket)
2. Custom domain: `estetika.zvenfit.ru`
3. DNS CNAME in zvenfit.ru zone → CDN hostname
4. Managed SSL certificate

Assets bucket отдаётся напрямую через `storage.yandexcloud.net` (public read).

---

## 3. GitHub Secrets & Variables

**Secrets:**

| Name | Value |
|------|-------|
| `YC_SA_JSON_KEY` | Full SA key JSON |
| `YC_FOLDER_ID` | Folder ID |
| `TELEGRAM_BOT_TOKEN` | Bot token |
| `TELEGRAM_CHAT_ID` | Group chat ID |
| `YC_ACCESS_KEY_ID` | S3 static key |
| `YC_SECRET_ACCESS_KEY` | S3 secret |

**Variables:**

| Name | Value |
|------|-------|
| `YANDEX_METRIKA_ID` | Metrika counter ID |
| `ASSET_VERSION` | Optional cache bust override |

---

## 4. First deploy

```bash
# 1. Ensure images/fonts are already in CDN, then upload vendor CSS/webflow.js
YC_ACCESS_KEY_ID=... YC_SECRET_ACCESS_KEY=... npm run upload:assets

# 2. Push to trigger CI
git push origin main
```

Or manually:

```bash
export YC_FOLDER_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
npm run deploy:lead-fn

export LEAD_API_URL=<from output>
export YANDEX_METRIKA_ID=...
npm run build
npm run deploy:yc
```

---

## Local dev

```bash
cp .env.example .env.development
npm install
npm run dev
# Site: http://localhost:4173
# Mock API: http://localhost:3000
```

Test forms:
- `/` — newsletter (phone only)
- `/form/` — lead (name, phone, contact method)

---

## CORS / new domain

Edit `ALLOWED_ORIGINS` in `.github/workflows/main.yml`, push to main.

---

## Troubleshooting

```bash
# Function test
URL=$(yc serverless function get --name zvenfit-estetika-telegram-lead --format json | jq -r .http_invoke_url)
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"lead","name":"Test","phone":"+7999","service":"Позвонить"}'

# Newsletter test
curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"newsletter","phone":"+79991234567"}'
```

Check built config:

```bash
grep ZVENFIT_LEAD_API dist/js/lead-config.js
ls dist/   # should contain documents/*.html, but not images/ or fonts/
```
