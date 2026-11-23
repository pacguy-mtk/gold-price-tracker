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
