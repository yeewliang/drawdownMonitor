# Drawdown Monitor

Track how far stocks, ETFs, indexes and crypto are from their all-time high (ATH), with alerts to Telegram and email.

- **Sign in** with email/password, Google or Apple (Firebase Auth)
- **Watchlists** of any Yahoo Finance symbol: `AAPL`, `^GSPC` (S&P 500), `^NDX`, `^N225`, `^STI`, `BTC-USD`, `EURUSD=X`, ...
- **Prices** refreshed every 5 minutes (real-time for US markets, at most ~15 min delay for other exchanges)
- **Drawdown** from closing ATH or intraday ATH (per-user setting)
- **Alerts** per symbol at your own thresholds (e.g. -10%, -20%, -30%) via Telegram bot and/or email
- **Sharing**: share a watchlist read-only with specific people by email, or by public link; recipients can copy it to set their own alerts

## Architecture

```
web/         React + Vite SPA (Firebase Hosting)
functions/   Cloud Functions (Node 22, TypeScript)
  refreshQuotes      every 5 min: fetch prices, update ATH/drawdown, evaluate alerts, notify
  onItemCreated      backfill full price history when a symbol is first added
  onWatchlistDeleted delete a list's items
  searchSymbols      symbol search proxy (callable)
  sendTestAlert      send a sample alert to the caller (callable)
  unlinkTelegram     disconnect Telegram (callable)
  telegramWebhook    Telegram bot: /start <code>, /status, /stop, /help
firestore.rules
```

### Firestore data model

| Path | Written by | Contents |
| --- | --- | --- |
| `users/{uid}` | user (Telegram fields: functions only) | `athBasis`, `notifyEmail`, `alertEmail`, `notifyTelegram`, `telegramChatId`, `telegramLinkCode` |
| `watchlists/{id}` | owner | `ownerId`, `name`, `isPublic`, `sharedWith[]` (lowercase emails) |
| `watchlists/{id}/items/{symbol}` | owner | `thresholds[]`, `alertsEnabled`, `alertState` |
| `quotes/{symbol}` | functions only | price, day change, intraday and closing ATH with dates, drawdowns |

### How ATH and drawdown are computed

1. When a symbol is first added, its **entire daily history** is downloaded and both the highest intraday high and the highest daily close are recorded.
2. Every 5 minutes only the last few sessions are fetched and merged into the stored ATH.
3. Full history is re-downloaded once a day, so stock splits (which Yahoo adjusts historically) are picked up.
4. While a session is open, today's "close" is just the live price, so it is not counted as a closing high until the session ends.
5. `drawdown = 1 - price / max(ATH, price)`, so a new high mid-session shows 0%.

### How alerts work

- Each threshold fires **once** when drawdown reaches it.
- It re-arms after the drawdown recovers more than 1 percentage point above it (e.g. a -10% alert re-arms once drawdown is below 9%), so a price hovering near a level does not spam you.
- If a gap down crosses several thresholds at once, one message reports the deepest one.
- All alerts for a user in one cycle are combined into a single Telegram message and a single email.
- Alert state is saved before sending, so a crash can never produce duplicate alerts.
- Editing a symbol's thresholds resets its alert state.

### Price source

[Yahoo Finance's chart API](https://query1.finance.yahoo.com/v8/finance/chart/AAPL) needs no API key and covers equities, ETFs, indexes, FX and crypto worldwide, with real-time US prices. It is an unofficial API, so all access goes through the `PriceProvider` interface in `functions/src/providers/`. To switch to a paid vendor (Polygon, Twelve Data, EODHD, ...), implement `getQuote` and `search` and return it from `getProvider()`.

## Setup

### Step 1: Create the Firebase project

1. Create a project at <https://console.firebase.google.com>.
2. Upgrade it to the **Blaze** (pay as you go) plan. Scheduled functions and outbound network calls require it. Typical personal usage stays within the free tier.
3. Install the CLI and log in:
   ```bash
   npm install -g firebase-tools
   firebase login
   ```
4. Put your project ID in `.firebaserc` (replace `your-firebase-project-id`).

### Step 2: Enable Firestore

1. Firebase console > **Firestore Database** > Create database (production mode).

### Step 3: Enable sign-in providers

Firebase console > **Authentication** > Sign-in method:

1. **Email/Password**: enable.
2. **Google**: enable, choose a support email.
3. **Apple**:
   1. In the [Apple Developer portal](https://developer.apple.com/account/resources/identifiers/list), create an App ID with *Sign in with Apple* enabled.
   2. Create a **Services ID** (this is the client ID). Configure it with domain `<project-id>.firebaseapp.com` and return URL `https://<project-id>.firebaseapp.com/__/auth/handler`.
   3. Create a **Key** with *Sign in with Apple* enabled and download the `.p8` file.
   4. Back in Firebase, enable Apple and fill in the Services ID, Team ID, Key ID and private key.
   5. To receive email for users who choose *Hide My Email*, register your sending domain under Apple's *Private Email Relay Service*.
4. Under Authentication > Settings > **Authorized domains**, add any custom domain you deploy to.

### Step 4: Configure the web app

1. Firebase console > Project settings > **Your apps** > add a Web app.
2. Copy the config into `web/.env.local`:
   ```bash
   cp web/.env.example web/.env.local
   # then fill in the VITE_FIREBASE_* values and VITE_TELEGRAM_BOT_USERNAME
   ```

### Step 5: Create the Telegram bot

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot` and follow the prompts. Note the **bot token** and **username**.
2. Optionally send `/setcommands` to BotFather with:
   ```
   status - Current drawdowns for your watchlists
   stop - Unlink this chat
   help - Help
   ```
3. Store the secrets (generate any random string for the webhook secret):
   ```bash
   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
   firebase functions:secrets:set TELEGRAM_WEBHOOK_SECRET   # e.g. output of: openssl rand -hex 32
   ```
4. Set `VITE_TELEGRAM_BOT_USERNAME` in `web/.env.local` to the bot username (without `@`).

### Step 6: Configure email (SMTP)

Any SMTP provider works (SendGrid, Resend, Mailgun, Amazon SES, Gmail with an app password).

1. Create `functions/.env.<project-id>` from the example:
   ```bash
   cp functions/.env.example functions/.env.<project-id>
   # set APP_URL, SMTP_HOST, SMTP_PORT, SMTP_USER, MAIL_FROM
   ```
2. Store the SMTP password as a secret:
   ```bash
   firebase functions:secrets:set SMTP_PASS
   ```
3. If you do not want email alerts, leave `SMTP_HOST` empty and set `SMTP_PASS` to any placeholder.

### Step 7: Install and deploy

```bash
npm --prefix functions install
npm --prefix web install
firebase deploy
```

This deploys the security rules, functions and the web app (`https://<project-id>.web.app`).

### Step 8: Register the Telegram webhook

After the first deploy, point Telegram at the `telegramWebhook` function:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://us-central1-<project-id>.cloudfunctions.net/telegramWebhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
```

Then in the app go to **Settings > Connect Telegram**, press **Start** in Telegram, and use **Send test alert** to confirm both channels.

## Local development

```bash
# 1. Web app against the emulators: set VITE_USE_EMULATORS=true and
#    VITE_FIREBASE_PROJECT_ID=demo-drawdown in web/.env.local
# 2. Start emulators (Auth, Firestore, Functions)
npm --prefix functions run build
firebase emulators:start --project demo-drawdown
# 3. In another terminal
npm --prefix web run dev
```

The scheduled refresh does not run in the emulator; trigger a cycle from a Node shell by calling `refreshAllAndAlert()` from `functions/lib/jobs/refreshAll.js` with `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.

### Tests

```bash
npm --prefix functions test         # unit tests: ATH/drawdown math, alert logic, Yahoo parsing, message formatting
npm --prefix functions run test:rules  # Firestore security rules against the emulator (needs Java)
npm --prefix web run build          # type-check and build the web app
```

## Security notes

- Watchlists shared by email are only visible to accounts whose email is **verified** (Google and Apple are verified automatically; email/password users get a verification email). Otherwise anyone could register an unverified account with someone else's address.
- Public lists can be opened by link but cannot be listed or searched.
- `quotes` and Telegram link fields can only be written by Cloud Functions.
- The Telegram webhook verifies Telegram's secret token header on every request, and link codes are 144-bit random, single use.

## Limitations

- Yahoo Finance is unofficial and can change or rate-limit without notice; swap the provider if you need an SLA.
- The refresh job scans all watchlist items each cycle, which is fine for thousands of items. For much larger scale, maintain a `trackedSymbols` collection instead.
- Prices are polled every 5 minutes, so alerts can lag a move by up to ~5 minutes plus the exchange's own data delay.
