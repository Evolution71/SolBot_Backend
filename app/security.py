"""Password hashing, JWT sessions and at-rest encryption of wallet secret keys."""
import base64
import hashlib
import logging
from datetime import timedelta

import bcrypt
import jwt
from cryptography.fernet import Fernet

from .config import settings
from .database import now

log = logging.getLogger("nexus.security")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode()[:72], bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode()[:72], hashed.encode())
    except ValueError:
        return False


def create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": now() + timedelta(minutes=settings.jwt_expire_minutes)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def decode_token(token: str) -> int | None:
    try:
        return int(jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def _fernet() -> Fernet:
    key = settings.wallet_encryption_key
    if not key:
        # Development fallback only; config.assert_production_ready() blocks live trading without a real key.
        log.warning("WALLET_ENCRYPTION_KEY is not set - deriving a development key from JWT_SECRET")
        key = base64.urlsafe_b64encode(hashlib.sha256(settings.jwt_secret.encode()).digest()).decode()
    return Fernet(key.encode())


def encrypt_secret(raw: bytes) -> str:
    return _fernet().encrypt(raw).decode()


def decrypt_secret(token: str) -> bytes:
    return _fernet().decrypt(token.encode())
