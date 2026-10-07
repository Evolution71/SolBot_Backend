"""Background engine: auto-sniper, exit monitor, limit / DCA orders and copy trading."""
import asyncio
import json
import logging
import time
from collections import defaultdict, deque
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal, now
from ..models import CopyTarget, Order, Position, SniperConfig, User
from ..plans import plan_of
from . import market, safety, solana, trading

log = logging.getLogger("nexus.engine")

MAX_ORDER_FAILURES = 3
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
                    db, user, token["mint"], cfg.buy_sol, wallet=trading.wallet_for(db, user, cfg.wallet_id),
                    slippage_bps=cfg.slippage_bps, tp_pct=cfg.tp_pct, sl_pct=cfg.sl_pct,
                    trailing_pct=cfg.trailing_pct, tp_levels=cfg.tp_levels, rug_exit_pct=cfg.rug_exit_pct,
                    priority_lamports=cfg.priority_lamports, source="sniper")
                emit(user.id, "buy", f"Sniped ${trade.symbol} for {cfg.buy_sol} SOL (safety {report['score']})")
            except trading.TradeError as exc:
                db.rollback()
                emit(user.id, "error", f"Snipe of ${token['symbol']} failed - {exc}")
            break  # at most one snipe per user per cycle
    if len(_attempted) > 20_000:
        cutoff = time.time() - 6 * 3600
        for key in [k for k, t in _attempted.items() if t < cutoff]:
            _attempted.pop(key, None)


# ---------- exits: rug guard, stop-loss, trailing stop, take-profit ----------

def exit_signal(position: Position, price: float, liquidity_usd: float | None = None) -> tuple[str, float, int | None] | None:
    """Decide whether to sell. Returns (reason, percent to sell, take-profit level index) or None."""
    if position.rug_exit_pct and position.entry_liquidity_usd > 0 and liquidity_usd is not None:
        if liquidity_usd <= position.entry_liquidity_usd * (1 - position.rug_exit_pct / 100):
            return "rug-guard", 100, None
    if position.entry_price_sol <= 0 or price <= 0:
        return None
    change = (price / position.entry_price_sol - 1) * 100
    if position.sl_pct and change <= -position.sl_pct:
        return "stop-loss", 100, None
    if position.trailing_pct and position.peak_price_sol > 0:
        if (price / position.peak_price_sol - 1) * 100 <= -position.trailing_pct:
            return "trailing-stop", 100, None
    for index, level in enumerate(trading.load_levels(position.tp_levels)):
        if not level.get("hit") and change >= level["pct"]:
            return f"take-profit-{index + 1}", level["sell"], index
    if position.tp_pct and change >= position.tp_pct:
        return "take-profit", 100, None
    return None


async def monitor_positions(db: Session) -> None:
    positions = db.scalars(select(Position).where(Position.status == "open")).all()
    watched = [p for p in positions if p.tp_pct or p.sl_pct or p.trailing_pct or p.tp_levels or p.rug_exit_pct]
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
        signal = exit_signal(position, price, token.get("liquidity_usd"))
        if not signal:
            continue
        reason, pct, level_index = signal
        user = db.get(User, position.user_id)
        try:
            trade = await trading.sell(db, user, position.id, pct, reason=reason)
            if level_index is not None:
                levels = trading.load_levels(position.tp_levels)
                levels[level_index]["hit"] = True
                position.tp_levels = json.dumps(levels)
                db.commit()
            emit(user.id, "sell", f"{reason.replace('-', ' ').title()} on ${trade.symbol}: sold {pct:g}% "
                                  f"({trade.pnl_lamports / 1e9:+.4f} SOL)")
        except trading.TradeError as exc:
            db.rollback()
            emit(user.id, "error", f"Auto-sell of ${position.symbol} failed - {exc}")


# ---------- limit orders and DCA ----------

async def run_orders(db: Session) -> None:
    orders = db.scalars(select(Order).where(Order.status == "active")).all()
    if not orders:
        return
    prices = await market.get_tokens([o.mint for o in orders])
    for order in orders:
        user = db.get(User, order.user_id)
        if not user or not user.is_active or plan_of(user)["orders"] <= 0:
            continue  # paused while the plan does not include orders
        if order.expires_at and order.expires_at <= now():
            order.status = "expired"
            db.commit()
            emit(user.id, "info", f"{order.kind.upper()} order for ${order.symbol} expired")
            continue
        token = prices.get(order.mint)
        if not token or token["price_usd"] <= 0:
            continue
        if order.kind == "dca" and order.next_run_at and order.next_run_at > now():
            continue
        if order.trigger_price_usd and token["price_usd"] > order.trigger_price_usd:
            continue
        try:
            trade = await trading.buy(
                db, user, order.mint, order.sol_per_order, wallet=trading.wallet_for(db, user, order.wallet_id),
                slippage_bps=order.slippage_bps, tp_pct=order.tp_pct, sl_pct=order.sl_pct,
                trailing_pct=order.trailing_pct, tp_levels=order.tp_levels, rug_exit_pct=order.rug_exit_pct,
                source=order.kind)
        except trading.TradeError as exc:
            db.rollback()
            order.fail_count += 1
            order.last_error = str(exc)[:200]
            if order.fail_count >= MAX_ORDER_FAILURES:
                order.status = "failed"
            elif order.kind == "dca":
                order.next_run_at = now() + timedelta(minutes=order.interval_minutes or 1)
            db.commit()
            emit(user.id, "error", f"{order.kind.upper()} order for ${order.symbol} failed - {exc}")
            continue
        order.filled_orders += 1
        order.spent_lamports += trade.sol_lamports + trade.fee_lamports
        order.fail_count, order.last_error = 0, ""
        if order.filled_orders >= order.total_orders:
            order.status = "filled"
        else:
            order.next_run_at = now() + timedelta(minutes=order.interval_minutes or 1)
        db.commit()
        label = "Limit order filled" if order.kind == "limit" else f"DCA buy {order.filled_orders}/{order.total_orders}"
        emit(user.id, "buy", f"{label}: ${trade.symbol} for {order.sol_per_order} SOL")


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
                                      wallet=trading.wallet_for(db, user, target.wallet_id),
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
    for step in (run_sniper, run_orders, monitor_positions, run_copy):
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
