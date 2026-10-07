"""Referrals, the weekly leaderboard and the admin console."""
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, now
from ..deps import admin_user, current_user
from ..models import Payment, Position, Trade, User
from ..plans import PLAN_DAYS, PLANS, effective_plan_id
from ..services.solana import LAMPORTS

router = APIRouter(prefix="/api", tags=["community"])


@router.get("/referral")
def referral(user: User = Depends(current_user), db: Session = Depends(get_db)):
    referees = db.scalars(select(User).where(User.referred_by_id == user.id).order_by(User.created_at.desc())).all()
    ids = [r.id for r in referees]
    traded = set(db.scalars(select(Trade.user_id).where(Trade.user_id.in_(ids)).distinct())) if ids else set()
    earned = db.scalar(select(func.coalesce(func.sum(Trade.referral_lamports), 0))
                       .where(Trade.user_id.in_(ids))) if ids else 0
    return {
        "code": user.referral_code,
        "link": f"{settings.frontend_url.rstrip('/')}/register?ref={user.referral_code}",
        "share_pct": settings.referral_share * 100,
        "signed_up": len(referees), "active": len(traded),
        "unlock_at": settings.referral_unlock_count, "reward_granted": user.referral_reward_granted,
        "earned_sol": (earned or 0) / LAMPORTS,
        "referees": [{"username": r.username, "joined": r.created_at, "active": r.id in traded} for r in referees[:50]],
    }


@router.get("/leaderboard")
def leaderboard(db: Session = Depends(get_db)):
    """Top realized profit over the last 7 days. Public."""
    since = now() - timedelta(days=7)
    pnl = func.sum(Trade.pnl_lamports)
    rows = db.execute(
        select(User.username, pnl, func.count(Trade.id))
        .join(User, User.id == Trade.user_id)
        .where(Trade.side == "sell", Trade.created_at >= since, Trade.paper == settings.paper_trading)
        .group_by(User.id).order_by(pnl.desc()).limit(25)).all()
    return {"paper": settings.paper_trading, "since": since,
            "rows": [{"rank": i + 1, "username": name, "pnl_sol": (total or 0) / LAMPORTS, "trades": count}
                     for i, (name, total, count) in enumerate(rows)]}


@router.get("/stats")
def public_stats(db: Session = Depends(get_db)):
    """Real platform totals for the landing page. Live trades only - practice trades are never counted."""
    live = Trade.paper.is_(False)
    volume = db.scalar(select(func.coalesce(func.sum(Trade.sol_lamports), 0)).where(live)) or 0
    return {"paper_trading": settings.paper_trading,
            "users": db.scalar(select(func.count(User.id))) or 0,
            "trades": db.scalar(select(func.count(Trade.id)).where(live)) or 0,
            "volume_sol": volume / LAMPORTS}


# ---------- admin ----------

class PlanIn(BaseModel):
    plan: str
    days: int = PLAN_DAYS


class ActiveIn(BaseModel):
    is_active: bool


@router.get("/admin/overview")
def overview(_: User = Depends(admin_user), db: Session = Depends(get_db)):
    users = db.scalars(select(User)).all()
    by_plan = {pid: 0 for pid in PLANS}
    for u in users:
        by_plan[effective_plan_id(u)] += 1
    live = Trade.paper.is_(False)
    paid = db.execute(select(func.coalesce(func.sum(Payment.lamports), 0), func.coalesce(func.sum(Payment.usd), 0),
                             func.count(Payment.id)).where(Payment.status == "confirmed")).one()
    fees = db.scalar(select(func.coalesce(func.sum(Trade.fee_lamports - Trade.referral_lamports), 0))
                     .where(live, Trade.fee_signature.is_not(None)))
    week = now() - timedelta(days=7)
    return {
        "treasury": settings.treasury_wallet, "paper_trading": settings.paper_trading,
        "users": len(users), "users_7d": sum(1 for u in users if u.created_at >= week), "by_plan": by_plan,
        "plan_revenue_sol": paid[0] / LAMPORTS, "plan_revenue_usd": paid[1], "payments": paid[2],
        "fee_revenue_sol": (fees or 0) / LAMPORTS,
        "trades": db.scalar(select(func.count(Trade.id))) or 0,
        "live_trades": db.scalar(select(func.count(Trade.id)).where(live)) or 0,
        "open_positions": db.scalar(select(func.count(Position.id)).where(Position.status == "open")) or 0,
    }


@router.get("/admin/users")
def admin_users(q: str = "", _: User = Depends(admin_user), db: Session = Depends(get_db)):
    query = select(User).order_by(User.created_at.desc()).limit(200)
    if q:
        like = f"%{q.lower()}%"
        query = query.where(func.lower(User.email).like(like) | func.lower(User.username).like(like))
    return {"users": [{
        "id": u.id, "email": u.email, "username": u.username, "plan": effective_plan_id(u),
        "plan_expires_at": u.plan_expires_at, "is_active": u.is_active, "is_admin": u.is_admin,
        "wallet": u.wallet.pubkey if u.wallet else None, "wallets": len(u.wallets), "created_at": u.created_at,
    } for u in db.scalars(query).all()]}


@router.get("/admin/payments")
def admin_payments(_: User = Depends(admin_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Payment, User.username).join(User, User.id == Payment.user_id)
                      .order_by(Payment.created_at.desc()).limit(200)).all()
    return {"payments": [{"id": p.id, "username": name, "plan": p.plan, "usd": p.usd, "sol": p.lamports / LAMPORTS,
                          "status": p.status, "signature": p.signature, "created_at": p.created_at}
                         for p, name in rows]}


@router.post("/admin/users/{user_id}/plan")
def set_plan(user_id: int, body: PlanIn, _: User = Depends(admin_user), db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if not target or body.plan not in PLANS:
        raise HTTPException(404, "Unknown user or plan")
    target.plan = body.plan
    target.plan_expires_at = None if body.plan == "free" else now() + timedelta(days=max(1, body.days))
    db.commit()
    return {"ok": True}


@router.post("/admin/users/{user_id}/active")
def set_active(user_id: int, body: ActiveIn, admin: User = Depends(admin_user), db: Session = Depends(get_db)):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(404, "Unknown user")
    if target.id == admin.id:
        raise HTTPException(400, "You cannot suspend yourself")
    target.is_active = body.is_active
    db.commit()
    return {"ok": True}
