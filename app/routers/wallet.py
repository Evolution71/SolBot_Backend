from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import current_user
from ..models import Position, User, Wallet
from ..plans import plan_of
from ..security import verify_password
from ..services import market, solana

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


class WithdrawIn(BaseModel):
    address: str
    sol: float = Field(gt=0)
    password: str


class PasswordIn(BaseModel):
    password: str


class CreateIn(BaseModel):
    label: str = Field(min_length=1, max_length=32)


class UpdateIn(BaseModel):
    label: str | None = Field(default=None, min_length=1, max_length=32)
    is_default: bool | None = None


def _owned(db: Session, user: User, wallet_id: int) -> Wallet:
    wallet = db.get(Wallet, wallet_id)
    if not wallet or wallet.user_id != user.id:
        raise HTTPException(404, "Wallet not found")
    return wallet


@router.get("")
async def list_wallets(user: User = Depends(current_user)):
    wallets = user.wallets
    chain: list[int] | None = None
    try:
        chain = await solana.get_balances([w.pubkey for w in wallets])
    except solana.RpcError:
        pass
    rows = []
    for i, w in enumerate(wallets):
        chain_lamports = None if chain is None else chain[i]
        lamports = w.paper_lamports if settings.paper_trading else (chain_lamports or 0)
        rows.append({"id": w.id, "label": w.label, "address": w.pubkey, "is_default": w.is_default,
                     "sol": lamports / solana.LAMPORTS,
                     "chain_sol": None if chain_lamports is None else chain_lamports / solana.LAMPORTS})
    default = user.wallet
    return {
        "wallets": rows, "limit": plan_of(user)["wallets"],
        "sol": sum(r["sol"] for r in rows),                     # total across wallets
        "address": default.pubkey if default else None,          # default wallet
        "paper_trading": settings.paper_trading, "rpc_ok": chain is not None,
        "sol_usd": await market.sol_price_usd(),
    }


@router.post("")
def create_wallet(body: CreateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limit = plan_of(user)["wallets"]
    if len(user.wallets) >= limit:
        raise HTTPException(403, f"Your plan allows {limit} wallet{'s' if limit != 1 else ''} - upgrade to add more")
    pubkey, enc_secret = solana.new_wallet()
    wallet = Wallet(user_id=user.id, label=body.label.strip(), is_default=False, pubkey=pubkey, enc_secret=enc_secret,
                    paper_lamports=int(settings.paper_start_sol * solana.LAMPORTS))
    db.add(wallet)
    db.commit()
    return {"id": wallet.id, "label": wallet.label, "address": wallet.pubkey}


@router.patch("/{wallet_id}")
def update_wallet(wallet_id: int, body: UpdateIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    wallet = _owned(db, user, wallet_id)
    if body.label:
        wallet.label = body.label.strip()
    if body.is_default:
        for other in user.wallets:
            other.is_default = other.id == wallet.id
    db.commit()
    return {"ok": True}


@router.post("/{wallet_id}/withdraw")
async def withdraw(wallet_id: int, body: WithdrawIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(403, "Incorrect password")
    if not solana.is_valid_address(body.address):
        raise HTTPException(400, "Invalid Solana address")
    wallet = _owned(db, user, wallet_id)
    lamports = int(body.sol * solana.LAMPORTS)
    try:
        balance = await solana.get_balance(wallet.pubkey)
        if lamports + 10_000 > balance:
            raise HTTPException(400, f"Insufficient balance - you can withdraw up to "
                                     f"{max(0, balance - 10_000) / solana.LAMPORTS:.6f} SOL from {wallet.label}")
        signature = await solana.transfer_sol(solana.load_keypair(wallet.enc_secret), [(body.address, lamports)])
    except solana.RpcError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"signature": signature}


@router.post("/{wallet_id}/export")
def export_key(wallet_id: int, body: PasswordIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """The wallet belongs to the user: they can always take the key and leave."""
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(403, "Incorrect password")
    wallet = _owned(db, user, wallet_id)
    return {"address": wallet.pubkey, "secret_key": solana.export_secret(wallet.enc_secret)}


@router.post("/paper-reset")
def paper_reset(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not settings.paper_trading:
        raise HTTPException(400, "Only available in paper trading mode")
    for wallet in user.wallets:
        wallet.paper_lamports = int(settings.paper_start_sol * solana.LAMPORTS)
    for position in db.scalars(select(Position).where(Position.user_id == user.id, Position.status == "open")):
        position.status = "closed"
    db.commit()
    return {"sol": settings.paper_start_sol}
