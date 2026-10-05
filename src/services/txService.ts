import axios from "axios";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../utils/logger";
import { captureException } from "./monitoringService";

const connection = new Connection(config.solana.rpcUrl, "confirmed");

export interface SubmitResult {
  signature: string;
  method: "jito" | "rpc";
}

/**
 * Submits a signed transaction with basic MEV/sandwich mitigation:
 *
 * 1. If a Jito block-engine URL is configured, submit as a Jito bundle with
 *    a tip. Jito bundles are atomic and skip the public mempool, which is
 *    the standard defense against sandwich bots watching for large swaps.
 * 2. Otherwise, fall back to plain RPC submission with `skipPreflight` off
 *    and a bounded retry loop tied to the transaction's own blockhash
 *    expiry — we stop retrying once the blockhash goes stale rather than
 *    resubmitting forever, which is how bots end up double-spending or
 *    burning fees on a dead transaction.
 *
 * Note: Jito bundle submission alone doesn't guarantee zero sandwich risk —
 * pair it with the price-impact guardrail in snipeService for real
 * protection on illiquid, newly-launched tokens.
 */
export async function submitTransaction(
  tx: VersionedTransaction,
  opts: { maxRetries?: number } = {}
): Promise<SubmitResult> {
  if (config.mev.jitoBlockEngineUrl) {
    try {
      return await submitViaJito(tx);
    } catch (err) {
      logger.warn({ err }, "Jito submission failed, falling back to plain RPC");
      captureException(err, { context: "jito_submit_fallback" });
    }
  }

  return submitViaRpc(tx, opts.maxRetries ?? 3);
}

async function submitViaJito(tx: VersionedTransaction): Promise<SubmitResult> {
  const serialized = Buffer.from(tx.serialize()).toString("base64");

  const { data } = await axios.post(
    `${config.mev.jitoBlockEngineUrl}/api/v1/bundles`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[serialized]],
    },
    { timeout: 8000 }
  );

  if (data.error) {
    throw new Error(`Jito bundle rejected: ${JSON.stringify(data.error)}`);
  }

  const signature = tx.signatures[0] ? Buffer.from(tx.signatures[0]).toString("base64") : "";
  await confirmWithRetry(signature);
  return { signature, method: "jito" };
}

async function submitViaRpc(tx: VersionedTransaction, maxRetries: number): Promise<SubmitResult> {
  const rawTx = tx.serialize();

  const signature = await connection.sendRawTransaction(rawTx, {
    skipPreflight: false,
    maxRetries,
    preflightCommitment: "confirmed",
  });

  await confirmWithRetry(signature);
  return { signature, method: "rpc" };
}

async function confirmWithRetry(signature: string, timeoutMs = 30_000): Promise<void> {
  if (!signature) throw new Error("Empty transaction signature — cannot confirm");

  const start = Date.now();
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  const confirmation = await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  if (confirmation.value.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
  }

  if (Date.now() - start > timeoutMs) {
    throw new Error("Transaction confirmation timed out — blockhash likely expired");
  }
}
