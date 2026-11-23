# Gold Watcher — 24/7 price alerts by email (GitHub Actions + Formspree)

Checks the gold price (RM per gram) about every 5 minutes on GitHub's servers and emails you when a price in `config.json` is reached. Your PC can be off.

## One-time setup
1. Create a **public** repo on GitHub (public = free unlimited Actions minutes) and upload every file in this folder (keep `.github/workflows/watch.yml`).
2. Settings → Secrets and variables → Actions → **Secrets** → New repository secret
   `FORMSPREE_URL` = `https://formspree.io/f/mlgagyzk`
3. Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
4. Actions tab → *gold-watch* → **Run workflow** → tick `test_email` → Run. Check the inbox (and Spam).
5. Done. It now runs by itself.

## Changing the email address
- **Where the email lands:** Formspree sends to the email registered on the form. Log in to formspree.io → your form → Settings → set the notification email (currently should be `juniorlooi95@gmail.com`).
- **Reply-to address shown in the email:** change `notifyEmail` in `config.json`, OR set a repo Variable (Settings → Secrets and variables → Actions → **Variables** → `NOTIFY_EMAIL`), which overrides the file.
- Formspree cannot send to arbitrary recipients from the code. If you want that, ask for the Gmail/Apps Script or Resend version.

## Changing alert prices (`config.json`)
```json
"levels": [
  { "label": "STEP 1: sell 1g", "direction": "above", "price": 580 }
]
```
- `direction`: `"above"` fires when price >= value; `"below"` fires when price <= value.
- Each level fires **once**, then re-arms only after the price moves back ~0.3% (`rearmPercent`).
- `move.percent`: also alert on a big move (default 2%) vs the last reference price.
- `position.avgCostPerGram`: your average cost; alerts at 0% / +3% / +5% vs that cost.
- `heartbeatDays`: "I'm alive" email every N days. Set `0` to turn off.
Edit the file on GitHub (pencil icon) → Commit. Takes effect on the next run.

## Current plan (6 g held, net cost RM3,751.34)
| Price | Action |
|---|---|
| RM580 | sell 1 g |
| RM600 | sell 1 g |
| RM615 | sell 2 g |
| RM625.30 | break-even price reached |
| RM630 | sell last 2 g |
| below RM460 | review plan, do not panic-sell |
Selling in the Gold app is still done manually by you; the watcher only emails.

## Troubleshooting
- **No test email:** open the failed run in the Actions tab; the log shows Formspree's error. Check the secret name `FORMSPREE_URL`, and the form's email is confirmed in Formspree.
- **Runs stopped:** GitHub pauses scheduled workflows after 60 days of no repo activity (public repos). Actions tab → enable workflow again.
- **Delays:** GitHub cron can lag 5–15 min at busy times. Not suitable for second-level trading.
- **Price looks different from the Gold app:** the watcher uses the market price; the app's sell price is slightly lower (spread).
- State is stored in `state.json` (auto-committed when an alert fires). To re-trigger a level, delete its key from `state.json`.
