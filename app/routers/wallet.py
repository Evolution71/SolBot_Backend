from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import current_user
from ..models import Position, User
from ..security import verify_password
from ..services import market, solana

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


class WithdrawIn(BaseModel):
    address: str
    sol: float = Field(gt=0)
    password: str


class PasswordIn(BaseModel):
    password: str


@router.get("")
async def get_wallet(user: User = Depends(current_user)):
    wallet = user.wallet
    chain_lamports = None
    try:
        chain_lamports = await solana.get_balance(wallet.pubkey)
    except solana.RpcError:
        pass
    lamports = wallet.paper_lamports if settings.paper_trading else (chain_lamports or 0)
    return {
        "address": wallet.pubkey, "paper_trading": settings.paper_trading,
        "lamports": lamports, "sol": lamports / solana.LAMPORTS,
        "chain_sol": None if chain_lamports is None else chain_lamports / solana.LAMPORTS,
        "sol_usd": await market.sol_price_usd(),
        "rpc_ok": chain_lamports is not None,
    }


@router.post("/withdraw")
async def withdraw(body: WithdrawIn, user: User = Depends(current_user)):
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(403, "Incorrect password")
    if not solana.is_valid_address(body.address):
        raise HTTPException(400, "Invalid Solana address")
    wallet = user.wallet
    lamports = int(body.sol * solana.LAMPORTS)
    try:
        balance = await solana.get_balance(wallet.pubkey)
        if lamports + 10_000 > balance:
            raise HTTPException(400, f"Insufficient balance - you can withdraw up to "
                                     f"{max(0, balance - 10_000) / solana.LAMPORTS:.6f} SOL")
        signature = await solana.transfer_sol(solana.load_keypair(wallet.enc_secret), [(body.address, lamports)])
    except solana.RpcError as exc:
        raise HTTPException(502, str(exc)) from exc
    return {"signature": signature}


@router.post("/export")
def export_key(body: PasswordIn, user: User = Depends(current_user)):
    """The wallet belongs to the user: they can always take the key and leave."""
    if not verify_password(body.password, user.password_hash):
        raise HTTPException(403, "Incorrect password")
    return {"address": user.wallet.pubkey, "secret_key": solana.export_secret(user.wallet.enc_secret)}


@router.post("/paper-reset")
def paper_reset(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not settings.paper_trading:
        raise HTTPException(400, "Only available in paper trading mode")
    wallet = db.merge(user.wallet)
    wallet.paper_lamports = int(settings.paper_start_sol * solana.LAMPORTS)
    for position in db.scalars(select(Position).where(Position.user_id == user.id, Position.status == "open")):
        position.status = "closed"
    db.commit()
    return {"sol": settings.paper_start_sol}
