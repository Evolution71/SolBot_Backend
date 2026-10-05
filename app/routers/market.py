from fastapi import APIRouter, HTTPException

from ..services import market, safety, solana

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/feed")
async def feed(kind: str = "new"):
    return {"tokens": await market.feed(kind), "sol_usd": await market.sol_price_usd()}


@router.get("/search")
async def search(q: str):
    return {"tokens": await market.search(q[:64])}


@router.get("/token/{mint}")
async def token(mint: str):
    if not solana.is_valid_address(mint):
        raise HTTPException(400, "Invalid token address")
    data = await market.get_token(mint)
    if not data:
        raise HTTPException(404, "No SOL liquidity pool found for this token")
    return {"token": data, "safety": await safety.check(mint, data), "sol_usd": await market.sol_price_usd()}
