import re
import secrets
import time
from collections import defaultdict
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, now
from ..deps import current_user
from ..models import SniperConfig, User, Wallet
from ..plans import effective_plan_id, fee_bps_for, plan_of
from ..security import create_token, hash_password, verify_password
from ..services import solana

router = APIRouter(prefix="/api/auth", tags=["auth"])

_attempts: dict[str, list[float]] = defaultdict(list)


def _throttle(key: str, limit: int = 8, window: int = 300) -> None:
    recent = [t for t in _attempts[key] if time.time() - t < window]
    if len(recent) >= limit:
        raise HTTPException(429, "Too many attempts - wait a few minutes and try again")
    recent.append(time.time())
    _attempts[key] = recent


class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(min_length=3, max_length=20)
    password: str = Field(min_length=8, max_length=128)
    referral_code: str | None = None


class LoginIn(BaseModel):
    email: EmailStr
    password: str


def user_out(user: User) -> dict:
    plan = plan_of(user)
    return {
        "id": user.id, "email": user.email, "username": user.username, "is_admin": user.is_admin,
        "plan": effective_plan_id(user), "plan_name": plan["name"], "plan_expires_at": user.plan_expires_at,
        "limits": {k: plan[k] for k in ("daily_buys", "max_positions", "auto_snipe", "tp_sl", "trailing",
                                        "copy_wallets", "priority_fees")},
        "fee_bps": fee_bps_for(user), "fee_free_until": user.fee_free_until,
        "referral_code": user.referral_code, "wallet": user.wallet.pubkey if user.wallet else None,
        "paper_trading": settings.paper_trading, "created_at": user.created_at,
    }


@router.post("/register")
def register(body: RegisterIn, request: Request, db: Session = Depends(get_db)):
    _throttle(f"reg:{request.client.host if request.client else '?'}", limit=10, window=3600)
    email = body.email.lower()
    if not re.fullmatch(r"[A-Za-z0-9_]+", body.username):
        raise HTTPException(400, "Username may only contain letters, numbers and underscores")
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(400, "An account with this email already exists")
    if db.scalar(select(User).where(func.lower(User.username) == body.username.lower())):
        raise HTTPException(400, "That username is taken")

    referrer = None
    if body.referral_code:
        referrer = db.scalar(select(User).where(User.referral_code == body.referral_code.strip().upper()))

    user = User(
        email=email, username=body.username, password_hash=hash_password(body.password),
        referral_code=secrets.token_hex(4).upper(), referred_by_id=referrer.id if referrer else None,
        is_admin=bool(settings.admin_email) and email == settings.admin_email.lower())
    db.add(user)
    db.flush()
    if user.id <= settings.launch_promo_users:
        user.fee_free_until = now() + timedelta(days=settings.launch_promo_days)
    pubkey, enc_secret = solana.new_wallet()
    db.add(Wallet(user_id=user.id, pubkey=pubkey, enc_secret=enc_secret,
                  paper_lamports=int(settings.paper_start_sol * solana.LAMPORTS)))
    db.add(SniperConfig(user_id=user.id))
    db.commit()
    db.refresh(user)
    return {"token": create_token(user.id), "user": user_out(user)}


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    _throttle(f"login:{body.email.lower()}:{request.client.host if request.client else '?'}")
    user = db.scalar(select(User).where(User.email == body.email.lower()))
    if not user or not verify_password(body.password, user.password_hash) or not user.is_active:
        raise HTTPException(401, "Incorrect email or password")
    return {"token": create_token(user.id), "user": user_out(user)}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user_out(user)
