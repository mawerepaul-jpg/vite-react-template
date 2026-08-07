# LELE Runner Cloudflare live setup

This project now replaces the browser-only prototype with a React website, Cloudflare Worker API and Cloudflare D1 shared database.

## What this fixes

- Customer orders are saved in a shared D1 database, so they appear in the admin dashboard from another browser or device.
- The customer page contains no administrator PIN.
- Admin access uses an email and password stored as a secure server-side password hash.
- Pricing rules are stored in the database and can be changed in the admin dashboard.
- Order items are limited to 10 products per transaction.
- Totals and required deposits are calculated by the server, not trusted from the customer browser.

## 1. Use Node.js 22 or newer

This repository uses Wrangler 4, which needs Node.js 22 or newer.

```bash
node --version
```

## 2. Create the Cloudflare D1 database

From the repository folder, after signing in to Wrangler:

```bash
npx wrangler login
npx wrangler d1 create lelerunnerz-db
```

Cloudflare will print a database ID. Copy that ID.

## 3. Update wrangler.json

In `wrangler.json`, replace this value:

```json
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

with the database ID returned in step 2.

Do not commit passwords, tokens or API keys into this file.

## 4. Create the tables in the live database

```bash
npx wrangler d1 execute lelerunnerz-db --remote --file=./migrations/0001_initial.sql
```

## 5. Set two Cloudflare Worker secrets

Set a long random value for each. Store them in a password manager.

```bash
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SETUP_TOKEN
```

- `SESSION_SECRET` signs admin login sessions.
- `SETUP_TOKEN` is used once to create the first admin account.

## 6. Build and deploy

```bash
npm ci
npm run build
npm run deploy
```

## 7. Create the first administrator

1. Open the deployed website.
2. Select **Admin sign in**.
3. Select **First administrator setup**.
4. Enter your email address, a password of at least 12 characters, and the private `SETUP_TOKEN` from step 5.
5. After the first account is created, use the normal email/password sign-in screen.

The setup token is never shown to customers and is not included in the website source code.

## Important production notes

- This starter provides database-backed orders, pricing and email/password admin authentication.
- Customer product photos need Cloudflare R2 object storage before they should be accepted in the live application. Do not store large image files in D1.
- Automatic WhatsApp messages need a WhatsApp Business API integration and server-side credentials. Do not put WhatsApp access tokens in React code.
- Before taking real payments, connect a verified payment gateway and verify its callback/webhook on the Worker. Do not treat a customer-entered payment reference alone as proof of payment.
