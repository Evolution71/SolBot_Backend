import axios from "axios";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { config } from "../config";
import { logger } from "../utils/logger";
import { submitTransaction } from "./txService";
import { captureException } from "./monitoringService";
import {
  appendFeeTransfer,
  computeBuyFeeLamports,
  computeSellFeeLamports,
  getFeeWallet,
} from "./feeService";

const connection = new Connection(config.solana.rpcUrl, "confirmed");

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;

export interface SwapResult {
  signature: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  outputDecimals: number;
  submissionMethod: "jito" | "rpc";
  feeLamports: number;
}

export interface SwapPreview {
  side: "buy" | "sell";
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  feeLamports: number;
  feeBps: number;
  outputDecimals: number;
}

interface QuoteResponse {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  routePlan: unknown[];
  [key: string]: unknown;
}

export class PriceImpactTooHighError extends Error {
  constructor(public readonly priceImpactPct: number, public readonly maxAllowedPct: number) {
    super(
      `Price impact ${priceImpactPct.toFixed(2)}% exceeds your ${maxAllowedPct}% limit. ` +
        `This token likely has thin liquidity. Raise your limit in /settings if you want to proceed anyway.`
    );
    this.name = "PriceImpactTooHighError";
  }
}

/**
 * Pure guardrail check, split out for unit testing. Jupiter reports
 * priceImpactPct as a fraction (0.012 = 1.2%).
 */
export function checkPriceImpact(priceImpactPctFraction: string | number, maxAllowedPct: number): void {
  const impact = Number(priceImpactPctFraction) * 100;
  if (Number.isFinite(impact) && impact > maxAllowedPct) {
    throw new PriceImpactTooHighError(impact, maxAllowedPct);
  }
}

const decimalsCache = new Map<string, number>();

export async function getMintDecimals(mint: string): Promise<number> {
  if (mint === SOL_MINT) return SOL_DECIMALS;
  const cached = decimalsCache.get(mint);
  if (cached !== undefined) return cached;

  const info = await getMint(connection, new PublicKey(mint));
  decimalsCache.set(mint, info.decimals);
  return info.decimals;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number = config.solana.defaultSlippageBps
): Promise<QuoteResponse> {
  const { data } = await axios.get(`${config.solana.jupiterApiUrl}/quote`, {
    params: {
      inputMint,
      outputMint,
      amount: amountLamports,
      slippageBps,
      onlyDirectRoutes: false,
    },
    timeout: 8000,
  });
  return data;
}

/**
 * Fetches a no-commitment preview of a buy — used to show the user exactly
 * what they'll get and exactly what fee they'll pay, before they confirm
 * anything. Does not touch their wallet or sign anything.
 */
export async function previewBuy(params: {
  tokenMint: string;
  solAmount: number;
  slippageBps?: number;
  feeBps: number;
}): Promise<SwapPreview> {
  const slippageBps = params.slippageBps ?? config.solana.defaultSlippageBps;
  const spendLamports = Math.round(params.solAmount * 1_000_000_000);
  const feeLamports = computeBuyFeeLamports(spendLamports, params.feeBps);
  const swapLamports = spendLamports - feeLamports;

  const quote = await getQuote(SOL_MINT, params.tokenMint, swapLamports, slippageBps);
  const outputDecimals = await getMintDecimals(params.tokenMint).catch(() => 9);

  return {
    side: "buy",
    inAmount: String(spendLamports),
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    feeLamports,
    feeBps: params.feeBps,
    outputDecimals,
  };
}

export async function previewSell(params: {
  tokenMint: string;
  tokenAmountRaw: number;
  slippageBps?: number;
  feeBps: number;
}): Promise<SwapPreview> {
  const slippageBps = params.slippageBps ?? config.solana.defaultSlippageBps;
  const quote = await getQuote(params.tokenMint, SOL_MINT, params.tokenAmountRaw, slippageBps);
  const feeLamports = computeSellFeeLamports(Number(quote.outAmount), slippageBps, params.feeBps);

  return {
    side: "sell",
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    feeLamports,
    feeBps: params.feeBps,
    outputDecimals: SOL_DECIMALS,
  };
}

/**
 * Executes a swap with MEV-aware submission, a price-impact guardrail, and
 * an atomic platform fee transfer bundled into the same transaction.
 */
export async function executeSwap(params: {
  keypair: Keypair;
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  maxPriceImpactPct?: number;
  /** SOL-denominated fee to collect, computed by the caller (buyToken/sellToken). */
  feeLamports: number;
}): Promise<SwapResult> {
  const { keypair, inputMint, outputMint, amountLamports, feeLamports } = params;
  const slippageBps = params.slippageBps ?? config.solana.defaultSlippageBps;
  const maxPriceImpactPct = params.maxPriceImpactPct ?? config.mev.maxPriceImpactPctDefault;

  const quote = await getQuote(inputMint, outputMint, amountLamports, slippageBps);
  checkPriceImpact(quote.priceImpactPct, maxPriceImpactPct);

  const { data: swapData } = await axios.post(
    `${config.solana.jupiterApiUrl}/swap`,
    {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    },
    { timeout: 10000 }
  );

  const txBuf = Buffer.from(swapData.swapTransaction, "base64");
  let tx = VersionedTransaction.deserialize(txBuf);

  const feeWallet = getFeeWallet();
  if (feeWallet && feeLamports > 0) {
    tx = await appendFeeTransfer({
      connection,
      tx,
      payer: keypair.publicKey,
      feeWallet,
      feeLamports,
    });
  } else if (feeLamports > 0) {
    logger.warn("PLATFORM_FEE_WALLET is not configured — trade executed with no platform fee collected");
  }

  tx.sign([keypair]);

  let submission;
  try {
    submission = await submitTransaction(tx);
  } catch (err) {
    captureException(err, { context: "swap_submission", inputMint, outputMint });
    throw err;
  }

  const outputDecimals = await getMintDecimals(outputMint).catch((err) => {
    logger.warn({ err, outputMint }, "Failed to resolve output mint decimals, defaulting to 9");
    return 9;
  });

  return {
    signature: submission.signature,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    priceImpactPct: quote.priceImpactPct,
    outputDecimals,
    submissionMethod: submission.method,
    feeLamports,
  };
}

export async function buyToken(params: {
  keypair: Keypair;
  tokenMint: string;
  solAmount: number;
  slippageBps?: number;
  maxPriceImpactPct?: number;
  feeBps: number;
}): Promise<SwapResult> {
  const spendLamports = Math.round(params.solAmount * 1_000_000_000);
  const feeLamports = computeBuyFeeLamports(spendLamports, params.feeBps);
  const swapLamports = spendLamports - feeLamports;

  return executeSwap({
    keypair: params.keypair,
    inputMint: SOL_MINT,
    outputMint: params.tokenMint,
    amountLamports: swapLamports,
    slippageBps: params.slippageBps,
    maxPriceImpactPct: params.maxPriceImpactPct,
    feeLamports,
  });
}

export async function sellToken(params: {
  keypair: Keypair;
  tokenMint: string;
  tokenAmountRaw: number;
  slippageBps?: number;
  maxPriceImpactPct?: number;
  feeBps: number;
}): Promise<SwapResult> {
  const slippageBps = params.slippageBps ?? config.solana.defaultSlippageBps;

  // Need a quote up front purely to size the fee against the guaranteed
  // minimum output — executeSwap will fetch its own (possibly fresher)
  // quote for the actual swap.
  const previewQuote = await getQuote(params.tokenMint, SOL_MINT, params.tokenAmountRaw, slippageBps);
  const feeLamports = computeSellFeeLamports(Number(previewQuote.outAmount), slippageBps, params.feeBps);

  return executeSwap({
    keypair: params.keypair,
    inputMint: params.tokenMint,
    outputMint: SOL_MINT,
    amountLamports: params.tokenAmountRaw,
    slippageBps: params.slippageBps,
    maxPriceImpactPct: params.maxPriceImpactPct,
    feeLamports,
  });
}

export function isValidMint(mint: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}
