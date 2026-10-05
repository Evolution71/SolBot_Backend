"""On-chain rug-risk checks. A score is a filter, not a guarantee."""
import time

from . import solana

_cache: dict[str, tuple[float, dict]] = {}


async def check(mint: str, token: dict | None = None) -> dict:
    """Return {score 0-100, flags[], mint_revoked, freeze_revoked, top10_pct}."""
    hit = _cache.get(mint)
    if hit and time.time() - hit[0] < 60:
        return hit[1]

    score = 100
    flags: list[dict] = []
    mint_revoked = freeze_revoked = None
    top10_pct = None

    def flag(level: str, text: str, penalty: int = 0):
        nonlocal score
        score -= penalty
        flags.append({"level": level, "text": text})

    try:
        info = await solana.get_mint_info(mint)
        mint_revoked = info["mint_authority"] is None
        freeze_revoked = info["freeze_authority"] is None
        if mint_revoked:
            flag("ok", "Mint authority revoked")
        else:
            flag("danger", "Mint authority active - supply can be inflated", 30)
        if freeze_revoked:
            flag("ok", "Freeze authority revoked")
        else:
            flag("danger", "Freeze authority active - your tokens can be frozen", 30)
        try:
            holders = await solana.largest_holders(mint)
            if info["supply"] > 0 and holders:
                top10_pct = round(sum(holders[:10]) / info["supply"] * 100, 1)
                if top10_pct > 70:
                    flag("danger", f"Top 10 accounts hold {top10_pct}% (includes pool accounts)", 20)
                elif top10_pct > 40:
                    flag("warn", f"Top 10 accounts hold {top10_pct}% (includes pool accounts)", 10)
                else:
                    flag("ok", f"Top 10 accounts hold {top10_pct}%")
        except solana.RpcError:
            flag("warn", "Holder distribution could not be verified", 5)
    except solana.RpcError:
        flag("warn", "Token authorities could not be verified", 25)

    if token:
        liq = token.get("liquidity_usd") or 0
        if liq < 5_000:
            flag("danger", f"Very thin liquidity (${liq:,.0f})", 25)
        elif liq < 20_000:
            flag("warn", f"Low liquidity (${liq:,.0f})", 10)
        else:
            flag("ok", f"Liquidity ${liq:,.0f}")
        age = token.get("age_minutes")
        if age is not None and age < 10:
            flag("warn", "Pool is under 10 minutes old", 5)
        buys, sells = token.get("buys_h1", 0), token.get("sells_h1", 0)
        if buys >= 20 and sells == 0:
            flag("danger", "Buys but no sells in the last hour - possible honeypot", 25)
    else:
        flag("warn", "No liquidity pool found", 30)

    result = {"score": max(0, min(100, score)), "flags": flags, "mint_revoked": mint_revoked,
              "freeze_revoked": freeze_revoked, "top10_pct": top10_pct}
    _cache[mint] = (time.time(), result)
    return result
