import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, engine
from .routers import auth, automation, billing, community, market, trade, wallet
from .services import engine as bot_engine
from .services import solana

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings.assert_production_ready()
    if not solana.is_valid_address(settings.treasury_wallet):
        raise RuntimeError("TREASURY_WALLET is not a valid Solana address")
    Base.metadata.create_all(engine)
    task = asyncio.create_task(bot_engine.run_forever()) if settings.engine_enabled else None
    yield
    if task:
        task.cancel()


app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_methods=["*"], allow_headers=["*"],
)

for module in (auth, wallet, market, trade, automation, billing, community):
    app.include_router(module.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "paper_trading": settings.paper_trading, "treasury": settings.treasury_wallet}
