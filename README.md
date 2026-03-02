# Adidas F1 Audi Drop Monitor

Free GitHub Actions workflow that monitors adidas.com for new Audi F1 merchandise and sends instant notifications via Telegram and SMS.

## How it works

1. Runs every 10 minutes via GitHub Actions cron
2. Fetches Adidas Audi collection and search pages
3. Extracts product SKUs and compares against stored state
4. Sends Telegram + SMS alerts when new products appear

## Setup

### 1. Repository secrets

Go to Settings > Secrets and variables > Actions, and add:

| Secret | Value | Required |
|--------|-------|----------|
| `TELEGRAM_BOT_TOKEN` | Your Telegram bot token | Yes |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID | Yes |
| `TWILIO_SID` | Twilio Account SID | Optional |
| `TWILIO_TOKEN` | Twilio Auth Token | Optional |
| `TWILIO_FROM` | Twilio phone number | Optional |
| `TWILIO_TO` | Your phone number | Optional |

### 2. Enable Actions

Go to the Actions tab and enable workflows for this repository.

### 3. Test manually

Click "Run workflow" on the Actions tab to trigger a manual run.

## State persistence

Product state is stored in `state/products.json` via GitHub Actions cache.
This persists across runs so only genuinely new products trigger alerts.
