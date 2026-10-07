"""Limit orders and DCA (dollar-cost averaging) strategies."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db, now
from ..deps import current_user
from ..models import Order, User
from ..plans import plan_of
from ..services import market, solana, trading
from ..services.solana import LAMPORTS
from .trade import ExitRules

router = APIRouter(prefix="/api/orders", tags=["orders"])


class OrderIn(ExitRules):
    kind: str = Field(pattern="^(limit|dca)$")
    mint: str
    sol_per_order: float = Field(gt=0, le=1000)
    wallet_id: int | None = None
    slippage_bps: int = Field(default=1500, ge=10, le=5000)
    # limit: buy when the price falls to this. dca: optional ceiling, buys are skipped above it.
    trigger_price_usd: float | None = Field(default=None, gt=0)
    expires_hours: float | None = Field(default=None, gt=0, le=24 * 90)
    # limit only: place several orders, each `ladder_step_pct` below the previous one
    ladder_levels: int = Field(default=1, ge=1, le=10)
    ladder_step_pct: float = Field(default=10, gt=0, lt=90)
    # dca only
    total_orders: int = Field(default=1, ge=1, le=100)
    interval_minutes: int = Field(default=60, ge=1, le=60 * 24 * 30)


def order_out(o: Order, token: dict | None = None, labels: dict[int, str] | None = None) -> dict:
    return {
        "id": o.id, "kind": o.kind, "mint": o.mint, "symbol": o.symbol, "image": o.image,
        "wallet_id": o.wallet_id, "wallet": (labels or {}).get(o.wallet_id, "Main"),
        "sol_per_order": o.sol_per_order, "trigger_price_usd": o.trigger_price_usd,
        "price_usd": token["price_usd"] if token else None,
        "total_orders": o.total_orders, "filled_orders": o.filled_orders, "interval_minutes": o.interval_minutes,
        "next_run_at": o.next_run_at, "expires_at": o.expires_at, "status": o.status, "last_error": o.last_error,
        "spent_sol": o.spent_lamports / LAMPORTS, "tp_pct": o.tp_pct, "sl_pct": o.sl_pct,
        "trailing_pct": o.trailing_pct, "tp_levels": trading.load_levels(o.tp_levels),
        "rug_exit_pct": o.rug_exit_pct, "created_at": o.created_at,
    }


@router.get("")
async def list_orders(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Order).where(Order.user_id == user.id)
                      .order_by(Order.status != "active", Order.created_at.desc()).limit(200)).all()
    prices = await market.get_tokens([o.mint for o in rows if o.status == "active"])
    labels = {w.id: w.label for w in user.wallets}
    return {"orders": [order_out(o, prices.get(o.mint), labels) for o in rows], "limit": plan_of(user)["orders"]}


@router.post("")
async def create_order(body: OrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    plan = plan_of(user)
    if plan["orders"] <= 0:
        raise HTTPException(403, "Limit orders and DCA need the Hunter plan or higher")
    if body.trailing_pct and not plan["trailing"]:
        raise HTTPException(403, "Trailing stops need the Apex plan or higher")
    if body.sol_per_order < 0.001:
        raise HTTPException(400, "Minimum order size is 0.001 SOL")
    if not solana.is_valid_address(body.mint) or body.mint == solana.SOL_MINT:
        raise HTTPException(400, "Invalid token address")
    if body.kind == "limit" and not body.trigger_price_usd:
        raise HTTPException(400, "A limit order needs a target price")
    token = await market.get_token(body.mint)
    if not token:
        raise HTTPException(400, "No tradable SOL pool found for this token")

    count = body.ladder_levels if body.kind == "limit" else 1
    active = db.scalar(select(func.count(Order.id)).where(Order.user_id == user.id, Order.status == "active")) or 0
    if active + count > plan["orders"]:
        raise HTTPException(403, f"Your plan allows {plan['orders']} active orders ({active} in use)")
    try:
        levels = trading.clean_levels(body.levels())
    except (trading.TradeError, KeyError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc

    wallet = trading.wallet_for(db, user, body.wallet_id)
    expires = now() + timedelta(hours=body.expires_hours) if body.expires_hours else None
    created = []
    for i in range(count):
        trigger = body.trigger_price_usd * (1 - body.ladder_step_pct / 100) ** i if body.trigger_price_usd else None
        order = Order(
            user_id=user.id, wallet_id=wallet.id, kind=body.kind, mint=body.mint, symbol=token["symbol"][:32],
            image=token["image"][:512], sol_per_order=body.sol_per_order, trigger_price_usd=trigger,
            total_orders=body.total_orders if body.kind == "dca" else 1,
            interval_minutes=body.interval_minutes if body.kind == "dca" else None,
            next_run_at=now() if body.kind == "dca" else None, expires_at=expires,
            slippage_bps=body.slippage_bps, tp_pct=body.tp_pct, sl_pct=body.sl_pct, trailing_pct=body.trailing_pct,
            tp_levels=levels, rug_exit_pct=body.rug_exit_pct)
        db.add(order)
        created.append(order)
    db.commit()
    labels = {w.id: w.label for w in user.wallets}
    return {"orders": [order_out(o, token, labels) for o in created]}


@router.delete("/{order_id}")
def cancel_order(order_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    order = db.get(Order, order_id)
    if not order or order.user_id != user.id:
        raise HTTPException(404, "Order not found")
    if order.status == "active":
        order.status = "cancelled"
        db.commit()
    return {"ok": True}
