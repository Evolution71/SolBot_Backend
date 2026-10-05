"""Buy / sell execution, fee collection and position accounting.

Paper mode simulates fills against live prices and a simulated SOL balance.
Live mode swaps through Jupiter from the user's dedicated trading wallet.
"""
import asyncio
import logging
from collections import defaultdict
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import now
from ..models import Position, Trade, User, Wallet
from ..plans import PLAN_DAYS, effective_plan_id, fee_bps_for, plan_of
from . import jupiter, market, solana
from .solana import LAMPORTS, SOL_MINT

log = logging.getLogger("nexus.trading")

PAPER_IMPACT = 0.01  # simulated price impact + slippage per paper fill
_locks: dict[int, asyncio.Lock] = defaultdict(asyncio.Lock)


class TradeError(Exception):
    pass


def _split_fee(db: Session, user: User, fee: int) -> tuple[int, User | None]:
    """Return (referrer share in lamports, referrer)."""
    if fee <= 0 or not user.referred_by_id:
        return 0, None
    referrer = db.get(User, user.referred_by_id)
    if not referrer or not referrer.wallet:
        return 0, None
    return int(fee * settings.referral_share), referrer


async def _collect_fee(kp, fee: int, share: int, referrer: User | None) -> tuple[str | None, int]:
    """Send the platform fee to the treasury (and the referrer's share to their wallet).

    Never raises: a failed fee transfer must not undo a swap that already settled.
    Returns (signature, share actually paid to the referrer).
    """
    if fee <= 0:
        return None, 0
    try:
        if share > 0 and referrer:
            # A transfer that leaves a brand-new account below rent-exemption is rejected by the network.
            if share < solana.RENT_EXEMPT_MIN and await solana.get_balance(referrer.wallet.pubkey) == 0:
                share = 0
        else:
            share = 0
        transfers = [(settings.treasury_wallet, fee - share)]
        if share:
            transfers.append((referrer.wallet.pubkey, share))
        return await solana.transfer_sol(kp, transfers), share
    except Exception as exc:  # noqa: BLE001
        log.error("Fee transfer of %s lamports failed: %s", fee, exc)
        return None, 0


def _grant_referral_reward(db: Session, user: User) -> None:
    """Give the referrer a free Hunter month once enough of their referrals have traded."""
    if not user.referred_by_id:
        return
    referrer = db.get(User, user.referred_by_id)
    if not referrer or referrer.referral_reward_granted:
        return
    active = db.scalar(
        select(func.count(func.distinct(Trade.user_id)))
        .join(User, User.id == Trade.user_id)
        .where(User.referred_by_id == referrer.id)
    ) or 0
    if active < settings.referral_unlock_count:
        return
    referrer.referral_reward_granted = True
    if effective_plan_id(referrer) == "free":
        referrer.plan = "pro"
        referrer.plan_expires_at = now() + timedelta(days=PLAN_DAYS)
    else:
        referrer.plan_expires_at = referrer.plan_expires_at + timedelta(days=PLAN_DAYS)


def open_position_count(db: Session, user_id: int) -> int:
    return db.scalar(select(func.count(Position.id)).where(
        Position.user_id == user_id, Position.status == "open")) or 0


async def buy(db: Session, user: User, mint: str, sol: float, *, slippage_bps: int = 1500,
              tp_pct: float | None = None, sl_pct: float | None = None, trailing_pct: float | None = None,
              priority_lamports: int = 0, source: str = "manual") -> Trade:
    async with _locks[user.id]:
        return await _buy(db, user, mint, sol, slippage_bps, tp_pct, sl_pct, trailing_pct, priority_lamports, source)


async def _buy(db, user, mint, sol, slippage_bps, tp_pct, sl_pct, trailing_pct, priority_lamports, source) -> Trade:
    plan = plan_of(user)
    wallet: Wallet = user.wallet
    lamports = int(sol * LAMPORTS)
    if lamports < 1_000_000:
        raise TradeError("Minimum buy is 0.001 SOL")
    if mint == SOL_MINT or not solana.is_valid_address(mint):
        raise TradeError("Invalid token address")

    position = db.scalar(select(Position).where(
        Position.user_id == user.id, Position.mint == mint, Position.status == "open"))
    if not position and open_position_count(db, user.id) >= plan["max_positions"]:
        raise TradeError(f"Your {plan['name']} plan allows {plan['max_positions']} open positions")
    if plan["daily_buys"] is not None:
        today = now().replace(hour=0, minute=0, second=0, microsecond=0)
        used = db.scalar(select(func.count(Trade.id)).where(
            Trade.user_id == user.id, Trade.side == "buy", Trade.created_at >= today)) or 0
        if used >= plan["daily_buys"]:
            raise TradeError(f"Daily limit of {plan['daily_buys']} buys reached - upgrade for unlimited trading")
    if not plan["tp_sl"]:
        tp_pct = sl_pct = None
    if not plan["trailing"]:
        trailing_pct = None
    if not plan["priority_fees"]:
        priority_lamports = 0

    token = await market.get_token(mint)
    if not token or token["price_sol"] <= 0:
        raise TradeError("No tradable SOL pool found for this token")
    decimals = await solana.get_decimals(mint)
    fee = lamports * fee_bps_for(user) // 10_000
    share, referrer = _split_fee(db, user, fee)
    signature = fee_signature = None

    if settings.paper_trading:
        if wallet.paper_lamports < lamports + fee:
            raise TradeError("Insufficient paper balance")
        raw_out = int(lamports / LAMPORTS / token["price_sol"] * (1 - PAPER_IMPACT) * 10 ** decimals)
        wallet.paper_lamports -= lamports + fee
        if share and referrer:
            referrer.wallet.paper_lamports += share
    else:
        balance = await solana.get_balance(wallet.pubkey)
        if balance < lamports + fee + solana.TX_RESERVE + priority_lamports:
            raise TradeError("Insufficient SOL - deposit to your trading wallet (0.003 SOL is reserved for network fees)")
        kp = solana.load_keypair(wallet.enc_secret)
        try:
            signature, raw_out = await jupiter.execute_swap(kp, SOL_MINT, mint, lamports, slippage_bps, priority_lamports)
        except jupiter.SwapError as exc:
            raise TradeError(str(exc)) from exc
        fee_signature, share = await _collect_fee(kp, fee, share, referrer)

    if raw_out <= 0:
        raise TradeError("Swap returned no tokens")
    fill_price = lamports / LAMPORTS / (raw_out / 10 ** decimals)

    if position:
        position.token_amount = str(int(position.token_amount) + raw_out)
        position.cost_lamports += lamports + fee
        position.entry_price_sol = position.cost_lamports / LAMPORTS / (int(position.token_amount) / 10 ** decimals)
        position.peak_price_sol = max(position.peak_price_sol, fill_price)
        for field, value in (("tp_pct", tp_pct), ("sl_pct", sl_pct), ("trailing_pct", trailing_pct)):
            if value is not None:
                setattr(position, field, value)
    else:
        position = Position(
            user_id=user.id, mint=mint, symbol=token["symbol"][:32], name=token["name"][:128], image=token["image"][:512],
            decimals=decimals, token_amount=str(raw_out), cost_lamports=lamports + fee,
            entry_price_sol=(lamports + fee) / LAMPORTS / (raw_out / 10 ** decimals), peak_price_sol=fill_price,
            tp_pct=tp_pct, sl_pct=sl_pct, trailing_pct=trailing_pct, source=source, paper=settings.paper_trading)
        db.add(position)
        db.flush()

    trade = Trade(
        user_id=user.id, position_id=position.id, side="buy", mint=mint, symbol=position.symbol,
        sol_lamports=lamports, token_amount=str(raw_out), price_sol=fill_price, fee_lamports=fee,
        referral_lamports=share, signature=signature, fee_signature=fee_signature, source=source,
        paper=settings.paper_trading)
    db.add(trade)
    db.flush()
    _grant_referral_reward(db, user)
    db.commit()
    return trade


async def sell(db: Session, user: User, position_id: int, pct: float = 100, *,
               slippage_bps: int = 1500, priority_lamports: int = 0, reason: str = "manual") -> Trade:
    async with _locks[user.id]:
        return await _sell(db, user, position_id, pct, slippage_bps, priority_lamports, reason)


async def _sell(db, user, position_id, pct, slippage_bps, priority_lamports, reason) -> Trade:
    position = db.get(Position, position_id)
    if not position or position.user_id != user.id:
        raise TradeError("Position not found")
    db.refresh(position)
    if position.status != "open":
        raise TradeError("Position is already closed")
    if not 0 < pct <= 100:
        raise TradeError("Sell percentage must be between 1 and 100")
    if not plan_of(user)["priority_fees"]:
        priority_lamports = 0

    wallet: Wallet = user.wallet
    held = int(position.token_amount)
    raw_sell = held if pct >= 100 else held * int(pct * 100) // 10_000
    signature = fee_signature = None
    kp = None

    if position.paper:
        token = await market.get_token(position.mint)
        if not token or token["price_sol"] <= 0:
            raise TradeError("No live price for this token right now - try again shortly")
        proceeds = int(raw_sell / 10 ** position.decimals * token["price_sol"] * (1 - PAPER_IMPACT) * LAMPORTS)
    else:
        on_chain = await solana.token_balance(wallet.pubkey, position.mint)
        if on_chain <= 0:
            position.status, position.closed_at = "closed", now()
            position.realized_pnl_lamports -= position.cost_lamports
            position.token_amount, position.cost_lamports = "0", 0
            db.commit()
            raise TradeError("These tokens are no longer in your trading wallet - position closed")
        if pct >= 100 or raw_sell > on_chain:
            raw_sell = min(on_chain, held) if pct < 100 else on_chain
        kp = solana.load_keypair(wallet.enc_secret)
        try:
            signature, proceeds = await jupiter.execute_swap(
                kp, position.mint, SOL_MINT, raw_sell, slippage_bps, priority_lamports)
        except jupiter.SwapError as exc:
            raise TradeError(str(exc)) from exc

    if raw_sell <= 0:
        raise TradeError("Nothing to sell")
    fee = proceeds * fee_bps_for(user) // 10_000
    share, referrer = _split_fee(db, user, fee)
    if position.paper:
        wallet.paper_lamports += proceeds - fee
        if share and referrer:
            referrer.wallet.paper_lamports += share
    else:
        fee_signature, share = await _collect_fee(kp, fee, share, referrer)

    closing = pct >= 100 or raw_sell >= held
    cost_part = position.cost_lamports if closing else position.cost_lamports * raw_sell // held
    pnl = proceeds - fee - cost_part
    position.realized_pnl_lamports += pnl
    position.cost_lamports -= cost_part
    position.token_amount = "0" if closing else str(held - raw_sell)
    if closing:
        position.status, position.closed_at = "closed", now()

    trade = Trade(
        user_id=user.id, position_id=position.id, side="sell", mint=position.mint, symbol=position.symbol,
        sol_lamports=proceeds, token_amount=str(raw_sell),
        price_sol=proceeds / LAMPORTS / (raw_sell / 10 ** position.decimals), fee_lamports=fee,
        referral_lamports=share, pnl_lamports=pnl, signature=signature, fee_signature=fee_signature,
        source=position.source, reason=reason, paper=position.paper)
    db.add(trade)
    db.commit()
    return trade
