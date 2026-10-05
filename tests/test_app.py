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
    assert wallet["sol"] == 10 and wallet["address"] == user["wallet"]
    assert client.post("/api/auth/register", json={"email": "alice@test.io", "username": "x12", "password": "password123"}).status_code == 400


def test_key_export_roundtrip_requires_password(client):
    headers, user = signup(client)
    assert client.post("/api/wallet/export", json={"password": "wrong"}, headers=headers).status_code == 403
    secret = client.post("/api/wallet/export", json={"password": "password123"}, headers=headers).json()["secret_key"]
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
