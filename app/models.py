from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base, now


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    plan: Mapped[str] = mapped_column(String(16), default="free")
    plan_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    fee_free_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    referral_code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    referred_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    referral_reward_granted: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)

    wallet: Mapped["Wallet"] = relationship(back_populates="user", uselist=False)


class Wallet(Base):
    """A dedicated trading wallet. The secret key is stored encrypted and is exportable by its owner."""
    __tablename__ = "wallets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    pubkey: Mapped[str] = mapped_column(String(64), unique=True)
    enc_secret: Mapped[str] = mapped_column(Text)
    paper_lamports: Mapped[int] = mapped_column(BigInteger, default=0)

    user: Mapped[User] = relationship(back_populates="wallet")


class Payment(Base):
    """A plan invoice paid in SOL to the treasury wallet and verified on-chain."""
    __tablename__ = "payments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    plan: Mapped[str] = mapped_column(String(16))
    usd: Mapped[float] = mapped_column(Float)
    lamports: Mapped[int] = mapped_column(BigInteger)  # exact amount, unique per invoice
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending | confirmed | expired
    signature: Mapped[str | None] = mapped_column(String(128), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Position(Base):
    __tablename__ = "positions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    mint: Mapped[str] = mapped_column(String(64), index=True)
    symbol: Mapped[str] = mapped_column(String(32), default="")
    name: Mapped[str] = mapped_column(String(128), default="")
    image: Mapped[str] = mapped_column(String(512), default="")
    decimals: Mapped[int] = mapped_column(Integer, default=6)
    token_amount: Mapped[str] = mapped_column(String(40), default="0")  # raw units still held
    cost_lamports: Mapped[int] = mapped_column(BigInteger, default=0)   # cost of what is still held, fees included
    entry_price_sol: Mapped[float] = mapped_column(Float, default=0.0)
    peak_price_sol: Mapped[float] = mapped_column(Float, default=0.0)
    tp_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    sl_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    trailing_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    realized_pnl_lamports: Mapped[int] = mapped_column(BigInteger, default=0)
    status: Mapped[str] = mapped_column(String(8), default="open", index=True)  # open | closed
    source: Mapped[str] = mapped_column(String(12), default="manual")           # manual | sniper | copy
    paper: Mapped[bool] = mapped_column(Boolean, default=True)
    opened_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Trade(Base):
    __tablename__ = "trades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    position_id: Mapped[int] = mapped_column(ForeignKey("positions.id"), index=True)
    side: Mapped[str] = mapped_column(String(4))  # buy | sell
    mint: Mapped[str] = mapped_column(String(64))
    symbol: Mapped[str] = mapped_column(String(32), default="")
    sol_lamports: Mapped[int] = mapped_column(BigInteger)  # SOL spent (buy) or received (sell), before fee
    token_amount: Mapped[str] = mapped_column(String(40))
    price_sol: Mapped[float] = mapped_column(Float, default=0.0)
    fee_lamports: Mapped[int] = mapped_column(BigInteger, default=0)
    referral_lamports: Mapped[int] = mapped_column(BigInteger, default=0)
    pnl_lamports: Mapped[int | None] = mapped_column(BigInteger, nullable=True)  # sells only
    signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    fee_signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    source: Mapped[str] = mapped_column(String(12), default="manual")
    reason: Mapped[str] = mapped_column(String(32), default="")
    paper: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)


class SniperConfig(Base):
    __tablename__ = "sniper_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    buy_sol: Mapped[float] = mapped_column(Float, default=0.05)
    slippage_bps: Mapped[int] = mapped_column(Integer, default=1500)
    priority_lamports: Mapped[int] = mapped_column(BigInteger, default=0)
    max_open_positions: Mapped[int] = mapped_column(Integer, default=5)
    min_liquidity_usd: Mapped[float] = mapped_column(Float, default=10000)
    max_liquidity_usd: Mapped[float] = mapped_column(Float, default=0)  # 0 = no ceiling
    max_age_minutes: Mapped[int] = mapped_column(Integer, default=60)
    min_safety_score: Mapped[int] = mapped_column(Integer, default=70)
    require_mint_revoked: Mapped[bool] = mapped_column(Boolean, default=True)
    require_freeze_revoked: Mapped[bool] = mapped_column(Boolean, default=True)
    max_top10_pct: Mapped[float] = mapped_column(Float, default=60)
    tp_pct: Mapped[float | None] = mapped_column(Float, default=50, nullable=True)
    sl_pct: Mapped[float | None] = mapped_column(Float, default=25, nullable=True)
    trailing_pct: Mapped[float | None] = mapped_column(Float, nullable=True)


class CopyTarget(Base):
    __tablename__ = "copy_targets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    address: Mapped[str] = mapped_column(String(64))
    label: Mapped[str] = mapped_column(String(48), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    buy_sol: Mapped[float] = mapped_column(Float, default=0.05)
    copy_sells: Mapped[bool] = mapped_column(Boolean, default=True)
    slippage_bps: Mapped[int] = mapped_column(Integer, default=1500)
    last_signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
