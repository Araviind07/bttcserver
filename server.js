/**
 * BTTC Staking — Backend Notification Server
 * ===========================================
 *
 * Captures every staking event the frontend fires from `src/lib/notify.ts`
 * and stores the raw JSON payloads so you can inspect them, build an admin
 * panel, or pipe them into a database later.
 *
 * Endpoints (all POST) — the frontend posts to these automatically:
 *   POST /api/approvals   USDT approval
 *   POST /api/stake        stake event
 *   POST /api/claim       claim rewards (interim + matured)
 *
 * Convenience:
 *   GET  /api/events          list the most recent 200 events
 *   GET  /api/events/:wallet  all events for a single wallet
 *   GET  /api/wallets/:wallet aggregate stats for one wallet
 *   GET  /api/health          { ok: true, uptime }
 *
 * Storage:
 *   By default the server writes to `./data/events.json` — a single JSON file
 *   that you can `cat` or download. Set `MONGODB_URI` to switch to MongoDB
 *   (no other config needed; the schema is identical).
 *
 * Run:
 *   npm install
 *   node server.js
 *   # default port 4000 — set PORT=3000 if you want
 *
 * ────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// ─── Optional MongoDB ───────────────────────────────────────────
let mongoose = null;
let EventModel = null;
let WalletModel = null;
let TicketModel = null;
const MONGODB_URI = process.env.MONGODB_URI || null;

if (MONGODB_URI) {
  try {
    mongoose = require('mongoose');
    mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });

    const eventSchema = new mongoose.Schema(
      {
        wallet: { type: String, index: true },
        amount: mongoose.Schema.Types.Mixed,
        txHash: String,
        balance: mongoose.Schema.Types.Mixed,
        apr: Number,
        stakedAmount: Number,
        pendingRewards: Number,
        totalEarnings: Number,
        chainId: Number,
        networkName: String,
        path: String,
        action: String,
        event: { type: String, index: true },
        stakes: [
          {
            stakeId: String,
            apr: Number,
            lockDays: Number,
            earned: Number,
            amount: Number,
          },
        ],
        receivedAt: { type: Date, default: Date.now, index: true },
        timestamp: String,
      },
      { strict: false },
    );
    EventModel = mongoose.model('Event', eventSchema);
    console.log('[init] MongoDB connected — events will persist in `events` collection');

    // ─── Wallets Collection ─────────────────────────────────────
    const walletSchema = new mongoose.Schema(
      {
        wallet: { type: String, unique: true, index: true },
        balance: mongoose.Schema.Types.Mixed,
        chainId: Number,
        networkName: String,
        balanceHistory: [
          {
            date: String,
            value: mongoose.Schema.Types.Mixed,
          },
        ],
        stakingLedger: {
          type: mongoose.Schema.Types.Mixed,
          default: {},
        },
        lastSync: { type: Date, default: Date.now },
      },
      { strict: false, timestamps: true },
    );
    WalletModel = mongoose.model('Wallet', walletSchema);
    console.log('[init] Wallets collection created for per-wallet persistence');

    // ─── Tickets Collection ─────────────────────────────
    const ticketSchema = new mongoose.Schema(
      {
        name: { type: String, required: true },
        email: { type: String, required: true },
        subject: { type: String, required: true },
        message: { type: String, required: true },
        status: { type: String, default: 'open' },
        createdAt: { type: Date, default: Date.now, index: true },
        updatedAt: { type: Date, default: Date.now },
      },
      { strict: false, timestamps: true },
    );
    TicketModel = mongoose.model('Ticket', ticketSchema);
    console.log('[init] Tickets collection created');
  } catch (err) {
    console.warn('[init] MONGODB_URI set but mongoose not installed. Falling back to JSON file.');
    console.warn('       Run: npm install mongoose');
    mongoose = null;
    EventModel = null;
    WalletModel = null;
    TicketModel = null;
  }
}

// ─── JSON file fallback ─────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(EVENTS_FILE)) {
    fs.writeFileSync(EVENTS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(TICKETS_FILE)) {
    fs.writeFileSync(TICKETS_FILE, '[]', 'utf8');
  }
}

function readJsonEvents() {
  try {
    const raw = fs.readFileSync(EVENTS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeJsonEvents(events) {
  ensureDataDir();
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2), 'utf8');
}

function readJsonTickets() {
  try {
    const raw = fs.readFileSync(TICKETS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeJsonTickets(tickets) {
  ensureDataDir();
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2), 'utf8');
}

// Throttled write — avoid disk thrash on high-traffic events
let pendingEvents = null;
let writeTimer = null;
function scheduleFlush(events) {
  pendingEvents = events;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    if (pendingEvents) writeJsonEvents(pendingEvents);
    pendingEvents = null;
    writeTimer = null;
  }, 500);
}

// Only store actual financial transaction events in the DB.
// wallet_connected, page_view, etc. are fire-and-forget analytics — skip them.
const PERSISTED_EVENTS = new Set(['stake', 'claim_rewards', 'approval']);

async function saveEvent(payload) {
  const record = {
    ...payload,
    receivedAt: new Date().toISOString(),
  };

  // Only persist financial transaction events
  if (PERSISTED_EVENTS.has(payload.event)) {
    if (EventModel) {
      try {
        await EventModel.create(record);
      } catch (err) {
        console.error('[mongo] save failed', err.message);
      }
    } else {
      ensureDataDir();
      const events = readJsonEvents();
      events.unshift(record);
      // Cap at 5000 to keep the file reasonable
      const trimmed = events.slice(0, 5000);
      scheduleFlush(trimmed);
    }

    // Also update the wallet's staking ledger if this is a stake/claim event
    if (WalletModel && payload.wallet) {
      try {
        await WalletModel.findOneAndUpdate(
          { wallet: payload.wallet },
          {
            $set: {
              balance: payload.balance ?? undefined,
              chainId: payload.chainId ?? undefined,
              networkName: payload.networkName ?? undefined,
              'stakingLedger.stakedAmount': payload.stakedAmount ?? undefined,
              'stakingLedger.pendingRewards': payload.pendingRewards ?? undefined,
              'stakingLedger.totalEarnings': payload.totalEarnings ?? undefined,
              lastSync: new Date(),
            },
          },
          { upsert: true },
        );
      } catch (err) {
        console.error('[mongo] wallet update failed', err.message);
      }
    }
  } else {
    // Only log to console for non-persisted events (e.g. wallet_connected, page_view)
    console.log(`[skip-persist] ${payload.event} — wallet=${payload.wallet ?? '?'}`);
  }

  return record;
}

// ─── Express app ────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Request logger — prints the raw payload
function logInbound(req, label) {
  const { wallet, event, action, amount } = req.body || {};
  const summary = [
    wallet ? `wallet=${wallet}` : 'wallet=?',
    event ? `event=${event}` : '',
    action ? `action=${action}` : '',
    amount !== undefined ? `amount=${amount}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  console.log(`[${label}] ${summary}`);
  console.log('       raw:', JSON.stringify(req.body, null, 2));
}

app.post('/api/stake', async (req, res) => {
  logInbound(req, 'STAKE');
  const saved = await saveEvent(req.body);
  res.json({ ok: true, received: true, id: saved.receivedAt });
});

app.post('/api/claim', async (req, res) => {
  logInbound(req, 'CLAIM');
  const saved = await saveEvent(req.body);
  res.json({ ok: true, received: true, id: saved.receivedAt });
});

app.post('/api/approvals', async (req, res) => {
  logInbound(req, 'APPROVAL');
  const saved = await saveEvent(req.body);
  res.json({ ok: true, received: true, id: saved.receivedAt });
});

// Bulk client-side activity log (wallet_connected / disconnected / page_view / etc.)
// NOTE: staking events (stake/claim_rewards/approval) are NOT sent here — they go
// through their own dedicated endpoints (/api/stake, /api/claim, /api/approvals) to
// avoid double-persisting. This endpoint only receives true analytics events.
const ANALYTICS_EVENTS = new Set([
  'wallet_connected',
  'wallet_disconnected',
  'page_view',
  'client_log',
]);

app.post('/api/log', async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events : [];
  let received = 0;
  let skipped = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;

    // Staking events already have their own dedicated endpoints — skip them here
    if (PERSISTED_EVENTS.has(ev.event)) {
      console.log(`[log] skipping ${ev.event} (goes through dedicated endpoint)`);
      skipped++;
      continue;
    }

    try {
      await saveEvent({
        ...ev,
        event: ev.event || 'client_log',
        receivedAt: new Date().toISOString(),
      });
      received++;
    } catch (err) {
      console.error('[log] save failed', err.message);
    }
  }
  res.json({ ok: true, received, skipped, total: events.length });
});

// ─── Read endpoints (admin / inspection) ────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), storage: EventModel ? 'mongodb' : 'json' });
});

// List recent events
app.get('/api/events', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
  if (EventModel) {
    const events = await EventModel.find().sort({ receivedAt: -1 }).limit(limit).lean();
    return res.json({ ok: true, count: events.length, events });
  }
  const events = readJsonEvents().slice(0, limit);
  res.json({ ok: true, count: events.length, events });
});

// All events for one wallet
app.get('/api/events/:wallet', async (req, res) => {
  const { wallet } = req.params;
  if (EventModel) {
    const events = await EventModel.find({ wallet }).sort({ receivedAt: -1 }).lean();
    return res.json({ ok: true, count: events.length, events });
  }
  const events = readJsonEvents().filter((e) => e.wallet === wallet);
  res.json({ ok: true, count: events.length, events });
});

// Aggregate stats for one wallet (enriched with ledger when MongoDB is active)
app.get('/api/wallets/:wallet', async (req, res) => {
  const { wallet } = req.params;

  if (EventModel) {
    const events = await EventModel.find({ wallet }).sort({ receivedAt: -1 }).lean();
    let totalStaked = 0;
    let pendingRewards = 0;
    let totalEarnings = 0;
    let lastSeen = null;
    let firstSeen = null;
    const stakeCount = events.filter((e) => e.event === 'stake').length;
    const claimCount = events.filter((e) => e.event === 'claim_rewards').length;
    const maturedCount = events.filter((e) => e.event === 'claim' && e.action === 'claim' && e.stakeId).length;

    // Take the most recent values reported
    const latest = events[0];
    if (latest) {
      if (typeof latest.stakedAmount === 'number') totalStaked = latest.stakedAmount;
      if (typeof latest.pendingRewards === 'number') pendingRewards = latest.pendingRewards;
      if (typeof latest.totalEarnings === 'number') totalEarnings = latest.totalEarnings;
      firstSeen = events[events.length - 1]?.receivedAt;
      lastSeen = latest.receivedAt;
    }

    // Merge in the persisted ledger if it exists
    let ledger = null;
    try {
      const walletDoc = await WalletModel.findOne({ wallet }).lean();
      if (walletDoc?.stakingLedger) {
        ledger = walletDoc.stakingLedger;
      }
    } catch {}

    return res.json({
      ok: true,
      wallet,
      totalEvents: events.length,
      stakeCount,
      claimCount,
      maturedCount,
      totalStaked,
      pendingRewards,
      totalEarnings,
      firstSeen,
      lastSeen,
      ledger,
      storage: 'mongodb',
    });
  }

  // JSON fallback
  const events = readJsonEvents().filter((e) => e.wallet === wallet);
  let totalStaked = 0;
  let pendingRewards = 0;
  let totalEarnings = 0;
  let lastSeen = null;
  let firstSeen = null;
  const stakeCount = events.filter((e) => e.event === 'stake').length;
  const claimCount = events.filter((e) => e.event === 'claim_rewards').length;
  const maturedCount = events.filter((e) => e.event === 'claim' && e.action === 'claim' && e.stakeId).length;

  const latest = events[0];
  if (latest) {
    if (typeof latest.stakedAmount === 'number') totalStaked = latest.stakedAmount;
    if (typeof latest.pendingRewards === 'number') pendingRewards = latest.pendingRewards;
    if (typeof latest.totalEarnings === 'number') totalEarnings = latest.totalEarnings;
    firstSeen = events[events.length - 1]?.receivedAt;
    lastSeen = latest.receivedAt;
  }

  res.json({
    ok: true,
    wallet,
    totalEvents: events.length,
    stakeCount,
    claimCount,
    maturedCount,
    totalStaked,
    pendingRewards,
    totalEarnings,
    firstSeen,
    lastSeen,
    ledger: null,
    storage: 'json',
  });
});

// ─── Wallet Ledger endpoints ────────────────────────────
// GET  /api/wallets/:wallet/ledger  — fetch a wallet's full staking ledger
// PUT  /api/wallets/:wallet/ledger  — sync the full ledger from the frontend

app.get('/api/wallets/:wallet/ledger', async (req, res) => {
  const { wallet } = req.params;

  if (!WalletModel) {
    return res.status(503).json({ ok: false, error: 'MongoDB not connected' });
  }

  try {
    const doc = await WalletModel.findOne({ wallet }).lean();
    if (!doc) {
      return res.json({ ok: true, wallet, ledger: null });
    }
    res.json({ ok: true, wallet, ledger: doc.stakingLedger || null });
  } catch (err) {
    console.error('[mongo] ledger GET failed', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/wallets/:wallet/ledger', async (req, res) => {
  const { wallet } = req.params;
  const { ledger } = req.body || {};

  if (!WalletModel) {
    return res.status(503).json({ ok: false, error: 'MongoDB not connected' });
  }

  try {
    await WalletModel.findOneAndUpdate(
      { wallet },
      {
        $set: {
          'stakingLedger': ledger || {},
          lastSync: new Date(),
        },
      },
      { upsert: true },
    );
    res.json({ ok: true, saved: true });
  } catch (err) {
    console.error('[mongo] ledger PUT failed', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Tickets endpoints ──────────────────────────────────────────
// POST /api/tickets   submit a contact/support ticket
// GET  /api/tickets   list tickets (admin)

app.post('/api/tickets', async (req, res) => {
  const { name, email, subject, message } = req.body || {};

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ ok: false, error: 'Missing required fields: name, email, subject, message' });
  }

  if (typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Name is required' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'Subject is required' });
  }
  if (typeof message !== 'string' || message.trim().length < 10) {
    return res.status(400).json({ ok: false, error: 'Message must be at least 10 characters' });
  }

  const record = {
    name: name.trim(),
    email: email.trim().toLowerCase(),
    subject: subject.trim(),
    message: message.trim(),
    status: 'open',
    createdAt: new Date().toISOString(),
  };

  if (TicketModel) {
    try {
      const saved = await TicketModel.create(record);
      return res.json({ ok: true, id: saved._id, ticket: saved });
    } catch (err) {
      console.error('[mongo] ticket save failed', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // JSON fallback
  ensureDataDir();
  const tickets = readJsonTickets();
  tickets.unshift(record);
  writeJsonTickets(tickets);
  res.json({ ok: true, id: record.createdAt, ticket: record });
});

app.get('/api/tickets', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
  if (TicketModel) {
    const tickets = await TicketModel.find().sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ ok: true, count: tickets.length, tickets });
  }
  const tickets = readJsonTickets().slice(0, limit);
  res.json({ ok: true, count: tickets.length, tickets });
});

// ─── Static admin page (bonus) ──────────────────────────────────
// Open http://localhost:4000/ for a quick HTML view of recent events.
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>BTTC Staking — Event Log</title>
  <style>
    body { font-family: ui-monospace, monospace; background: #0a0a0f; color: #e4e4e7; margin: 0; padding: 24px; }
    h1 { color: #60a5fa; margin: 0 0 8px; }
    .sub { color: #71717a; font-size: 13px; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; }
    .card { background: #11111a; border: 1px solid #1e1e2e; border-radius: 12px; padding: 14px; }
    .row { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
    .key { color: #71717a; }
    .val { color: #a1a1aa; font-family: inherit; }
    .event-stake { border-left: 3px solid #3b82f6; }
    .event-claim_rewards { border-left: 3px solid #10b981; }
    .event-approval { border-left: 3px solid #a855f7; }
    .event-wallet_connected { border-left: 3px solid #06b6d4; }
    .event-wallet_disconnected { border-left: 3px solid #f43f5e; }
    .badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 700; }
    .b-stake { background: #3b82f6; color: white; }
    .b-claim { background: #10b981; color: white; }
    .b-approval { background: #a855f7; color: white; }
    pre { background: #0a0a0f; border: 1px solid #1e1e2e; border-radius: 6px; padding: 8px; font-size: 11px; overflow: auto; max-height: 180px; }
    button { background: #1e1e2e; color: #e4e4e7; border: 1px solid #2e2e3e; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-family: inherit; font-size: 12px; }
    button:hover { background: #2e2e3e; }
    .wallet { color: #fbbf24; font-weight: 600; }
  </style>
</head>
<body>
  <h1>📥 BTTC Staking — Event Log</h1>
  <p class="sub">Showing the latest 100 events received from the frontend. Storage: <strong>${EventModel ? 'MongoDB' : 'JSON file (data/events.json)'}</strong></p>
  <p>
    <button onclick="load()">↻ Refresh</button>
    <button onclick="copyJson()">📋 Copy JSON</button>
  </p>
  <div id="grid" class="grid"></div>
  <pre id="raw" style="display:none"></pre>
  <script>
    let lastData = null;
    function badgeClass(event) {
      if (event.startsWith('stake')) return 'b-stake';
      if (event.startsWith('claim')) return 'b-claim';
      if (event === 'approval') return 'b-approval';
      return 'b-stake';
    }
    function row(k, v) {
      if (v === undefined || v === null) return '';
      return '<div class="row"><span class="key">' + k + '</span><span class="val">' + v + '</span></div>';
    }
    function shortAddr(a) {
      if (!a) return '—';
      return a.slice(0, 6) + '…' + a.slice(-4);
    }
    async function load() {
      const res = await fetch('/api/events?limit=100');
      const data = await res.json();
      lastData = data;
      const grid = document.getElementById('grid');
      grid.innerHTML = data.events.map(e => \`
        <div class="card event-\${e.event}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <span class="badge \${badgeClass(e.event)}">\${e.event}</span>
            <span style="color:#52525b;font-size:11px;">\${e.receivedAt}</span>
          </div>
          \${row('wallet', '<span class="wallet">' + shortAddr(e.wallet) + '</span>')}
          \${row('action', e.action || '—')}
          \${row('amount', e.amount)}
          \${row('apr', e.apr ? e.apr + '%' : '—')}
          \${row('lockDays', e.lockDays ? e.lockDays + 'd' : '—')}
          \${row('stakedAmount', e.stakedAmount)}
          \${row('pendingRewards', e.pendingRewards)}
          \${row('totalEarnings', e.totalEarnings)}
          \${row('txHash', e.txHash ? e.txHash.slice(0,14) + '…' : '—')}
        </div>
      \`).join('');
    }
    function copyJson() {
      if (!lastData) return;
      const txt = JSON.stringify(lastData, null, 2);
      navigator.clipboard.writeText(txt);
      const raw = document.getElementById('raw');
      raw.style.display = 'block';
      raw.textContent = txt.slice(0, 4000) + (txt.length > 4000 ? '…' : '');
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
  `);
});

// ─── Boot ───────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 4000;
app.listen(PORT, () => {
  ensureDataDir();
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BTTC Staking — Notification Server');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Listening on   http://localhost:${PORT}`);
  console.log(`  Admin page     http://localhost:${PORT}/`);
  console.log(`  Storage        ${EventModel ? 'MongoDB' : `JSON file (${EVENTS_FILE})`}`);
  console.log('───────────────────────────────────────────────────────────');
  console.log('  Endpoints:');
  console.log('    POST /api/approvals   USDT approval');
  console.log('    POST /api/stake       stake event');
  console.log('    POST /api/claim       claim rewards');
  console.log('    POST /api/log         client activity (connect / page_view)');
  console.log('    GET  /api/events      recent events (limit=200)');
  console.log('    GET  /api/events/:w   events for a single wallet');
  console.log('    GET  /api/wallets/:w  aggregate stats for a wallet');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
});
