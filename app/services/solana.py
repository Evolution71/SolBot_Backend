"""Thin async Solana JSON-RPC client plus keypair and transfer helpers."""
import asyncio
import base64
import time

import httpx
from solders.hash import Hash
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.system_program import TransferParams, transfer
from solders.transaction import VersionedTransaction

from ..config import settings
from ..security import decrypt_secret, encrypt_secret

LAMPORTS = 1_000_000_000
SOL_MINT = "So11111111111111111111111111111111111111112"
RENT_EXEMPT_MIN = 890_880      # lamports an empty system account needs to exist
TX_RESERVE = 3_000_000         # kept back for network fees and token-account rent

_client: httpx.AsyncClient | None = None
_mint_cache: dict[str, tuple[float, dict]] = {}


class RpcError(Exception):
    pass


def client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=20, limits=httpx.Limits(max_keepalive_connections=20))
    return _client


async def rpc(method: str, params: list | None = None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}
    try:
        res = await client().post(settings.solana_rpc_url, json=body)
        data = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise RpcError(f"RPC request failed: {exc}") from exc
    if "error" in data:
        raise RpcError(data["error"].get("message", "RPC error"))
    return data.get("result")


# ---------- keys ----------

def is_valid_address(address: str) -> bool:
    try:
        Pubkey.from_string(address)
        return True
    except (ValueError, TypeError):
        return False


def new_wallet() -> tuple[str, str]:
    """Create a keypair. Returns (public key, encrypted secret)."""
    kp = Keypair()
    return str(kp.pubkey()), encrypt_secret(bytes(kp))


def load_keypair(enc_secret: str) -> Keypair:
    return Keypair.from_bytes(decrypt_secret(enc_secret))


def export_secret(enc_secret: str) -> str:
    """Base58 secret key, importable into Phantom or Solflare."""
    return str(load_keypair(enc_secret))


# ---------- reads ----------

async def get_balance(pubkey: str) -> int:
    res = await rpc("getBalance", [pubkey, {"commitment": "confirmed"}])
    return int(res["value"])


async def get_balances(pubkeys: list[str]) -> list[int]:
    """SOL balances (lamports) of up to 100 accounts in one request. Unfunded accounts report 0."""
    if not pubkeys:
        return []
    res = await rpc("getMultipleAccounts", [pubkeys[:100], {"commitment": "confirmed", "dataSlice": {"offset": 0, "length": 0}}])
    return [int(acc["lamports"]) if acc else 0 for acc in res["value"]]


async def get_mint_info(mint: str) -> dict:
    """Decimals, supply and authorities of a token mint (cached for 60s)."""
    hit = _mint_cache.get(mint)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    res = await rpc("getAccountInfo", [mint, {"encoding": "jsonParsed", "commitment": "confirmed"}])
    try:
        info = res["value"]["data"]["parsed"]["info"]
    except (TypeError, KeyError) as exc:
        raise RpcError("Not a token mint") from exc
    out = {
        "decimals": int(info["decimals"]),
        "supply": int(info["supply"]),
        "mint_authority": info.get("mintAuthority"),
        "freeze_authority": info.get("freezeAuthority"),
    }
    _mint_cache[mint] = (time.time(), out)
    return out


async def get_decimals(mint: str, default: int = 6) -> int:
    try:
        return (await get_mint_info(mint))["decimals"]
    except RpcError:
        return default


async def token_balance(owner: str, mint: str) -> int:
    """Raw token units of `mint` held by `owner` across all its token accounts."""
    res = await rpc("getTokenAccountsByOwner", [owner, {"mint": mint}, {"encoding": "jsonParsed", "commitment": "confirmed"}])
    total = 0
    for acc in res.get("value", []):
        total += int(acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"])
    return total


async def largest_holders(mint: str) -> list[int]:
    res = await rpc("getTokenLargestAccounts", [mint, {"commitment": "confirmed"}])
    return [int(a["amount"]) for a in res.get("value", [])]


async def get_transaction(signature: str) -> dict | None:
    return await rpc("getTransaction", [signature, {
        "encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}])


async def get_signatures(address: str, limit: int = 10) -> list[dict]:
    return await rpc("getSignaturesForAddress", [address, {"limit": limit, "commitment": "confirmed"}]) or []


# ---------- writes ----------

async def send_and_confirm(tx: VersionedTransaction, timeout: float = 45) -> str:
    raw = base64.b64encode(bytes(tx)).decode()
    signature = await rpc("sendTransaction", [raw, {"encoding": "base64", "skipPreflight": False, "maxRetries": 3}])
    deadline = time.time() + timeout
    while time.time() < deadline:
        res = await rpc("getSignatureStatuses", [[signature], {"searchTransactionHistory": False}])
        status = (res or {}).get("value", [None])[0]
        if status:
            if status.get("err"):
                raise RpcError(f"Transaction failed on-chain: {status['err']}")
            if status.get("confirmationStatus") in ("confirmed", "finalized"):
                return signature
        await asyncio.sleep(0.6)
    raise RpcError(f"Transaction {signature} was sent but not confirmed in time - check it on Solscan before retrying")


async def transfer_sol(kp: Keypair, transfers: list[tuple[str, int]]) -> str:
    """Send SOL from `kp` to one or more recipients in a single transaction."""
    ixs = [
        transfer(TransferParams(from_pubkey=kp.pubkey(), to_pubkey=Pubkey.from_string(to), lamports=int(amount)))
        for to, amount in transfers if amount > 0
    ]
    if not ixs:
        raise RpcError("Nothing to transfer")
    latest = await rpc("getLatestBlockhash", [{"commitment": "confirmed"}])
    blockhash = Hash.from_string(latest["value"]["blockhash"])
    msg = MessageV0.try_compile(kp.pubkey(), ixs, [], blockhash)
    return await send_and_confirm(VersionedTransaction(msg, [kp]))

