# Setup: Telegram Bot + Yandex Cloud

This guide configures the Telegram lead Function, the static site bucket, the assets bucket, and GitHub Actions deployment.

## Production topology

```text
Form → Yandex Cloud Function (secrets in Function env) → Telegram group

estetika.zvenfit.ru CDN
  └─ zvenfit-estetika-frontend → complete dist/ artifact

public HTML/CSS asset URLs
  └─ storage.yandexcloud.net/zvenfit-estetika → images, fonts, vendor CSS, webflow.js
```

The production workflow deploys the Function first, uses its invoke URL while building the site, validates `dist/`, and uploads the site last.

## Prerequisites

- Node.js 22 and npm
- Yandex Cloud CLI (`yc`), authenticated with `yc init`
- AWS CLI for manual Object Storage syncs
- `jq` for the setup snippets and `scripts/setup-storage.sh`
- a Telegram bot and target group

Never commit any bot token, authorized key JSON, or Object Storage secret key.

## 1. Telegram

1. Create the bot with BotFather, or revoke and replace its token if it was ever exposed.
2. Add the bot to the target group.
3. Send a message in the group and request updates:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"
```

Copy the target `chat.id`; group IDs are usually negative.

## 2. Folder and CI service account

```bash
yc init
export YC_FOLDER_ID="$(yc config get folder-id)"
export SA_NAME=github-ci-zvenfit-estetika

yc iam service-account create --name "$SA_NAME"
SA_ID="$(yc iam service-account get --name "$SA_NAME" --format json | jq -r '.id')"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role serverless.functions.admin \
  --service-account-id "$SA_ID"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role iam.serviceAccounts.user \
  --service-account-id "$SA_ID"

yc resource-manager folder add-access-binding \
  --id "$YC_FOLDER_ID" \
  --role storage.editor \
  --service-account-id "$SA_ID"
```

Create two credential sets for that account:

- an authorized key JSON for `yc` in CI → GitHub secret `YC_SA_JSON_KEY`;
- a static Object Storage access-key ID and secret → `YC_ACCESS_KEY_ID` and `YC_SECRET_ACCESS_KEY`.

The authorized key can be created locally with:

```bash
yc iam key create --service-account-name "$SA_NAME" --output sa-key.json
```

Copy its complete JSON into GitHub Secrets, then securely delete the local file. Create the static access key in the Yandex Cloud console or with the current `yc iam access-key` command; its secret is shown only when the key is created.

## 3. Object Storage

| Bucket | Contents | Updated by |
|--------|----------|------------|
| `zvenfit-estetika-frontend` | HTML, legal pages, robots, sitemap, app JS, minified site CSS | CI on `main`, or `npm run deploy:yc` |
| `zvenfit-estetika` | images, fonts, vendor CSS, `webflow.js` | images/fonts managed directly; vendor files via `npm run upload:assets` |

Create/configure both public-read buckets and the site bucket website settings:

```bash
export YC_FOLDER_ID="$(yc config get folder-id)"
npm run setup:storage
```

The generated site artifact contains:

```text
index.html
form/index.html
404.html
documents/privacy-policy.html
documents/personal-data-processing.html
robots.txt
sitemap.xml
css/zvenfit-kosmetologiya.webflow.min.css
js/*.js (application scripts; no webflow.js)
```

It must not contain `images/`, `fonts/`, vendor CSS, source site CSS, or `js/webflow.js`.

### Upload mutable assets

`upload:assets` reads vendor `normalize.css` and `webflow.css` from `upload/zvenfit-kosmetologiya.webflow/`, minifies them, and takes `webflow.js` from `public/js/`:

```bash
YC_ACCESS_KEY_ID=... \
YC_SECRET_ACCESS_KEY=... \
npm run upload:assets
```

The script synchronizes only the `css/` and `js/` prefixes. It cannot delete images or fonts.

### Upload the site manually

The `deploy:yc` package script invokes the AWS CLI directly, so it uses the `AWS_*` credential names even though the keys belong to Yandex Object Storage:

```bash
LEAD_API_URL=https://... \
YANDEX_METRIKA_ID=... \
ASSET_VERSION=manual \
npm run build

node scripts/check-build.cjs

AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
npm run deploy:yc
```

## 4. CDN and DNS

1. Configure a CDN resource whose origin is the `zvenfit-estetika-frontend` website bucket.
2. Add `estetika.zvenfit.ru` as its custom domain.
3. Point the DNS CNAME to the CDN hostname.
4. Attach a managed TLS certificate.
5. Verify unknown paths serve `/404.html` and that HTML is not cached indefinitely.

The assets bucket is referenced directly at `https://storage.yandexcloud.net/zvenfit-estetika`; the value is also the `assetsCdnBase` in `scripts/structured-data.config.json`.

## 5. GitHub configuration

Repository secrets:

| Name | Value |
|------|-------|
| `YC_SA_JSON_KEY` | Complete authorized service-account key JSON |
| `YC_FOLDER_ID` | Yandex Cloud folder ID used by `yc` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Target group ID |
| `YC_ACCESS_KEY_ID` | Object Storage static access-key ID |
| `YC_SECRET_ACCESS_KEY` | Object Storage static secret key |

Repository variables:

| Name | Value |
|------|-------|
| `YANDEX_METRIKA_ID` | Production Metrika counter ID |
| `ASSET_VERSION` | Optional cache-busting override; the workflow run number is the fallback |

The workflow has the production CORS allowlist in `ALLOWED_ORIGINS`. When adding or removing a production hostname, update that value in `.github/workflows/main.yml` and redeploy the Function.

## 6. First deployment

1. Confirm images and fonts already exist in the assets bucket.
2. Upload the current vendor CSS and `webflow.js` with `npm run upload:assets`.
3. Configure all GitHub secrets and variables above.
4. Push `main` or start the `Deploy to Production` workflow manually.
5. Confirm the Function, site build, artifact check, and both S3 sync steps are green.

The workflow order is:

```text
deploy Function → get invoke URL → lint → unit tests → build → check dist → upload non-HTML → upload HTML no-cache
```

For a complete manual deployment, deploy the Function first and use the URL printed by the script for the site build:

```bash
export YC_FOLDER_ID=...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
export ALLOWED_ORIGINS=https://estetika.zvenfit.ru,https://www.estetika.zvenfit.ru
npm run deploy:lead-fn

export LEAD_API_URL=...  # printed by deploy:lead-fn
export YANDEX_METRIKA_ID=...
export ASSET_VERSION=manual
npm run build
node scripts/check-build.cjs

export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
npm run deploy:yc
```

## Local development and form testing

```bash
cp .env.example .env.development
npm ci
npm run dev:watch
```

- Site: `http://localhost:4173`
- Form API: `http://localhost:3000`
- `/`: newsletter form
- `/form/`: lead form

Without Telegram credentials the local API logs requests and returns success. To exercise live Telegram delivery locally, set both `TELEGRAM_*` values and include `http://localhost:4173` in `ALLOWED_ORIGINS` in `.env.development`.

## Troubleshooting

Run the complete local verification first:

```bash
npm test
```

Inspect the injected Function URL and artifact contents:

```bash
rg 'ZVENFIT_LEAD_API' dist/js/lead-config.js
find dist -maxdepth 3 -type f | sort
node scripts/check-build.cjs
```

Test the deployed Function (use a valid phone number and an allowed origin):

```bash
URL="$(yc serverless function get \
  --name zvenfit-estetika-telegram-lead \
  --format json | jq -r '.http_invoke_url')"

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"lead","name":"Test","phone":"+79991234567","service":"Позвонить"}'

curl -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "Origin: https://estetika.zvenfit.ru" \
  -d '{"form_type":"newsletter","phone":"+79991234567"}'
```

Expected safeguards in the Function include an origin allowlist, JSON/content-length and field validation, a honeypot, in-memory per-instance IP throttling, and Telegram error handling. Unit coverage lives in `tests/unit/telegram-lead.test.cjs`.
