# BTTC Staking — Backend Server

Captures staking events (USDT approval, stake, claim) from the frontend and stores the raw JSON payloads.

## Quick start (local)

```bash
cd server
npm install
node server.js
```

The server starts on `http://localhost:4000` and writes to `data/events.json`.

In your frontend, set the env var so it points at this server:

```bash
# .env.local
NEXT_PUBLIC_NOTIFY_BASE=http://localhost:4000/api
```

For production, deploy this to Render / Railway / Fly.io / your VPS and use that URL.

---

## Endpoints (all POST — the frontend posts to these automatically)

| Endpoint | When it fires |
|---|---|
| `/api/approvals` | USDT approve transaction |
| `/api/stake` | Stake event |
| `/api/claim` | Claim rewards (interim or matured) |

## Convenience GETs (admin / inspection)

| Endpoint | Returns |
|---|---|
| `GET /` | HTML page with the latest 100 events |
| `GET /api/events?limit=200` | Recent events (max 5000) |
| `GET /api/events/:wallet` | All events for a single wallet |
| `GET /api/wallets/:wallet` | Aggregate stats for a wallet |
| `GET /api/health` | `{ ok: true, uptime, storage }` |

## Storage

By default, events are written to a single JSON file: `data/events.json` (capped at 5000 records). To switch to MongoDB, set the env var:

```bash
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/bttc
npm install mongoose
node server.js
```

No other config needed — the schema is detected automatically.

## What you'll see in the JSON

**Stake event:**
```json
{
  "wallet": "0x1234567890abcdef1234567890abcdef12345678",
  "amount": 1000,
  "txHash": "0xabc...123",
  "action": "stake",
  "event": "stake",
  "apr": 60,
  "stakedAmount": 1000,
  "pendingRewards": 0,
  "totalEarnings": 0,
  "stakes": [
    { "stakeId": "SK00000001", "apr": 60, "lockDays": 30, "earned": 0, "amount": 1000 }
  ],
  "timestamp": "2026-09-01T12:34:56.789Z"
}
```

**Claim event:**
```json
{
  "wallet": "0x1234...",
  "amount": 0.4521,
  "action": "claim",
  "event": "claim_rewards",
  "stakedAmount": 1000,
  "pendingRewards": 0,
  "totalEarnings": 50.4521,
  "stakes": [
    { "stakeId": "SK00000001", "apr": 60, "lockDays": 30, "earned": 0.4521, "amount": 1000 }
  ],
  "timestamp": "..."
}
```

**Approval event:**
```json
{
  "wallet": "0x1234...",
  "amount": 0,
  "txHash": "0xabc...456",
  "action": "approve",
  "event": "approval",
  "timestamp": "..."
}
```

## Deploy to Render.com

1. Push this `server/` folder to a Git repo.
2. On Render, create a **Web Service** with:
   - Build command: `npm install`
   - Start command: `node server.js`
3. Add env var `MONGODB_URI` if you want a database.
4. Use the resulting URL (e.g. `https://serverbttc.onrender.com/api`) as `NEXT_PUBLIC_NOTIFY_BASE` in the frontend.

## Wallet Ledger (per-wallet persistence)

| Endpoint | Method | Description |
|---|---|---|
| `/api/wallets/:wallet/ledger` | GET | Fetch a wallet's full staking ledger from MongoDB |
| `/api/wallets/:wallet/ledger` | PUT | Sync (replace) a wallet's full staking ledger from the frontend |

**Ledger shape** (mirrors the frontend Zustand store):
```json
{
  "stakes": [
    {
      "id": "SK00000001",
      "amount": 1000,
      "lockDays": 30,
      "apr": 60,
      "stakedAt": 1699999999999,
      "maturesAt": 1702688399999,
      "completed": false,
      "completedAt": null,
      "earned": 4.5
    }
  ],
  "totalEarnings": 150.0,
  "transactionHistory": [
    { "id": "TX00000001", "type": "stake", "amount": 1000, "timestamp": "...", "status": "completed", "stakeId": "SK00000001", "lockDays": 30, "apr": 60 }
  ]
}
```
