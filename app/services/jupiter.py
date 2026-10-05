"""Swap routing and execution through the Jupiter Swap V2 API (/order + /execute)."""
import base64

import httpx
from solders.keypair import Keypair
from solders.message import to_bytes_versioned
from solders.transaction import VersionedTransaction

from ..config import settings
from . import solana


class SwapError(Exception):
    pass


def _headers() -> dict:
    return {"x-api-key": settings.jupiter_api_key} if settings.jupiter_api_key else {}


def sign_order(kp: Keypair, b64_tx: str) -> str:
    """Add our signature to an order transaction without disturbing any other signer's slot."""
    tx = VersionedTransaction.from_bytes(base64.b64decode(b64_tx))
    keys = list(tx.message.account_keys)
    if kp.pubkey() not in keys:
        raise SwapError("Order transaction is not for this wallet")
    signatures = list(tx.signatures)
    signatures[keys.index(kp.pubkey())] = kp.sign_message(to_bytes_versioned(tx.message))
    return base64.b64encode(bytes(VersionedTransaction.populate(tx.message, signatures))).decode()


async def _call(method: str, path: str, **kwargs) -> dict:
    try:
        res = await solana.client().request(method, settings.jupiter_api_url + path, headers=_headers(),
                                            timeout=45, **kwargs)
        data = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise SwapError(f"Could not reach Jupiter: {exc}") from exc
    if res.status_code in (401, 403):
        raise SwapError("Jupiter rejected the API key - check JUPITER_API_KEY")
    if not isinstance(data, dict):
        raise SwapError("Unexpected response from Jupiter")
    return data


async def execute_swap(kp: Keypair, input_mint: str, output_mint: str, amount: int,
                       slippage_bps: int, priority_lamports: int = 0) -> tuple[str, int]:
    """Swap `amount` raw units of input for output. Returns (signature, raw output amount received)."""
    params = {"inputMint": input_mint, "outputMint": output_mint, "amount": str(int(amount)),
              "taker": str(kp.pubkey()), "slippageBps": int(slippage_bps)}
    if priority_lamports > 0:
        params["priorityFeeLamports"] = int(priority_lamports)
    order = await _call("GET", "/order", params=params)
    if not order.get("transaction"):
        raise SwapError(order.get("errorMessage") or order.get("error") or "No swap route for this token yet")

    result = await _call("POST", "/execute", json={
        "signedTransaction": sign_order(kp, order["transaction"]), "requestId": order["requestId"]})
    if result.get("status") != "Success" or not result.get("signature"):
        detail = result.get("error") or f"code {result.get('code')}"
        sig = f" (tx {result['signature']})" if result.get("signature") else ""
        raise SwapError(f"Swap failed: {detail}{sig}")
    received = int(result.get("totalOutputAmount") or result.get("outputAmountResult") or order.get("outAmount") or 0)
    return result["signature"], received
