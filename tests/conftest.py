import os

os.environ.update(DATABASE_URL="sqlite:///:memory:", PAPER_TRADING="true", ENGINE_ENABLED="false",
                  ADMIN_EMAIL="admin@test.io", LAUNCH_PROMO_USERS="0")

import pytest
from fastapi.testclient import TestClient

from app.database import Base, engine
from app.main import app
from app.routers import auth as auth_router
from app.services import market, safety, solana

MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"
TOKEN = {"mint": MINT, "symbol": "TEST", "name": "Test Token", "image": "", "dex": "raydium", "pair": "", "url": "",
         "price_usd": 0.0002, "price_sol": 0.000001, "liquidity_usd": 50000, "market_cap": 200000, "volume_h24": 1e5,
         "volume_h1": 1e4, "change_m5": 1, "change_h1": 5, "change_h24": 20, "buys_h1": 30, "sells_h1": 20,
         "created_at": 0, "age_minutes": 12}


@pytest.fixture
def state():
    return {"price": 0.000001}


@pytest.fixture
def client(monkeypatch, state):
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    auth_router._attempts.clear()
    safety._cache.clear()

    async def get_tokens(mints, ttl=4):
        return {m: {**TOKEN, "mint": m, "price_sol": state["price"]} for m in mints}

    async def get_token(mint, ttl=4):
        return {**TOKEN, "mint": mint, "price_sol": state["price"]}

    async def feed(kind="new"):
        return [{**TOKEN, "price_sol": state["price"]}]

    async def sol_price():
        return 200.0

    async def decimals(mint, default=6):
        return 6

    async def balance(pubkey):
        return state.get("chain_balance", 0)

    async def mint_info(mint):
        return {"decimals": 6, "supply": 10**15, "mint_authority": None, "freeze_authority": None}

    async def holders(mint):
        return [10**13] * 10

    monkeypatch.setattr(market, "get_tokens", get_tokens)
    monkeypatch.setattr(market, "get_token", get_token)
    monkeypatch.setattr(market, "feed", feed)
    monkeypatch.setattr(market, "sol_price_usd", sol_price)
    monkeypatch.setattr(solana, "get_decimals", decimals)
    monkeypatch.setattr(solana, "get_balance", balance)
    monkeypatch.setattr(solana, "get_mint_info", mint_info)
    monkeypatch.setattr(solana, "largest_holders", holders)
    with TestClient(app) as c:
        yield c


def signup(client, name="alice", ref=None, email=None):
    res = client.post("/api/auth/register", json={
        "email": email or f"{name}@test.io", "username": name, "password": "password123", "referral_code": ref})
    assert res.status_code == 200, res.text
    data = res.json()
    return {"Authorization": f"Bearer {data['token']}"}, data["user"]
