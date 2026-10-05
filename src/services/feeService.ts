import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../config";

/**
 * FEE MODEL
 * ---------------------------------------------------------------------------
 * The platform fee is always taken in SOL, regardless of which token is
 * being bought or sold. This avoids the need to pre-register a Jupiter
 * referral token account for every arbitrary token a user might snipe
 * (Jupiter's official platform-fee mechanism requires a fee token account
 * per output mint, which isn't practical for brand-new pump.fun tokens).
 *
 * Instead, the fee is added as a plain SystemProgram.transfer instruction,
 * appended into the *same* transaction as the swap, so it settles
 * atomically with the trade — either both happen or neither does. There is
 * no separate transaction, no extra signature, and no way for a user to
 * get the swap without also paying the fee.
 *
 * - On a BUY: fee is a percentage of the SOL the user is spending, taken
 *   up front, so the amount actually routed to Jupiter is (spend - fee).
 * - On a SELL: fee is a percentage of the SOL the user receives. Since the
 *   exact output isn't known until the swap executes, we conservatively
 *   compute it against the worst-case output guaranteed by the user's
 *   slippage tolerance — this means the fee can never cause the
 *   transaction to fail from insufficient balance, at the cost of
 *   occasionally taking a hair less than the nominal rate on a good fill.
 * ---------------------------------------------------------------------------
 */

export function getFeeWallet(): PublicKey | null {
  if (!config.solana.platformFeeWallet) return null;
  return new PublicKey(config.solana.platformFeeWallet);
}

export function computeBuyFeeLamports(spendLamports: number, feeBps: number): number {
  return Math.floor((spendLamports * feeBps) / 10_000);
}

/**
 * Fee on a sell, computed against the guaranteed-minimum output implied by
 * slippageBps — never the optimistic quoted amount — so the transfer can
 * never exceed what the transaction is guaranteed to actually receive.
 */
export function computeSellFeeLamports(
  quotedOutLamports: number,
  slippageBps: number,
  feeBps: number
): number {
  const guaranteedMinOut = Math.floor((quotedOutLamports * (10_000 - slippageBps)) / 10_000);
  return Math.floor((guaranteedMinOut * feeBps) / 10_000);
}

/**
 * Decompiles a v0 transaction (resolving any address lookup tables it
 * uses), appends a SOL transfer instruction to the platform fee wallet,
 * and recompiles + returns a new unsigned VersionedTransaction. The caller
 * signs the result exactly as it would have signed the original.
 */
export async function appendFeeTransfer(params: {
  connection: Connection;
  tx: VersionedTransaction;
  payer: PublicKey;
  feeWallet: PublicKey;
  feeLamports: number;
}): Promise<VersionedTransaction> {
  const { connection, tx, payer, feeWallet, feeLamports } = params;

  if (feeLamports <= 0) return tx; // nothing to add

  const message = tx.message;

  const lookupTableAccounts: AddressLookupTableAccount[] = [];
  for (const lookup of message.addressTableLookups) {
    const account = await connection.getAddressLookupTable(lookup.accountKey);
    if (account.value) lookupTableAccounts.push(account.value);
  }

  const decompiled = TransactionMessage.decompile(message, {
    addressLookupTableAccounts: lookupTableAccounts,
  });

  decompiled.instructions.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: feeWallet,
      lamports: feeLamports,
    })
  );

  const recompiled = decompiled.compileToV0Message(lookupTableAccounts);
  return new VersionedTransaction(recompiled);
}
