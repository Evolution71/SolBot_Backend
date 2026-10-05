from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db, now
from ..deps import current_user
from ..models import Position, Trade, User
from ..plans import plan_of
from ..services import market, trading
from ..services.solana import LAMPORTS

router = APIRouter(prefix="/api/trade", tags=["trade"])


class BuyIn(BaseModel):
    mint: str
    sol: float = Field(gt=0, le=1000)
    slippage_bps: int = Field(default=1500, ge=10, le=5000)
    tp_pct: float | None = Field(default=None, gt=0, le=100000)
    sl_pct: float | None = Field(default=None, gt=0, lt=100)
    trailing_pct: float | None = Field(default=None, gt=0, lt=100)
    priority_lamports: int = Field(default=0, ge=0, le=100_000_000)


class SellIn(BaseModel):
    position_id: int
    pct: float = Field(default=100, gt=0, le=100)
    slippage_bps: int = Field(default=1500, ge=10, le=5000)
    priority_lamports: int = Field(default=0, ge=0, le=100_000_000)


class TargetsIn(BaseModel):
    tp_pct: float | None = Field(default=None, gt=0, le=100000)
    sl_pct: float | None = Field(default=None, gt=0, lt=100)
    trailing_pct: float | None = Field(default=None, gt=0, lt=100)


def trade_out(t: Trade) -> dict:
    return {
        "id": t.id, "side": t.side, "mint": t.mint, "symbol": t.symbol, "sol": t.sol_lamports / LAMPORTS,
        "price_sol": t.price_sol, "fee_sol": t.fee_lamports / LAMPORTS,
        "pnl_sol": None if t.pnl_lamports is None else t.pnl_lamports / LAMPORTS,
        "signature": t.signature, "source": t.source, "reason": t.reason, "paper": t.paper,
        "created_at": t.created_at,
    }


def position_out(p: Position, token: dict | None) -> dict:
    tokens = int(p.token_amount) / 10 ** p.decimals
    cost = p.cost_lamports / LAMPORTS
    price = token["price_sol"] if token else None
    value = tokens * price if price else None
    return {
        "id": p.id, "mint": p.mint, "symbol": p.symbol, "name": p.name, "image": p.image, "status": p.status,
        "source": p.source, "paper": p.paper, "tokens": tokens, "cost_sol": cost,
        "entry_price_sol": p.entry_price_sol, "price_sol": price, "value_sol": value,
        "pnl_sol": None if value is None else value - cost,
        "pnl_pct": None if value is None or cost <= 0 else (value / cost - 1) * 100,
        "realized_pnl_sol": p.realized_pnl_lamports / LAMPORTS,
        "tp_pct": p.tp_pct, "sl_pct": p.sl_pct, "trailing_pct": p.trailing_pct,
        "opened_at": p.opened_at, "closed_at": p.closed_at,
    }


@router.post("/buy")
async def buy(body: BuyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    try:
        trade = await trading.buy(db, user, body.mint, body.sol, slippage_bps=body.slippage_bps, tp_pct=body.tp_pct,
                                  sl_pct=body.sl_pct, trailing_pct=body.trailing_pct,
                                  priority_lamports=body.priority_lamports)
    except trading.TradeError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    return trade_out(trade)


@router.post("/sell")
async def sell(body: SellIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user = db.merge(user)
    try:
        trade = await trading.sell(db, user, body.position_id, body.pct, slippage_bps=body.slippage_bps,
                                   priority_lamports=body.priority_lamports)
    except trading.TradeError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    return trade_out(trade)


@router.get("/positions")
async def positions(status: str = "open", user: User = Depends(current_user), db: Session = Depends(get_db)):
    query = select(Position).where(Position.user_id == user.id, Position.status == status)
    rows = db.scalars(query.order_by(Position.opened_at.desc()).limit(200)).all()
    prices = await market.get_tokens([p.mint for p in rows]) if status == "open" else {}
    return {"positions": [position_out(p, prices.get(p.mint)) for p in rows]}


@router.patch("/positions/{position_id}")
def set_targets(position_id: int, body: TargetsIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    position = db.get(Position, position_id)
    if not position or position.user_id != user.id or position.status != "open":
        raise HTTPException(404, "Position not found")
    plan = plan_of(user)
    if not plan["tp_sl"]:
        raise HTTPException(403, "Take-profit and stop-loss need the Hunter plan or higher")
    if body.trailing_pct and not plan["trailing"]:
        raise HTTPException(403, "Trailing stops need the Apex plan or higher")
    position.tp_pct, position.sl_pct, position.trailing_pct = body.tp_pct, body.sl_pct, body.trailing_pct
    db.commit()
    return position_out(position, None)


@router.get("/history")
def history(limit: int = 100, user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Trade).where(Trade.user_id == user.id)
                      .order_by(Trade.created_at.desc()).limit(min(limit, 500))).all()
    return {"trades": [trade_out(t) for t in rows]}


@router.get("/stats")
async def stats(user: User = Depends(current_user), db: Session = Depends(get_db)):
    sells = db.scalars(select(Trade).where(Trade.user_id == user.id, Trade.side == "sell")).all()
    all_trades = db.scalars(select(Trade).where(Trade.user_id == user.id)).all()
    open_rows = db.scalars(select(Position).where(Position.user_id == user.id, Position.status == "open")).all()
    prices = await market.get_tokens([p.mint for p in open_rows])

    open_value = open_cost = 0.0
    for p in open_rows:
        cost = p.cost_lamports / LAMPORTS
        token = prices.get(p.mint)
        open_cost += cost
        open_value += int(p.token_amount) / 10 ** p.decimals * token["price_sol"] if token else cost

    start = (now() - timedelta(days=13)).replace(hour=0, minute=0, second=0, microsecond=0)
    by_day: dict[str, float] = defaultdict(float)
    for t in sells:
        if t.created_at >= start:
            by_day[t.created_at.strftime("%Y-%m-%d")] += (t.pnl_lamports or 0) / LAMPORTS
    daily = [{"day": (start + timedelta(days=i)).strftime("%Y-%m-%d"),
              "pnl": round(by_day[(start + timedelta(days=i)).strftime("%Y-%m-%d")], 6)} for i in range(14)]

    wins = sum(1 for t in sells if (t.pnl_lamports or 0) > 0)
    return {
        "realized_pnl_sol": sum((t.pnl_lamports or 0) for t in sells) / LAMPORTS,
        "unrealized_pnl_sol": open_value - open_cost,
        "open_value_sol": open_value, "open_positions": len(open_rows),
        "trades": len(all_trades), "closed_trades": len(sells),
        "win_rate": round(wins / len(sells) * 100, 1) if sells else None,
        "fees_sol": sum(t.fee_lamports for t in all_trades) / LAMPORTS,
        "best_sol": max(((t.pnl_lamports or 0) for t in sells), default=0) / LAMPORTS,
        "daily": daily,
    }
