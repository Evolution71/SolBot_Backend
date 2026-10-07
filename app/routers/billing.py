"""Plan purchases. Paid in SOL straight to the treasury wallet and verified on-chain."""
import secrets
from datetime import timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, now
from ..deps import current_user
from ..models import Payment, User
from ..plans import PLAN_DAYS, PLANS, TRIAL_DAYS, TRIAL_PLAN, effective_plan_id
from ..services import market, solana

router = APIRouter(prefix="/api/billing", tags=["billing"])

INVOICE_MINUTES = 30


class InvoiceIn(BaseModel):
    plan: str


class VerifyIn(BaseModel):
    signature: str


def payment_out(p: Payment) -> dict:
    return {"id": p.id, "plan": p.plan, "plan_name": PLANS[p.plan]["name"], "usd": p.usd, "lamports": p.lamports,
            "sol": p.lamports / solana.LAMPORTS, "status": p.status, "signature": p.signature,
            "treasury": settings.treasury_wallet, "created_at": p.created_at, "expires_at": p.expires_at,
            "confirmed_at": p.confirmed_at}


def activate(user: User, plan_id: str) -> None:
    base = user.plan_expires_at if effective_plan_id(user) == plan_id and user.plan_expires_at else now()
    user.plan = plan_id
    user.plan_expires_at = base + timedelta(days=PLAN_DAYS)


@router.get("/plans")
async def plans():
    return {"plans": list(PLANS.values()), "treasury": settings.treasury_wallet,
            "sol_usd": await market.sol_price_usd(), "days": PLAN_DAYS,
            "trial": {"plan": TRIAL_PLAN, "plan_name": PLANS[TRIAL_PLAN]["name"], "days": TRIAL_DAYS}}


@router.post("/trial")
def start_trial(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """One free trial per account. No payment is taken and nothing renews automatically."""
    if user.trial_used:
        raise HTTPException(400, "You have already used your free trial")
    if effective_plan_id(user) != "free":
        raise HTTPException(400, "You already have an active paid plan")
    user.trial_used = True
    user.plan = TRIAL_PLAN
    user.plan_expires_at = now() + timedelta(days=TRIAL_DAYS)
    db.commit()
    return {"plan": TRIAL_PLAN, "plan_name": PLANS[TRIAL_PLAN]["name"], "expires_at": user.plan_expires_at}


@router.post("/invoice")
async def create_invoice(body: InvoiceIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    plan = PLANS.get(body.plan)
    if not plan or plan["price_usd"] <= 0:
        raise HTTPException(400, "Unknown plan")
    sol_usd = await market.sol_price_usd()
    if sol_usd <= 0:
        raise HTTPException(503, "SOL price is unavailable right now - try again in a moment")
    # A few random lamports make every invoice amount unique, so a payment can only settle its own invoice.
    lamports = int(plan["price_usd"] / sol_usd * solana.LAMPORTS) // 100_000 * 100_000 + secrets.randbelow(99_999) + 1
    payment = Payment(user_id=user.id, plan=plan["id"], usd=plan["price_usd"], lamports=lamports,
                      expires_at=now() + timedelta(minutes=INVOICE_MINUTES))
    db.add(payment)
    db.commit()
    return payment_out(payment)


def _pending(db: Session, user: User, invoice_id: int) -> Payment:
    payment = db.get(Payment, invoice_id)
    if not payment or payment.user_id != user.id:
        raise HTTPException(404, "Invoice not found")
    if payment.status == "confirmed":
        raise HTTPException(400, "This invoice is already paid")
    return payment


async def _verify(db: Session, user: User, payment: Payment, signature: str) -> Payment:
    signature = signature.strip()
    if db.scalar(select(Payment).where(Payment.signature == signature)):
        raise HTTPException(400, "This transaction has already been used")
    try:
        tx = await solana.get_transaction(signature)
    except solana.RpcError as exc:
        raise HTTPException(502, f"Could not check the transaction: {exc}") from exc
    if not tx:
        raise HTTPException(404, "Transaction not found yet - wait a few seconds and verify again")
    meta = tx.get("meta") or {}
    if meta.get("err"):
        raise HTTPException(400, "That transaction failed on-chain")
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in tx["transaction"]["message"]["accountKeys"]]
    if settings.treasury_wallet not in keys:
        raise HTTPException(400, "That transaction did not pay the Nexus treasury wallet")
    idx = keys.index(settings.treasury_wallet)
    received = meta["postBalances"][idx] - meta["preBalances"][idx]
    if received != payment.lamports:
        raise HTTPException(400, f"Amount mismatch: invoice is exactly {payment.lamports / solana.LAMPORTS:.9f} SOL, "
                                 f"transaction paid {received / solana.LAMPORTS:.9f} SOL")
    block_time = tx.get("blockTime")
    if block_time and block_time < payment.created_at.replace(tzinfo=timezone.utc).timestamp() - 300:
        raise HTTPException(400, "That transaction is older than this invoice")
    payment.status, payment.signature, payment.confirmed_at = "confirmed", signature, now()
    user = db.merge(user)
    activate(user, payment.plan)
    db.commit()
    return payment


@router.post("/invoice/{invoice_id}/verify")
async def verify(invoice_id: int, body: VerifyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Confirm a payment sent from any external wallet by its transaction signature."""
    return payment_out(await _verify(db, user, _pending(db, user, invoice_id), body.signature))


@router.post("/invoice/{invoice_id}/pay")
async def pay_from_wallet(invoice_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Pay the invoice in one click from the user's own trading wallet."""
    payment = _pending(db, user, invoice_id)
    if payment.expires_at < now():
        raise HTTPException(400, "Invoice expired - create a new one for a fresh SOL price")
    wallet = user.wallet
    try:
        balance = await solana.get_balance(wallet.pubkey)
        if balance < payment.lamports + 10_000:
            raise HTTPException(400, f"Your trading wallet holds {balance / solana.LAMPORTS:.4f} SOL - "
                                     f"deposit at least {payment.lamports / solana.LAMPORTS:.4f} SOL first")
        signature = await solana.transfer_sol(solana.load_keypair(wallet.enc_secret),
                                              [(settings.treasury_wallet, payment.lamports)])
    except solana.RpcError as exc:
        raise HTTPException(502, str(exc)) from exc
    return payment_out(await _verify(db, user, payment, signature))


@router.get("/payments")
def payments(user: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.scalars(select(Payment).where(Payment.user_id == user.id)
                      .order_by(Payment.created_at.desc()).limit(50)).all()
    return {"payments": [payment_out(p) for p in rows]}
