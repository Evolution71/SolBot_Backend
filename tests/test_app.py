import asyncio

import pytest
from sqlalchemy import select

from app.config import Settings, settings
from app.database import SessionLocal
from app.models import Position, SniperConfig, User
from app.services import engine, solana
from tests.conftest import MINT, signup


def test_register_login_and_wallet(client):
    headers, user = signup(client)
    assert user["plan"] == "free" and solana.is_valid_address(user["wallet"])
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/login", json={"email": "alice@test.io", "password": "nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "alice@test.io", "password": "password123"}).status_code == 200
    wallet = client.get("/api/wallet", headers=headers).json()
    assert wallet["sol"] == 10 and wallet["address"] == user["wallet"] and len(wallet["wallets"]) == 1
    assert client.post("/api/auth/register", json={"email": "alice@test.io", "username": "x12", "password": "password123"}).status_code == 400


def test_key_export_roundtrip_requires_password(client):
    headers, user = signup(client)
    wid = client.get("/api/wallet", headers=headers).json()["wallets"][0]["id"]
    assert client.post(f"/api/wallet/{wid}/export", json={"password": "wrong"}, headers=headers).status_code == 403
    secret = client.post(f"/api/wallet/{wid}/export", json={"password": "password123"}, headers=headers).json()["secret_key"]
    from solders.keypair import Keypair
    assert str(Keypair.from_base58_string(secret).pubkey()) == user["wallet"]
    with SessionLocal() as db:
        assert secret not in db.scalar(select(User)).wallet.enc_secret  # stored encrypted, not in the clear


def test_paper_buy_sell_accounting(client, state):
    headers, _ = signup(client)
    buy = client.post("/api/trade/buy", json={"mint": MINT, "sol": 1}, headers=headers)
    assert buy.status_code == 200, buy.text
    assert buy.json()["fee_sol"] == pytest.approx(0.01)            # 1% on the free plan
    assert client.get("/api/wallet", headers=headers).json()["sol"] == pytest.approx(8.99)
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    assert pos["cost_sol"] == pytest.approx(1.01) and pos["tokens"] == pytest.approx(990_000)

    state["price"] = 0.000002                                       # token doubles
    half = client.post("/api/trade/sell", json={"position_id": pos["id"], "pct": 50}, headers=headers).json()
    # 495k tokens * 2e-6 * 0.99 = 0.9801 SOL, fee 1% -> pnl = 0.9801*0.99 - 0.505
    assert half["sol"] == pytest.approx(0.9801) and half["pnl_sol"] == pytest.approx(0.9801 * 0.99 - 0.505)
    rest = client.post("/api/trade/sell", json={"position_id": pos["id"], "pct": 100}, headers=headers).json()
    assert rest["pnl_sol"] == pytest.approx(half["pnl_sol"])
    assert client.get("/api/trade/positions", headers=headers).json()["positions"] == []
    assert client.post("/api/trade/sell", json={"position_id": pos["id"]}, headers=headers).status_code == 400
    stats = client.get("/api/trade/stats", headers=headers).json()
    assert stats["win_rate"] == 100 and stats["realized_pnl_sol"] == pytest.approx(2 * half["pnl_sol"])
    assert client.get("/api/wallet", headers=headers).json()["sol"] == pytest.approx(10 + 2 * half["pnl_sol"])
    assert client.get("/api/leaderboard").json()["rows"][0]["username"] == "alice"


def test_free_plan_limits(client):
    headers, _ = signup(client)
    other = "So11111111111111111111111111111111111111112"
    assert client.post("/api/trade/buy", json={"mint": other, "sol": 1}, headers=headers).status_code == 400
    assert client.post("/api/trade/buy", json={"mint": MINT, "sol": 100}, headers=headers).status_code == 400  # balance
    for _ in range(5):
        assert client.post("/api/trade/buy", json={"mint": MINT, "sol": 0.1, "tp_pct": 50}, headers=headers).status_code == 200
    sixth = client.post("/api/trade/buy", json={"mint": MINT, "sol": 0.1}, headers=headers)
    assert sixth.status_code == 400 and "Daily limit" in sixth.json()["detail"]
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    assert pos["tp_pct"] is None                                    # TP/SL is a paid feature
    cfg = client.get("/api/sniper/config", headers=headers).json()
    assert client.put("/api/sniper/config", json={**cfg, "enabled": True}, headers=headers).status_code == 403
    assert client.post("/api/copy/targets", json={"address": MINT}, headers=headers).status_code == 403
    assert client.get("/api/admin/overview", headers=headers).status_code == 403


def test_plan_payment_verified_on_chain(client, monkeypatch):
    headers, _ = signup(client)
    mallory, _ = signup(client, "mallory")
    inv = client.post("/api/billing/invoice", json={"plan": "pro"}, headers=headers).json()
    assert inv["sol"] == pytest.approx(0.5, abs=0.001) and inv["treasury"] == settings.treasury_wallet
    other = client.post("/api/billing/invoice", json={"plan": "pro"}, headers=mallory).json()
    assert other["lamports"] != inv["lamports"]

    def tx(amount, to=settings.treasury_wallet, err=None):
        return {"blockTime": None, "meta": {"err": err, "preBalances": [10**10, 5], "postBalances": [10**10 - amount, 5 + amount]},
                "transaction": {"message": {"accountKeys": [{"pubkey": MINT}, {"pubkey": to}]}}}

    chain = {"short": tx(inv["lamports"] - 1), "wrongdest": tx(inv["lamports"], to=MINT),
             "failed": tx(inv["lamports"], err={"x": 1}), "good": tx(inv["lamports"])}

    async def get_transaction(sig):
        return chain.get(sig)

    monkeypatch.setattr(solana, "get_transaction", get_transaction)
    url = f"/api/billing/invoice/{inv['id']}/verify"
    assert client.post(url, json={"signature": "missing"}, headers=headers).status_code == 404
    for bad in ("short", "wrongdest", "failed"):
        assert client.post(url, json={"signature": bad}, headers=headers).status_code == 400
    # someone else's payment cannot settle a different invoice
    assert client.post(f"/api/billing/invoice/{other['id']}/verify", json={"signature": "good"}, headers=mallory).status_code == 400
    assert client.post(f"/api/billing/invoice/{inv['id']}/verify", json={"signature": "good"}, headers=mallory).status_code == 404
    assert client.get("/api/auth/me", headers=headers).json()["plan"] == "free"
    assert client.post(url, json={"signature": "good"}, headers=headers).json()["status"] == "confirmed"
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["plan"] == "pro" and me["fee_bps"] == 75 and me["limits"]["auto_snipe"]
    assert client.post(url, json={"signature": "good"}, headers=headers).status_code == 400  # no replay


def test_referrals_pay_share_and_unlock_plan(client):
    ref_headers, ref = signup(client, "referrer")
    for name in ("ref1", "ref2", "ref3"):
        headers, _ = signup(client, name, ref=ref["referral_code"])
        assert client.get("/api/auth/me", headers=ref_headers).json()["plan"] == "free"
        client.post("/api/trade/buy", json={"mint": MINT, "sol": 1}, headers=headers)
    info = client.get("/api/referral", headers=ref_headers).json()
    assert info["active"] == 3 and info["reward_granted"] and info["earned_sol"] == pytest.approx(3 * 0.01 * 0.2)
    assert client.get("/api/auth/me", headers=ref_headers).json()["plan"] == "pro"
    assert client.get("/api/wallet", headers=ref_headers).json()["sol"] == pytest.approx(10.006)


def test_engine_snipes_then_takes_profit(client, state):
    admin, _ = signup(client, "boss", email="admin@test.io")
    headers, user = signup(client)
    assert client.get("/api/admin/overview", headers=admin).json()["users"] == 2
    assert client.post(f"/api/admin/users/{user['id']}/plan", json={"plan": "elite"}, headers=admin).status_code == 200
    cfg = client.get("/api/sniper/config", headers=headers).json()
    cfg.update(enabled=True, buy_sol=0.5, tp_pct=50, sl_pct=20, max_top10_pct=5)
    assert client.put("/api/sniper/config", json=cfg, headers=headers).status_code == 200

    asyncio.run(engine.tick())                                      # top-10 holds 10% > 5% -> skipped
    assert client.get("/api/trade/positions", headers=headers).json()["positions"] == []
    assert "Skipped" in client.get("/api/sniper/activity", headers=headers).json()["events"][0]["text"]

    engine._attempted.clear()
    cfg["max_top10_pct"] = 60
    client.put("/api/sniper/config", json=cfg, headers=headers)
    asyncio.run(engine.tick())
    asyncio.run(engine.tick())                                      # never buys the same token twice
    positions = client.get("/api/trade/positions", headers=headers).json()["positions"]
    assert len(positions) == 1 and positions[0]["source"] == "sniper" and positions[0]["tp_pct"] == 50

    state["price"] = 0.0000016                                      # +60% -> take-profit
    asyncio.run(engine.tick())
    trades = client.get("/api/trade/history", headers=headers).json()["trades"]
    assert trades[0]["side"] == "sell" and trades[0]["reason"] == "take-profit" and trades[0]["pnl_sol"] > 0
    with SessionLocal() as db:
        assert db.scalar(select(Position)).status == "closed"
        assert db.scalar(select(SniperConfig).where(SniperConfig.user_id == user["id"])).enabled


def test_copy_trade_swap_parsing():
    w = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    def tx(sol_pre, sol_post, tok_pre, tok_post):
        bal = lambda v: [{"owner": w, "mint": MINT, "uiTokenAmount": {"uiAmountString": str(v)}}] if v else []
        return {"meta": {"err": None, "preBalances": [sol_pre], "postBalances": [sol_post],
                         "preTokenBalances": bal(tok_pre), "postTokenBalances": bal(tok_post)},
                "transaction": {"message": {"accountKeys": [{"pubkey": w}]}}}
    assert engine.parse_swap(tx(5 * 10**9, 4 * 10**9, 0, 1000), w) == {"side": "buy", "mint": MINT}
    assert engine.parse_swap(tx(4 * 10**9, 5 * 10**9, 1000, 0), w) == {"side": "sell", "mint": MINT}
    assert engine.parse_swap(tx(5 * 10**9, 5 * 10**9 - 5000, 0, 0), w) is None  # plain transfer / fee only


def test_live_mode_refuses_dev_secrets():
    with pytest.raises(RuntimeError):
        Settings(paper_trading=False, jwt_secret="dev-only-secret-change-me-before-going-live", wallet_encryption_key="").assert_production_ready()


def test_live_buy_and_sell_flow(client, state, monkeypatch):
    """Live mode with the network mocked: swap, fee to treasury, referral share, on-chain sell amount."""
    from app.services import jupiter
    ref_headers, ref = signup(client, "referrer")
    headers, _ = signup(client, ref=ref["referral_code"])
    monkeypatch.setattr(settings, "paper_trading", False)
    state["chain_balance"] = 5 * 10**9
    sent, swaps = [], []

    async def execute_swap(kp, inp, out, amount, slippage, priority=0):
        swaps.append((inp, out, amount))
        return f"sig{len(swaps)}", (2_000_000_000 if inp == solana.SOL_MINT else 3 * 10**9)

    async def transfer_sol(kp, transfers):
        sent.append(transfers)
        return "feesig"

    async def token_balance(owner, mint):
        return 1_900_000_000  # less than recorded, e.g. a transfer-tax token

    monkeypatch.setattr(jupiter, "execute_swap", execute_swap)
    monkeypatch.setattr(solana, "transfer_sol", transfer_sol)
    monkeypatch.setattr(solana, "token_balance", token_balance)

    buy = client.post("/api/trade/buy", json={"mint": MINT, "sol": 1}, headers=headers).json()
    assert buy["signature"] == "sig1" and not buy["paper"]
    referrer_wallet = client.get("/api/auth/me", headers=ref_headers).json()["wallet"]
    assert sent[0] == [(settings.treasury_wallet, 8_000_000), (referrer_wallet, 2_000_000)]  # 1% fee, 20% to referrer
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    sell = client.post("/api/trade/sell", json={"position_id": pos["id"], "pct": 100}, headers=headers).json()
    assert swaps[1] == (MINT, solana.SOL_MINT, 1_900_000_000)       # sells what is really in the wallet
    assert sell["pnl_sol"] == pytest.approx(3 - 0.03 - 1.01)
    assert sum(t[0][1] + t[1][1] for t in sent) == 10_000_000 + 30_000_000

    state["chain_balance"] = 1000
    low = client.post("/api/trade/buy", json={"mint": MINT, "sol": 1}, headers=headers)
    assert low.status_code == 400 and "Insufficient SOL" in low.json()["detail"]


def test_partial_signing_matches_full_signing():
    import base64
    from solders.hash import Hash
    from solders.keypair import Keypair
    from solders.message import MessageV0
    from solders.signature import Signature
    from solders.system_program import TransferParams, transfer
    from solders.transaction import VersionedTransaction
    from app.services import jupiter
    kp = Keypair()
    msg = MessageV0.try_compile(kp.pubkey(), [transfer(TransferParams(
        from_pubkey=kp.pubkey(), to_pubkey=Keypair().pubkey(), lamports=5))], [], Hash.default())
    unsigned = base64.b64encode(bytes(VersionedTransaction.populate(msg, [Signature.default()]))).decode()
    assert base64.b64decode(jupiter.sign_order(kp, unsigned)) == bytes(VersionedTransaction(msg, [kp]))
    with pytest.raises(jupiter.SwapError):
        jupiter.sign_order(Keypair(), unsigned)


# ---------------------------------------------------------------- version 1.1 features

def _paid(client, name="trader", plan="elite"):
    """A user on a paid plan (set by the admin account)."""
    admin, _ = signup(client, "boss", email="admin@test.io")
    headers, user = signup(client, name)
    assert client.post(f"/api/admin/users/{user['id']}/plan", json={"plan": plan}, headers=admin).status_code == 200
    return headers, user


def test_free_trial_once_and_unlocks_features(client):
    headers, user = signup(client)
    assert user["trial_available"] and client.post("/api/orders", json={
        "kind": "limit", "mint": MINT, "sol_per_order": 0.1, "trigger_price_usd": 0.0001}, headers=headers).status_code == 403
    trial = client.post("/api/billing/trial", headers=headers)
    assert trial.status_code == 200 and trial.json()["plan"] == "pro"
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["plan"] == "pro" and me["limits"]["orders"] == 10 and not me["trial_available"]
    assert client.post("/api/billing/trial", headers=headers).status_code == 400
    with SessionLocal() as db:                                        # trial lapses back to free on its own
        u = db.scalar(select(User)); u.plan_expires_at = u.plan_expires_at.replace(year=2000); db.commit()
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["plan"] == "free" and not me["trial_available"]


def test_multi_wallet_isolated_balances_and_limits(client):
    headers, _ = _paid(client, plan="pro")
    assert client.post("/api/wallet", json={"label": "Degen"}, headers=headers).status_code == 200
    assert client.post("/api/wallet", json={"label": "Safe"}, headers=headers).status_code == 200
    assert client.post("/api/wallet", json={"label": "Fourth"}, headers=headers).status_code == 403   # Hunter = 3
    data = client.get("/api/wallet", headers=headers).json()
    main, degen, _safe = data["wallets"]
    assert data["sol"] == 30 and main["is_default"] and not degen["is_default"] and len({w["address"] for w in data["wallets"]}) == 3

    client.post("/api/trade/buy", json={"mint": MINT, "sol": 2, "wallet_id": degen["id"]}, headers=headers)
    client.post("/api/trade/buy", json={"mint": MINT, "sol": 1}, headers=headers)                     # default wallet
    by_label = {w["label"]: w["sol"] for w in client.get("/api/wallet", headers=headers).json()["wallets"]}
    assert by_label["Degen"] == pytest.approx(10 - 2 * 1.0075) and by_label["Main"] == pytest.approx(10 - 1.0075)
    positions = client.get("/api/trade/positions", headers=headers).json()["positions"]
    assert sorted(p["wallet"] for p in positions) == ["Degen", "Main"]                                 # one position per wallet
    degen_pos = next(p for p in positions if p["wallet"] == "Degen")
    client.post("/api/trade/sell", json={"position_id": degen_pos["id"]}, headers=headers)
    by_label = {w["label"]: w["sol"] for w in client.get("/api/wallet", headers=headers).json()["wallets"]}
    assert by_label["Degen"] > 10 - 2 * 1.0075 and by_label["Main"] == pytest.approx(10 - 1.0075)      # proceeds return to Degen

    other, _ = signup(client, "mallory")                                                               # cannot touch someone else's wallet
    assert client.post(f"/api/wallet/{degen['id']}/export", json={"password": "password123"}, headers=other).status_code == 404
    assert client.patch(f"/api/wallet/{degen['id']}", json={"is_default": True}, headers=headers).status_code == 200
    assert client.get("/api/auth/me", headers=headers).json()["wallet"] == degen["address"]


def test_multi_level_take_profit_and_stop(client, state):
    headers, _ = _paid(client)
    body = {"mint": MINT, "sol": 1, "sl_pct": 30,
            "tp_levels": [{"pct": 100, "sell": 50}, {"pct": 50, "sell": 50}]}                          # stored lowest first
    assert client.post("/api/trade/buy", json=body, headers=headers).status_code == 200
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    assert [l["pct"] for l in pos["tp_levels"]] == [50, 100] and pos["tokens"] == pytest.approx(990_000)

    state["price"] = 0.0000016                                                                         # +58%: level 1 only
    asyncio.run(engine.tick()); asyncio.run(engine.tick())                                             # a hit level never fires twice
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    assert pos["tokens"] == pytest.approx(495_000) and [l["hit"] for l in pos["tp_levels"]] == [True, False]
    state["price"] = 0.0000022                                                                         # +118%: level 2
    asyncio.run(engine.tick())
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"][0]
    assert pos["tokens"] == pytest.approx(247_500)
    state["price"] = 0.0000006                                                                         # -40%: stop-loss closes the rest
    asyncio.run(engine.tick())
    assert client.get("/api/trade/positions", headers=headers).json()["positions"] == []
    reasons = [t["reason"] for t in client.get("/api/trade/history", headers=headers).json()["trades"] if t["side"] == "sell"]
    assert reasons == ["stop-loss", "take-profit-2", "take-profit-1"]
    bad = client.post("/api/trade/buy", json={"mint": MINT, "sol": 1, "tp_levels": [{"pct": 50, "sell": 150}]}, headers=headers)
    assert bad.status_code == 422


def test_rug_guard_sells_when_liquidity_is_pulled(client, state, monkeypatch):
    from app.services import market
    from tests.conftest import TOKEN
    headers, _ = _paid(client)
    client.post("/api/trade/buy", json={"mint": MINT, "sol": 1, "rug_exit_pct": 40}, headers=headers)  # entry liquidity $50k
    liquidity = {"usd": 35_000}

    async def get_tokens(mints, ttl=4):
        return {m: {**TOKEN, "mint": m, "price_sol": state["price"], "liquidity_usd": liquidity["usd"]} for m in mints}

    monkeypatch.setattr(market, "get_tokens", get_tokens)
    asyncio.run(engine.tick())                                                                         # -30%: holds
    assert len(client.get("/api/trade/positions", headers=headers).json()["positions"]) == 1
    liquidity["usd"] = 29_000                                                                          # -42%: exit
    asyncio.run(engine.tick())
    assert client.get("/api/trade/positions", headers=headers).json()["positions"] == []
    assert client.get("/api/trade/history", headers=headers).json()["trades"][0]["reason"] == "rug-guard"


def test_limit_order_ladder_fills_only_at_target(client, state):
    headers, _ = _paid(client)
    usd = lambda: state["price"] * 200                                                                 # test token: 1 SOL = $200
    made = client.post("/api/orders", json={
        "kind": "limit", "mint": MINT, "sol_per_order": 0.5, "trigger_price_usd": 0.00016,
        "ladder_levels": 2, "ladder_step_pct": 25, "tp_pct": 50}, headers=headers)
    assert made.status_code == 200 and [round(o["trigger_price_usd"], 6) for o in made.json()["orders"]] == [0.00016, 0.00012]

    async def get_tokens(mints, ttl=4):
        from tests.conftest import TOKEN
        return {m: {**TOKEN, "mint": m, "price_sol": state["price"], "price_usd": usd()} for m in mints}
    from app.services import market
    market.get_tokens = get_tokens                                                                     # (monkeypatched module, restored by fixture)

    asyncio.run(engine.tick())                                                                         # $0.0002: above both
    assert client.get("/api/trade/positions", headers=headers).json()["positions"] == []
    state["price"] = 0.00000075                                                                        # $0.00015: first level only
    asyncio.run(engine.tick()); asyncio.run(engine.tick())
    orders = client.get("/api/orders", headers=headers).json()["orders"]
    assert sorted(o["status"] for o in orders) == ["active", "filled"]
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"]
    assert len(pos) == 1 and pos[0]["source"] == "limit" and pos[0]["tp_pct"] == 50 and pos[0]["cost_sol"] == pytest.approx(0.5 * 1.005)
    remaining = next(o for o in orders if o["status"] == "active")
    assert client.delete(f"/api/orders/{remaining['id']}", headers=headers).status_code == 200
    state["price"] = 0.0000001
    asyncio.run(engine.tick())                                                                         # cancelled order never fills
    assert client.get("/api/trade/positions", headers=headers).json()["positions"][0]["cost_sol"] == pytest.approx(0.5 * 1.005)


def test_dca_buys_on_schedule_then_completes(client):
    from app.models import Order
    headers, _ = _paid(client)
    made = client.post("/api/orders", json={"kind": "dca", "mint": MINT, "sol_per_order": 0.2,
                                            "total_orders": 3, "interval_minutes": 60}, headers=headers)
    assert made.status_code == 200
    asyncio.run(engine.tick()); asyncio.run(engine.tick())                                             # first buy now, second must wait
    order = client.get("/api/orders", headers=headers).json()["orders"][0]
    assert order["filled_orders"] == 1 and order["status"] == "active"
    for expected in (2, 3):
        with SessionLocal() as db:
            o = db.scalar(select(Order)); o.next_run_at = o.next_run_at.replace(year=2000); db.commit()
        asyncio.run(engine.tick())
        assert client.get("/api/orders", headers=headers).json()["orders"][0]["filled_orders"] == expected
    order = client.get("/api/orders", headers=headers).json()["orders"][0]
    assert order["status"] == "filled" and order["spent_sol"] == pytest.approx(3 * 0.2 * 1.005)
    pos = client.get("/api/trade/positions", headers=headers).json()["positions"]
    assert len(pos) == 1 and pos[0]["cost_sol"] == pytest.approx(3 * 0.2 * 1.005)                      # averaged into one position


def test_failed_order_stops_after_three_attempts(client):
    headers, _ = _paid(client)
    client.post("/api/orders", json={"kind": "limit", "mint": MINT, "sol_per_order": 500, "trigger_price_usd": 1}, headers=headers)
    for _ in range(4):
        asyncio.run(engine.tick())
    order = client.get("/api/orders", headers=headers).json()["orders"][0]
    assert order["status"] == "failed" and "Insufficient" in order["last_error"]


def test_upgrade_keeps_data_from_version_1_database(tmp_path):
    """A v1 database (one wallet per user, no new columns) is brought forward without losing anything."""
    from sqlalchemy import create_engine, inspect, text
    from app.migrate import upgrade
    eng = create_engine(f"sqlite:///{tmp_path / 'v1.db'}")
    with eng.begin() as c:
        c.execute(text("CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(255), username VARCHAR(32), password_hash VARCHAR(255),"
                       " is_admin BOOLEAN, is_active BOOLEAN, plan VARCHAR(16), plan_expires_at DATETIME, fee_free_until DATETIME,"
                       " referral_code VARCHAR(16), referred_by_id INTEGER, referral_reward_granted BOOLEAN, created_at DATETIME)"))
        c.execute(text("CREATE TABLE wallets (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, pubkey VARCHAR(64), enc_secret TEXT,"
                       " paper_lamports BIGINT, UNIQUE (user_id), UNIQUE (pubkey))"))
        c.execute(text("CREATE TABLE positions (id INTEGER PRIMARY KEY, user_id INTEGER, mint VARCHAR(64), status VARCHAR(8))"))
        c.execute(text("INSERT INTO users (id, email, username, plan, is_active) VALUES (1, 'a@b.c', 'old', 'free', 1)"))
        c.execute(text("INSERT INTO wallets (id, user_id, pubkey, enc_secret, paper_lamports) VALUES (7, 1, 'PUB', 'SECRET', 5)"))
        c.execute(text("INSERT INTO positions (id, user_id, mint, status) VALUES (1, 1, 'M', 'open')"))
    upgrade(eng); upgrade(eng)                                                                          # safe to run on every start
    with eng.begin() as c:
        assert c.execute(text("SELECT id, user_id, pubkey, enc_secret, paper_lamports, label, is_default FROM wallets")).all() == \
            [(7, 1, "PUB", "SECRET", 5, "Main", 1)]
        c.execute(text("INSERT INTO wallets (user_id, pubkey, enc_secret, paper_lamports, label, is_default) VALUES (1, 'PUB2', 'S2', 0, 'Second', 0)"))
        assert c.execute(text("SELECT trial_used FROM users")).scalar() == 0
        assert c.execute(text("SELECT wallet_id, tp_levels, entry_liquidity_usd FROM positions")).all() == [(None, None, 0.0)]
    assert "orders" in inspect(eng).get_table_names()
