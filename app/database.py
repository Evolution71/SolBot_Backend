from datetime import datetime, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import StaticPool

from .config import settings


def now() -> datetime:
    """Naive UTC timestamp (what every DateTime column stores)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


_kwargs: dict = {"pool_pre_ping": True}
if settings.db_url.startswith("sqlite"):
    _kwargs["connect_args"] = {"check_same_thread": False}
    if ":memory:" in settings.db_url:
        _kwargs["poolclass"] = StaticPool

engine = create_engine(settings.db_url, **_kwargs)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
