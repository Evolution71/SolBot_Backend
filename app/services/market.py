"""Token discovery and pricing, sourced from the public DexScreener API."""
import asyncio
import time
from urllib.parse import quote

import httpx

from . import solana

BASE = "https://api.dexscreener.com"
_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, ttl: float):
    hit = _cache.get(key)
    return hit[1] if hit and time.time() - hit[0] < ttl else None


def _store(key: str, value):
    _cache[key] = (time.time(), value)
    if len(_cache) > 2000:
        for k in sorted(_cache, key=lambda k: _cache[k][0])[:500]:
            _cache.pop(k, None)
    return value


async def _get(path: str):
    try:
        res = await solana.client().get(BASE + path, headers={"Accept": "application/json"})
        if res.status_code != 200:
            return None
        return res.json()
    except (httpx.HTTPError, ValueError):
        return None


def _f(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize(pair: dict) -> dict:
    base = pair.get("baseToken") or {}
    created = pair.get("pairCreatedAt")
    txns = (pair.get("txns") or {}).get("h1") or {}
    change = pair.get("priceChange") or {}
    volume = pair.get("volume") or {}
    return {
        "mint": base.get("address", ""),
        "symbol": base.get("symbol", "?"),
        "name": base.get("name", ""),
        "image": (pair.get("info") or {}).get("imageUrl", ""),
        "dex": pair.get("dexId", ""),
        "pair": pair.get("pairAddress", ""),
        "url": pair.get("url", ""),
        "price_usd": _f(pair.get("priceUsd")),
        "price_sol": _f(pair.get("priceNative")),
        "liquidity_usd": _f((pair.get("liquidity") or {}).get("usd")),
        "market_cap": _f(pair.get("marketCap") or pair.get("fdv")),
        "volume_h24": _f(volume.get("h24")),
        "volume_h1": _f(volume.get("h1")),
        "change_m5": _f(change.get("m5")),
        "change_h1": _f(change.get("h1")),
        "change_h24": _f(change.get("h24")),
        "buys_h1": int(txns.get("buys") or 0),
        "sells_h1": int(txns.get("sells") or 0),
        "created_at": int(created) if created else None,
        "age_minutes": round((time.time() * 1000 - created) / 60000, 1) if created else None,
    }


def _best_pairs(pairs: list[dict]) -> dict[str, dict]:
    """Pick the deepest SOL-quoted pool for each token."""
    best: dict[str, dict] = {}
    for pair in pairs or []:
        if pair.get("chainId") != "solana":
            continue
        if (pair.get("quoteToken") or {}).get("address") != solana.SOL_MINT:
            continue
        mint = (pair.get("baseToken") or {}).get("address")
        liq = _f((pair.get("liquidity") or {}).get("usd"))
        if mint and (mint not in best or liq > _f((best[mint].get("liquidity") or {}).get("usd"))):
            best[mint] = pair
    return {mint: _normalize(pair) for mint, pair in best.items()}


async def get_tokens(mints: list[str], ttl: float = 4) -> dict[str, dict]:
    """Market data for many mints, keyed by mint. Missing or pool-less mints are omitted."""
    out: dict[str, dict] = {}
    missing: list[str] = []
    for mint in dict.fromkeys(mints):
        hit = _cached(f"tok:{mint}", ttl)
        if hit is not None:
            out[mint] = hit
        else:
            missing.append(mint)
    chunks = [missing[i:i + 30] for i in range(0, len(missing), 30)]
    results = await asyncio.gather(*[_get(f"/tokens/v1/solana/{','.join(c)}") for c in chunks])
    for data in results:
        for mint, token in _best_pairs(data if isinstance(data, list) else []).items():
            out[mint] = _store(f"tok:{mint}", token)
    return out


async def get_token(mint: str, ttl: float = 4) -> dict | None:
    return (await get_tokens([mint], ttl)).get(mint)


async def feed(kind: str = "new") -> list[dict]:
    """`new` = most recently created pools, `trending` = most promoted/active tokens."""
    kind = kind if kind in ("new", "trending") else "new"
    hit = _cached(f"feed:{kind}", 8)
    if hit is not None:
        return hit
    path = "/token-profiles/latest/v1" if kind == "new" else "/token-boosts/top/v1"
    data = await _get(path)
    mints = [x["tokenAddress"] for x in (data or []) if x.get("chainId") == "solana" and x.get("tokenAddress")]
    tokens = list((await get_tokens(mints[:60], ttl=8)).values())
    if kind == "new":
        tokens.sort(key=lambda t: t["created_at"] or 0, reverse=True)
    else:
        tokens.sort(key=lambda t: t["volume_h1"], reverse=True)
    if not tokens:  # upstream hiccup: serve the last good feed rather than an empty table
        stale = _cache.get(f"feed:{kind}")
        return stale[1] if stale else []
    return _store(f"feed:{kind}", tokens)


async def search(query: str) -> list[dict]:
    query = query.strip()
    if not query:
        return []
    if solana.is_valid_address(query):
        token = await get_token(query)
        return [token] if token else []
    data = await _get(f"/latest/dex/search?q={quote(query)}")
    return list(_best_pairs((data or {}).get("pairs") or []).values())[:25]


async def sol_price_usd() -> float:
    hit = _cached("solusd", 30)
    if hit:
        return hit
    data = await _get(f"/tokens/v1/solana/{solana.SOL_MINT}")
    prices = [
        (_f((p.get("liquidity") or {}).get("usd")), _f(p.get("priceUsd")))
        for p in (data if isinstance(data, list) else [])
        if (p.get("baseToken") or {}).get("address") == solana.SOL_MINT and _f(p.get("priceUsd")) > 0
    ]
    if not prices:
        stale = _cache.get("solusd")
        return stale[1] if stale else 0.0
    return _store("solusd", max(prices)[1])
