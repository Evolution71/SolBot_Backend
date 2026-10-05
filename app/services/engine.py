"""Background engine: auto-sniper, take-profit / stop-loss monitor and copy trading."""
import asyncio
import logging
import time
from collections import defaultdict, deque

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal
from ..models import CopyTarget, Position, SniperConfig, User
from ..plans import plan_of
from . import market, safety, solana, trading

log = logging.getLogger("nexus.engine")

_events: dict[int, deque] = defaultdict(lambda: deque(maxlen=100))
_attempted: dict[tuple[int, str], float] = {}  # (user, mint) -> time; never retry the same token


def emit(user_id: int, kind: str, text: str) -> None:
    _events[user_id].appendleft({"ts": int(time.time() * 1000), "kind": kind, "text": text})


def events_for(user_id: int) -> list[dict]:
    return list(_events[user_id])


# ---------- auto-sniper ----------

def passes_filters(cfg: SniperConfig, token: dict, report: dict) -> str | None:
    """Return None if the token passes, otherwise the reason it was skipped."""
    if token["liquidity_usd"] < cfg.min_liquidity_usd:
        return "liquidity below minimum"
    if cfg.max_liquidity_usd and token["liquidity_usd"] > cfg.max_liquidity_usd:
        return "liquidity above maximum"
    if token["age_minutes"] is None or token["age_minutes"] > cfg.max_age_minutes:
        return "pool too old"
    if report["score"] < cfg.min_safety_score:
        return f"safety score {report['score']}"
    if cfg.require_mint_revoked and report["mint_revoked"] is not True:
        return "mint authority not revoked"
    if cfg.require_freeze_revoked and report["freeze_revoked"] is not True:
        return "freeze authority not revoked"
    if report["top10_pct"] is not None and report["top10_pct"] > cfg.max_top10_pct:
        return f"top holders own {report['top10_pct']}%"
    return None


async def run_sniper(db: Session) -> None:
    configs = db.scalars(select(SniperConfig).where(SniperConfig.enabled.is_(True))).all()
    active = []
    for cfg in configs:
        user = db.get(User, cfg.user_id)
        if user and user.is_active and plan_of(user)["auto_snipe"]:
            active.append((cfg, user))
    if not active:
        return
    tokens = await market.feed("new")
    for cfg, user in active:
        limit = min(cfg.max_open_positions, plan_of(user)["max_positions"])
        if trading.open_position_count(db, user.id) >= limit:
            continue
        for token in tokens:
            key = (user.id, token["mint"])
            if key in _attempted:
                continue
            # cheap market filters first, on-chain checks only for real candidates
            if token["liquidity_usd"] < cfg.min_liquidity_usd or token["age_minutes"] is None \
                    or token["age_minutes"] > cfg.max_age_minutes:
                continue
            _attempted[key] = time.time()
            report = await safety.check(token["mint"], token)
            reason = passes_filters(cfg, token, report)
            if reason:
                emit(user.id, "skip", f"Skipped ${token['symbol']} - {reason}")
                continue
            try:
                trade = await trading.buy(
                    db, user, token["mint"], cfg.buy_sol, slippage_bps=cfg.slippage_bps, tp_pct=cfg.tp_pct,
                    sl_pct=cfg.sl_pct, trailing_pct=cfg.trailing_pct, priority_lamports=cfg.priority_lamports,
                    source="sniper")
                emit(user.id, "buy", f"Sniped ${trade.symbol} for {cfg.buy_sol} SOL (safety {report['score']})")
            except trading.TradeError as exc:
                db.rollback()
                emit(user.id, "error", f"Snipe of ${token['symbol']} failed - {exc}")
            break  # at most one snipe per user per cycle
    if len(_attempted) > 20_000:
        cutoff = time.time() - 6 * 3600
        for key in [k for k, t in _attempted.items() if t < cutoff]:
            _attempted.pop(key, None)


# ---------- TP / SL / trailing ----------

def exit_signal(position: Position, price: float) -> str | None:
    if position.entry_price_sol <= 0 or price <= 0:
        return None
    change = (price / position.entry_price_sol - 1) * 100
    if position.tp_pct and change >= position.tp_pct:
        return "take-profit"
    if position.sl_pct and change <= -position.sl_pct:
        return "stop-loss"
    if position.trailing_pct and position.peak_price_sol > 0:
        if (price / position.peak_price_sol - 1) * 100 <= -position.trailing_pct:
            return "trailing-stop"
    return None


async def monitor_positions(db: Session) -> None:
    positions = db.scalars(select(Position).where(Position.status == "open")).all()
    watched = [p for p in positions if p.tp_pct or p.sl_pct or p.trailing_pct]
    if not watched:
        return
    prices = await market.get_tokens([p.mint for p in watched])
    for position in watched:
        token = prices.get(position.mint)
        if not token:
            continue
        price = token["price_sol"]
        if price > position.peak_price_sol:
            position.peak_price_sol = price
            db.commit()
        reason = exit_signal(position, price)
        if not reason:
            continue
        user = db.get(User, position.user_id)
        try:
            trade = await trading.sell(db, user, position.id, 100, reason=reason)
            emit(user.id, "sell", f"{reason.title()} hit on ${trade.symbol}: {trade.pnl_lamports / 1e9:+.4f} SOL")
        except trading.TradeError as exc:
            db.rollback()
            emit(user.id, "error", f"Auto-sell of ${position.symbol} failed - {exc}")


# ---------- copy trading ----------

def parse_swap(tx: dict | None, wallet: str) -> dict | None:
    """Detect a SOL<->token swap made by `wallet`. Returns {side, mint} or None."""
    if not tx or not tx.get("meta") or tx["meta"].get("err"):
        return None
    meta = tx["meta"]
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in tx["transaction"]["message"]["accountKeys"]]
    if wallet not in keys:
        return None
    idx = keys.index(wallet)
    sol_delta = meta["postBalances"][idx] - meta["preBalances"][idx]
    deltas: dict[str, float] = defaultdict(float)
    for sign, rows in ((-1, meta.get("preTokenBalances")), (1, meta.get("postTokenBalances"))):
        for row in rows or []:
            if row.get("owner") != wallet:
                continue
            amount = float(row["uiTokenAmount"].get("uiAmountString") or 0)
            if row["mint"] == solana.SOL_MINT:
                sol_delta += sign * int(amount * solana.LAMPORTS)
            else:
                deltas[row["mint"]] += sign * amount
    deltas = {m: d for m, d in deltas.items() if abs(d) > 0}
    if len(deltas) != 1:
        return None  # not a simple SOL<->token swap
    mint, delta = next(iter(deltas.items()))
    if delta > 0 and sol_delta < -1_000_000:
        return {"side": "buy", "mint": mint}
    if delta < 0 and sol_delta > 0:
        return {"side": "sell", "mint": mint}
    return None


async def run_copy(db: Session) -> None:
    targets = db.scalars(select(CopyTarget).where(CopyTarget.enabled.is_(True))).all()
    by_address: dict[str, list[tuple[CopyTarget, User]]] = defaultdict(list)
    for target in targets:
        user = db.get(User, target.user_id)
        if user and user.is_active and plan_of(user)["copy_wallets"] > 0:
            by_address[target.address].append((target, user))
    for address, followers in by_address.items():
        try:
            sigs = [s["signature"] for s in await solana.get_signatures(address, 10) if not s.get("err")]
        except solana.RpcError as exc:
            log.warning("copy: signatures for %s failed: %s", address, exc)
            continue
        if not sigs:
            continue
        tx_cache: dict[str, dict | None] = {}
        for target, user in followers:
            last = target.last_signature
            target.last_signature = sigs[0]
            db.commit()
            if last is None:
                continue  # first run: start from now, never replay history
            fresh = sigs[:sigs.index(last)] if last in sigs else sigs
            for sig in reversed(fresh):
                if sig not in tx_cache:
                    try:
                        tx_cache[sig] = parse_swap(await solana.get_transaction(sig), address)
                    except solana.RpcError:
                        tx_cache[sig] = None
                swap = tx_cache[sig]
                if swap:
                    await _mirror(db, user, target, swap)


async def _mirror(db: Session, user: User, target: CopyTarget, swap: dict) -> None:
    name = target.label or target.address[:4] + "..." + target.address[-4:]
    try:
        if swap["side"] == "buy":
            trade = await trading.buy(db, user, swap["mint"], target.buy_sol,
                                      slippage_bps=target.slippage_bps, source="copy")
            emit(user.id, "buy", f"Copied {name}: bought ${trade.symbol} for {target.buy_sol} SOL")
        elif target.copy_sells:
            position = db.scalar(select(Position).where(
                Position.user_id == user.id, Position.mint == swap["mint"],
                Position.status == "open", Position.source == "copy"))
            if position:
                trade = await trading.sell(db, user, position.id, 100, slippage_bps=target.slippage_bps, reason="copy-sell")
                emit(user.id, "sell", f"Copied {name}: sold ${trade.symbol} ({trade.pnl_lamports / 1e9:+.4f} SOL)")
    except trading.TradeError as exc:
        db.rollback()
        emit(user.id, "error", f"Copy of {name} failed - {exc}")


# ---------- loop ----------

async def tick() -> None:
    for step in (run_sniper, monitor_positions, run_copy):
        db = SessionLocal()
        try:
            await step(db)
        except Exception:  # noqa: BLE001 - one failing step must not stop the engine
            log.exception("engine step %s failed", step.__name__)
            db.rollback()
        finally:
            db.close()


async def run_forever() -> None:
    log.info("engine started (interval %.1fs, paper=%s)", settings.engine_interval, settings.paper_trading)
    while True:
        started = time.time()
        await tick()
        await asyncio.sleep(max(1.0, settings.engine_interval - (time.time() - started)))
