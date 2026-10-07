# Nexus Sol Bot

A Solana sniper terminal: token discovery, rug-risk checks, manual trading, auto-sniper, limit orders,
DCA, multi-level take-profit, stop-loss, trailing stop, liquidity guard, multi-wallet, copy trading,
paid plans with a free trial, referrals and an admin console.

- **Backend:** Python, FastAPI, SQLAlchemy (`backend/`)
- **Frontend:** React (JSX), Vite (`frontend/`)
- **Treasury wallet:** `469rxFHREhqpKcDBugswHFzvuCpuqzWhcSyWfvY8TrL3` receives plan payments and trading fees.

## How money moves

| What | How |
|---|---|
| User trading funds | Each user gets a dedicated Solana wallet at sign-up. They deposit SOL to it, can withdraw to any address, and can export the private key at any time. The key is stored encrypted (Fernet). |
| Plan payments | Paid in SOL to the treasury wallet. The backend creates an invoice with a unique exact amount, then verifies the transaction on-chain before activating the plan. Users pay in one click from their trading wallet, or from any other wallet by pasting the transaction signature. |
| Trading fees | A percentage of every buy and sell is sent from the user's trading wallet to the treasury right after the swap. |
| Referrals | 20% of a referred user's trading fees goes to the referrer's wallet in the same fee transaction. Three referrals who each trade unlock a free Hunter month. |
| Card payments | Not handled on-site. The Wallet page links to MoonPay and Transak so users can buy SOL with a card and send it to their deposit address. |

## Plans (30 days each)

| Plan | Price | Fee | Buys / day | Positions | Wallets | Active orders | Auto-sniper | Exit rules | Trailing | Copy wallets |
|---|---|---|---|---|---|---|---|---|---|---|
| Scout | Free | 1.00% | 5 | 3 | 1 | 0 | no | no | no | 0 |
| Hunter | $100 | 0.75% | unlimited | 15 | 3 | 10 | yes | yes | no | 2 |
| Apex | $500 | 0.50% | unlimited | 50 | 10 | 50 | yes | yes | yes | 10 |
| Leviathan | $1000 | 0.25% | unlimited | 200 | 50 | 200 | yes | yes | yes | 30 |

"Exit rules" are take-profit levels, stop-loss and the liquidity guard. Every account can try Hunter free
once for 3 days (`TRIAL_DAYS`, `TRIAL_PLAN` in `plans.py`); no payment is taken and nothing renews.

Edit `app/plans.py` to change prices, limits or names. The first 500 accounts trade with
0% fees for 7 days (`LAUNCH_PROMO_USERS`, `LAUNCH_PROMO_DAYS`).

## Version 1.1 features

- **Limit orders:** buy when the price falls to a target. A ladder places up to 10 orders, each a set
  percentage below the last. Orders can expire.
- **DCA:** a fixed number of buys at a fixed interval, with an optional price ceiling.
- **Take-profit levels:** up to five steps, each selling a percentage of what is left.
- **Liquidity guard:** sells the whole position if pool liquidity falls by a set percentage from entry.
  It is checked every engine cycle (seconds), so it cannot beat a pull that happens in one block.
- **Multi-wallet:** several trading wallets per account, each with its own balance, address and key.
  The sniper, each copy target and each order can be pointed at a specific wallet.
- **Free trial** and new landing sections (venues, security, plan comparison, FAQ).

### Upgrading an existing database

Nothing manual is needed. On start-up `app/migrate.py` adds the new columns and the `orders` table and
removes the old one-wallet-per-user rule. Existing users, wallets, keys, positions and trades are kept.
This was tested by creating data with the 1.0 code and starting 1.1 against it, on SQLite and PostgreSQL 16.
Take a Supabase backup before the first 1.1 deploy anyway.

## Run locally

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # set ADMIN_EMAIL to your email
uvicorn app.main:app --reload --port 8000

# frontend (second terminal)
cd frontend
npm install
cp .env.example .env
npm run dev                                            # http://localhost:5173
```

Register with the `ADMIN_EMAIL` address to get the Admin page. Run the tests with `cd backend && pytest`.

## Paper mode and live mode

`PAPER_TRADING=true` (the default) simulates every fill against live market prices with a 10 SOL
practice balance. No funds move, so it is safe to test the whole product. Plan payments are real in
both modes.

`PAPER_TRADING=false` sends real swaps through Jupiter. The server refuses to start in live mode
unless `JWT_SECRET` (32+ characters), `WALLET_ENCRYPTION_KEY` and `JUPITER_API_KEY` are set.

**Before going live**
1. Get a Jupiter API key at https://developers.jup.ag/portal and a paid RPC URL (Helius, QuickNode).
2. Back up `WALLET_ENCRYPTION_KEY` offline. If it is lost, users' wallets cannot be recovered. If it
   leaks together with the database, every user wallet can be drained.
3. Do one real buy and one real sell of about 0.01 SOL yourself and confirm on Solscan that the swap
   and the fee transfer to the treasury both landed. Live swap execution could not be exercised from
   the build environment, so this first-hand check is required.
4. Make sure the treasury wallet already holds some SOL (an empty account rejects very small transfers).
5. Check the legal position for running a custodial trading service in the countries you serve.

## Deploy

**Database (Supabase):** create a project and copy the Postgres connection string into `DATABASE_URL`.
Tables are created automatically on first start.

**Backend (Railway):** new project from the backend repo (leave the root directory empty when the
backend is its own repository). Railway uses the `Dockerfile`. Add every variable from `.env.example`. Set `CORS_ORIGINS` and `FRONTEND_URL` to your
Netlify URL. Keep it at one instance and one worker: the trading engine runs inside the web process,
and two copies would place duplicate trades.

**Frontend (Netlify):** base directory empty when the frontend is its own repository, build command `npm run build`, publish directory
`dist`, environment variable `VITE_API_URL` = your Railway URL.

## Project layout

```
backend/app/
  main.py            app, CORS, engine start-up
  config.py          settings from environment
  models.py          users, wallets, payments, positions, trades, sniper configs, copy targets
  plans.py           plan prices, limits and fees
  security.py        passwords, JWT, wallet-key encryption
  migrate.py         start-up schema upgrades
  routers/           auth, wallet, market, trade, orders, automation (sniper + copy), billing, community (referrals, leaderboard, stats, admin)
  services/
    solana.py        RPC client, keypairs, SOL transfers
    jupiter.py       Jupiter Swap V2 (/order + /execute)
    market.py        token feed and prices (DexScreener)
    safety.py        rug-risk score
    trading.py       buy / sell, fees, position accounting
    engine.py        auto-sniper, limit/DCA orders, exit monitor, copy trading loop
frontend/src/
  pages/             Landing, Auth, Dashboard, Discover, Sniper, Positions, Orders, Copy, Wallet, Plans, Referrals, Leaderboard, Admin
  components/        Layout, TradeModal, ShareCard, ui
  lib.jsx            API client, auth, toasts, formatting
  styles.css         design system
```

## Known limits

- The token feed polls DexScreener, so a new pool appears some seconds after it is created. Tokens
  must be routable on Jupiter to be bought. For block-zero sniping, add a Helius websocket listener
  for Raydium and Pump.fun pool creation in `services/engine.py`.
- Copy trading polls each followed wallet every engine cycle; it mirrors simple SOL-to-token swaps.
- The safety score reduces risk. It cannot detect every rug pull.
