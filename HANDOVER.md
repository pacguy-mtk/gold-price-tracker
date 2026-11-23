# HANDOVER — Gold Watcher repo rebuild (for an AI agent)

## Goal
Replace the contents of the user's GitHub repo with the project below: a **serverless 24/7 gold price watcher** that runs on **GitHub Actions** (cron every 5 min), fetches the gold price in **MYR per gram**, and sends an **email alert via Formspree** when configured price levels are hit. It replaces an old browser extension (`gold-tracker-extension`, Chrome content script + Binance PAXGUSDT polling) that was not useful because it only works while the browser is open. Delete the old extension files; do not keep them.

## User context
- Owner email for alerts: `juniorlooi95@gmail.com` (must be changeable, see below).
- Formspree endpoint: `https://formspree.io/f/mlgagyzk` — store ONLY as GitHub **secret** `FORMSPREE_URL`, never in code.
- User holds 6 g digital gold, average cost RM618.12/g (bought 7 g for RM4,326.86, sold 1 g for RM575.52). Net cost of remaining 6 g = RM3,751.34. Break-even for zero total loss = RM625.22/g. Loss-capped-at-RM100 exit = RM608.56/g. Does NOT want to buy more gold.
- Sell ladder to alert on: RM580 (sell 1 g), RM600 (1 g), RM615 (2 g), RM625.30 (break-even), RM630 (last 2 g), and below RM460 (review plan). User sells manually; the watcher only emails.
- User is in Malaysia (Asia/Kuala_Lumpur, UTC+8). Be plain and concise with them.

## Files (canonical contents below — create exactly these)
```
.github/workflows/watch.yml
watch.mjs
config.json
state.json
README.md        (user guide, below)
.gitignore
```

## Steps for the agent
1. Clone the user's repo (ask for repo URL if not given). If it is **private**, tell the user to make it public or Actions minutes will run out (5-min cron ≈ 8,600 runs/month); do not proceed silently.
2. Remove all old files (extension: `manifest.json`, `content.js`, `app.js`, `panel.html`, `styles.css`, etc.). Write the files below. Commit to the default branch.
3. Set repo Actions workflow permissions to read/write (Settings → Actions → General), required so the job can commit `state.json`. With `gh`: `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=write`.
4. Set secret: `gh secret set FORMSPREE_URL --body "https://formspree.io/f/mlgagyzk"` (or ask the user to, if you lack permission).
5. Trigger a test: `gh workflow run gold-watch -f test_email=true`, then `gh run watch`. Ask the user to confirm the email arrived (check Spam). If Formspree rejects it (HTTP 4xx), read the log and see "Known risks" — do not guess; report the exact error.
6. Trigger a normal run (`gh workflow run gold-watch`) and confirm the log prints a price like `RM4xx.xx/g (goldprice.org)`.
7. Report back to the user: repo URL, test result, and where to edit `config.json`. Point them at README.md.

## Behaviour spec (must hold)
- Price sources tried in order: (1) `https://data-asg.goldprice.org/dbXRates/MYR` → `items[0].xauPrice` is MYR per troy oz, divide by 31.1034768; (2) `https://api.gold-api.com/price/XAU` (USD/oz) × `https://open.er-api.com/v6/latest/USD` `rates.MYR`, divide by 31.1034768. Reject values outside RM100–5000/g. Exit non-zero if all fail. **Verify these endpoints work from a GitHub runner; the author could not test them live.** Do not use Binance (blocks US IPs, which GitHub runners use).
- Each `levels[]` entry fires once; it re-arms only after price retreats `rearmPercent` (0.3%) back past the level. Multiple levels crossed in one run go into one email.
- `move.percent` alert vs a reference price that resets after each alert or every `move.refreshHours`.
- `position.avgCostPerGram` alerts at `profitTargetsPercent`.
- Heartbeat email every `heartbeatDays`.
- `state.json` committed only when it changes (not every run).
- Recipient: Formspree delivers to the email registered on the form in the Formspree dashboard. The `email` field in the payload is only the reply-to. The repo Variable `NOTIFY_EMAIL` overrides `config.json` `notifyEmail`. Formspree cannot target arbitrary recipients; if the user wants that, propose Google Apps Script (`MailApp.sendEmail`, time trigger every 1 min) or Resend, and ask first.

## Known risks (tell the user, don't hide)
- Formspree's free plan may reject non-browser (server-side) POSTs or require its spam checks. Unverified. Fallback: ntfy.sh or Telegram bot (both free, instant phone push) — offer, don't switch without asking.
- GitHub cron is best-effort: delays of 5–15 min are normal. Scheduled workflows on public repos are disabled after 60 days of no repo activity.
- The repo is public so `config.json` (price levels) is visible; keep secrets in Secrets only.
- The app's sell price has a spread below market price, so real proceeds are slightly lower than the alert price.

## Acceptance tests
1. Manual run with `test_email=true` → email received at juniorlooi95@gmail.com.
2. Manual normal run → log shows current RM/g and no error; no commit if no alert.
3. Temporarily set a level just below the current price (`above`) → email arrives once; re-running does not email again; `state.json` is committed. Then restore config.
4. Changing `NOTIFY_EMAIL` variable changes the `email` value in the payload (visible only in Formspree submission).

## Canonical file contents
### `.github/workflows/watch.yml`
```yaml
name: gold-watch
on:
  schedule:
    - cron: '*/5 * * * *'     # every 5 min (GitHub may delay runs by a few minutes)
  workflow_dispatch:
    inputs:
      test_email:
        description: 'Send a test email only'
        type: boolean
        default: false
permissions:
  contents: write              # to save state.json when an alert fires
concurrency:
  group: gold-watch
  cancel-in-progress: false
jobs:
  watch:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - name: Check price
        env:
          FORMSPREE_URL: ${{ secrets.FORMSPREE_URL }}
          NOTIFY_EMAIL: ${{ vars.NOTIFY_EMAIL }}
          TEST_EMAIL: ${{ inputs.test_email && '1' || '0' }}
        run: node watch.mjs
      - name: Save state
        run: |
          if [ -n "$(git status --porcelain state.json)" ]; then
            git config user.name  "gold-watcher[bot]"
            git config user.email "gold-watcher@users.noreply.github.com"
            git add state.json
            git commit -m "state: update [skip ci]"
            git pull --rebase -q || true
            git push
          fi
```

### `watch.mjs`
```js
// Gold price watcher — runs on GitHub Actions, emails you via Formspree.
// No dependencies. Node 20+.
//
// Env:  FORMSPREE_URL  (secret)  e.g. https://formspree.io/f/xxxxxxx
//       NOTIFY_EMAIL   (optional repo Variable) overrides config.json "notifyEmail"
//       TEST_EMAIL=1   send a test email and exit
//       DRY_RUN=1      print what would happen, send nothing, don't touch state
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const OZ = 31.1034768;
const CONFIG = JSON.parse(readFileSync('config.json', 'utf8'));
const STATE_FILE = 'state.json';
const DRY = process.env.DRY_RUN === '1';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || CONFIG.notifyEmail || '';

const getJSON = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': 'gold-watcher/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
};

// ---- price sources (MYR per gram), tried in order ----
const sources = [
  ['goldprice.org', async () => {
    const j = await getJSON('https://data-asg.goldprice.org/dbXRates/MYR');
    return j.items[0].xauPrice / OZ;               // MYR per troy oz -> per gram
  }],
  ['gold-api + er-api', async () => {
    const [g, fx] = await Promise.all([
      getJSON('https://api.gold-api.com/price/XAU'),   // USD per oz
      getJSON('https://open.er-api.com/v6/latest/USD'),
    ]);
    return (g.price * fx.rates.MYR) / OZ;
  }],
];

async function getPrice() {
  const errors = [];
  for (const [name, fn] of sources) {
    try {
      const p = await fn();
      if (Number.isFinite(p) && p > 100 && p < 5000) return { price: p, source: name };
      errors.push(`${name}: implausible value ${p}`);
    } catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  throw new Error('All price sources failed:\n' + errors.join('\n'));
}

// ---- email via Formspree ----
async function sendEmail(subject, message) {
  const url = process.env.FORMSPREE_URL;
  if (!url) throw new Error('FORMSPREE_URL secret is not set');
  if (DRY) { console.log(`[DRY] EMAIL: ${subject}\n${message}\n`); return; }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    // `email` is Formspree's reply-to field. The inbox that actually receives the
    // notification is the email set on the form in the Formspree dashboard.
    body: JSON.stringify({ _subject: subject, subject, email: NOTIFY_EMAIL, message }),
    signal: AbortSignal.timeout(20000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Formspree HTTP ${r.status}: ${body.slice(0, 300)}`);
  console.log('Email sent:', subject);
}

const rm = (n) => 'RM' + n.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const loadState = () => existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};

async function main() {
  if (process.env.TEST_EMAIL === '1') {
    await sendEmail('Gold watcher: test email', 'If you can read this, GitHub -> Formspree -> your inbox works.');
    return;
  }

  const { price, source } = await getPrice();
  console.log(`${new Date().toISOString()}  ${rm(price)}/g  (${source})`);

  const state = loadState();
  state.levels ??= {};          // levelKey -> true when already alerted (re-arms on cross back)
  const now = Date.now();
  const alerts = [];
  let dirty = false;

  // 1) Price levels (above / below), with hysteresis so you don't get spammed
  const hyst = (CONFIG.rearmPercent ?? 0.3) / 100;
  for (const lv of CONFIG.levels ?? []) {
    const key = `${lv.direction}:${lv.price}`;
    const hit = lv.direction === 'above' ? price >= lv.price : price <= lv.price;
    const rearm = lv.direction === 'above' ? price <= lv.price * (1 - hyst) : price >= lv.price * (1 + hyst);
    if (hit && !state.levels[key]) {
      state.levels[key] = true; dirty = true;
      alerts.push(`${lv.label || key}: price ${rm(price)}/g is ${lv.direction} ${rm(lv.price)}/g`);
    } else if (!hit && rearm && state.levels[key]) {
      delete state.levels[key]; dirty = true;
    }
  }

  // 2) Big-move alert vs a reference price (resets after each alert, or after refreshHours)
  const mv = CONFIG.move;
  if (mv?.percent) {
    if (!state.ref || now - state.ref.t > (mv.refreshHours ?? 24) * 3600e3) {
      state.ref = { p: price, t: now }; dirty = true;
    } else {
      const chg = ((price - state.ref.p) / state.ref.p) * 100;
      if (Math.abs(chg) >= mv.percent) {
        alerts.push(`Big move: ${chg > 0 ? '+' : ''}${chg.toFixed(2)}% since ${new Date(state.ref.t).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })} (was ${rm(state.ref.p)}/g)`);
        state.ref = { p: price, t: now }; dirty = true;
      }
    }
  }

  // 3) Your position: break-even / profit vs average cost
  const pos = CONFIG.position;
  if (pos?.avgCostPerGram) {
    const pnl = ((price - pos.avgCostPerGram) / pos.avgCostPerGram) * 100;
    console.log(`vs avg cost ${rm(pos.avgCostPerGram)}/g: ${pnl.toFixed(2)}%`);
    for (const t of pos.profitTargetsPercent ?? []) {
      const key = `profit:${t}`;
      if (pnl >= t && !state.levels[key]) { state.levels[key] = true; dirty = true; alerts.push(`Position at ${t >= 0 ? '+' : ''}${t}% vs your average cost ${rm(pos.avgCostPerGram)}/g (now ${pnl.toFixed(2)}%)`); }
      else if (pnl < t - 0.5 && state.levels[key]) { delete state.levels[key]; dirty = true; }
    }
  }

  // 4) Optional heartbeat so you know it's alive
  if (CONFIG.heartbeatDays) {
    if (!state.lastHeartbeat) { state.lastHeartbeat = now; dirty = true; }
    else if (now - state.lastHeartbeat > CONFIG.heartbeatDays * 86400e3) {
      alerts.push(`Heartbeat: watcher is alive. Price ${rm(price)}/g`);
      state.lastHeartbeat = now; dirty = true;
    }
  }

  if (alerts.length) {
    await sendEmail(`Gold alert: ${rm(price)}/g`, `${alerts.join('\n\n')}\n\nCurrent: ${rm(price)}/g (${source})\nTime: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })} MYT`);
  }
  if (dirty && !DRY) writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

### `config.json`
```json
{
  "notifyEmail": "juniorlooi95@gmail.com",
  "rearmPercent": 0.3,
  "heartbeatDays": 30,
  "levels": [
    {
      "label": "Falling hard: review plan (don't panic-sell)",
      "direction": "below",
      "price": 460
    },
    {
      "label": "Recovering: RM540 reached, hold",
      "direction": "above",
      "price": 540
    },
    {
      "label": "STEP 1: sell 1g",
      "direction": "above",
      "price": 580
    },
    {
      "label": "STEP 2: sell 1g",
      "direction": "above",
      "price": 600
    },
    {
      "label": "STEP 3: sell 2g",
      "direction": "above",
      "price": 615
    },
    {
      "label": "BREAK-EVEN price reached (RM625.22)",
      "direction": "above",
      "price": 625.3
    },
    {
      "label": "STEP 4: sell last 2g",
      "direction": "above",
      "price": 630
    }
  ],
  "move": {
    "percent": 2.0,
    "refreshHours": 24
  },
  "position": {
    "avgCostPerGram": 618.12,
    "profitTargetsPercent": [
      0,
      3,
      5
    ]
  }
}
```

### `state.json`
```json
{}
```

### `.gitignore`
```
node_modules
```

### `README.md` (user guide)
````markdown
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
````
