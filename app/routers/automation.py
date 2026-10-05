"""Auto-sniper configuration and copy-trading targets."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import current_user
from ..models import CopyTarget, SniperConfig, User
from ..plans import plan_of
from ..services import engine, solana

router = APIRouter(prefix="/api", tags=["automation"])


class SniperIn(BaseModel):
    enabled: bool
    buy_sol: float = Field(gt=0, le=100)
    slippage_bps: int = Field(ge=10, le=5000)
    priority_lamports: int = Field(ge=0, le=100_000_000)
    max_open_positions: int = Field(ge=1, le=200)
    min_liquidity_usd: float = Field(ge=0)
    max_liquidity_usd: float = Field(ge=0)
    max_age_minutes: int = Field(ge=1, le=10080)
    min_safety_score: int = Field(ge=0, le=100)
    require_mint_revoked: bool
    require_freeze_revoked: bool
    max_top10_pct: float = Field(gt=0, le=100)
    tp_pct: float | None = Field(default=None, gt=0, le=100000)
    sl_pct: float | None = Field(default=None, gt=0, lt=100)
    trailing_pct: float | None = Field(default=None, gt=0, lt=100)


FIELDS = list(SniperIn.model_fields)


def _config(db: Session, user: User) -> SniperConfig:
    cfg = db.scalar(select(SniperConfig).where(SniperConfig.user_id == user.id))
    if not cfg:
        cfg = SniperConfig(user_id=user.id)
        db.add(cfg)
        db.commit()
    return cfg


@router.get("/sniper/config")
def get_config(user: User = Depends(current_user), db: Session = Depends(get_db)):
    cfg = _config(db, user)
    return {**{f: getattr(cfg, f) for f in FIELDS}, "allowed": plan_of(user)["auto_snipe"]}


@router.put("/sniper/config")
def put_config(body: SniperIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    plan = plan_of(user)
    if body.enabled and not plan["auto_snipe"]:
        raise HTTPException(403, "The auto-sniper needs the Hunter plan or higher")
    if body.trailing_pct and not plan["trailing"]:
        raise HTTPException(403, "Trailing stops need the Apex plan or higher")
    cfg = _config(db, user)
    was_enabled = cfg.enabled
    for field in FIELDS:
        setattr(cfg, field, getattr(body, field))
    if not plan["priority_fees"]:
        cfg.priority_lamports = 0
    db.commit()
    if body.enabled != was_enabled:
        engine.emit(user.id, "info", "Auto-sniper armed" if body.enabled else "Auto-sniper stopped")
    return {**{f: getattr(cfg, f) for f in FIELDS}, "allowed": plan["auto_snipe"]}


@router.get("/sniper/activity")
def activity(user: User = Depends(current_user)):
    return {"events": engine.events_for(user.id)}


# ---------- copy trading ----------

class CopyIn(BaseModel):
    address: str
    label: str = Field(default="", max_length=48)
    buy_sol: float = Field(default=0.05, gt=0, le=100)
    copy_sells: bool = True
    slippage_bps: int = Field(default=1500, ge=10, le=5000)
    enabled: bool = True


def _target_out(t: CopyTarget) -> dict:
    return {"id": t.id, "address": t.address, "label": t.label, "enabled": t.enabled, "buy_sol": t.buy_sol,
            "copy_sells": t.copy_sells, "slippage_bps": t.slippage_bps, "created_at": t.created_at}


@router.get("/copy/targets")
def list_targets(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(CopyTarget).where(CopyTarget.user_id == user.id).order_by(CopyTarget.id)).all()
    return {"targets": [_target_out(t) for t in rows], "limit": plan_of(user)["copy_wallets"]}


@router.post("/copy/targets")
def add_target(body: CopyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limit = plan_of(user)["copy_wallets"]
    if limit == 0:
        raise HTTPException(403, "Copy trading needs the Hunter plan or higher")
    if not solana.is_valid_address(body.address):
        raise HTTPException(400, "Invalid Solana wallet address")
    if body.address == user.wallet.pubkey:
        raise HTTPException(400, "You cannot copy your own trading wallet")
    count = db.scalar(select(func.count(CopyTarget.id)).where(CopyTarget.user_id == user.id)) or 0
    if count >= limit:
        raise HTTPException(403, f"Your plan allows {limit} copied wallets")
    if db.scalar(select(CopyTarget).where(CopyTarget.user_id == user.id, CopyTarget.address == body.address)):
        raise HTTPException(400, "You are already copying this wallet")
    target = CopyTarget(user_id=user.id, **body.model_dump())
    db.add(target)
    db.commit()
    return _target_out(target)


@router.patch("/copy/targets/{target_id}")
def update_target(target_id: int, body: CopyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    target = db.get(CopyTarget, target_id)
    if not target or target.user_id != user.id:
        raise HTTPException(404, "Not found")
    for field in ("label", "buy_sol", "copy_sells", "slippage_bps", "enabled"):
        setattr(target, field, getattr(body, field))
    db.commit()
    return _target_out(target)


@router.delete("/copy/targets/{target_id}")
def delete_target(target_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    target = db.get(CopyTarget, target_id)
    if not target or target.user_id != user.id:
        raise HTTPException(404, "Not found")
    db.delete(target)
    db.commit()
    return {"ok": True}
