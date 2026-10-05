import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, TokenAccountNotFoundError } from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "../config";
import { supabase } from "../db/supabase";
import { decryptSecret, encryptSecret } from "../utils/encryption";
import { logger } from "../utils/logger";

const connection = new Connection(config.solana.rpcUrl, "confirmed");

export interface TradingWallet {
  userId: string;
  publicKey: string;
}

/**
 * Returns the user's trading wallet, generating one if they don't have one
 * yet. This is the ONLY way a wallet is created for a user — we never accept
 * a private key or seed phrase pasted in by the user.
 */
export async function getOrCreateWallet(telegramUserId: string): Promise<TradingWallet> {
  const { data: existing, error: fetchErr } = await supabase
    .from("wallets")
    .select("public_key")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (existing) {
    return { userId: telegramUserId, publicKey: existing.public_key };
  }

  const keypair = Keypair.generate();
  const encryptedKey = encryptSecret(keypair.secretKey);

  const { error: insertErr } = await supabase.from("wallets").insert({
    telegram_user_id: telegramUserId,
    public_key: keypair.publicKey.toBase58(),
    encrypted_private_key: encryptedKey,
  });

  if (insertErr) throw insertErr;

  logger.info({ telegramUserId }, "Generated new non-custodial trading wallet");

  return { userId: telegramUserId, publicKey: keypair.publicKey.toBase58() };
}

/**
 * Loads and decrypts the keypair for signing. Called only inside the request
 * lifecycle of an actual trade — never cached, never logged, never returned
 * over the API.
 */
export async function loadSigningKeypair(telegramUserId: string): Promise<Keypair> {
  const { data, error } = await supabase
    .from("wallets")
    .select("encrypted_private_key")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (error || !data) throw new Error("Wallet not found for user");

  const secretKey = decryptSecret(data.encrypted_private_key);
  return Keypair.fromSecretKey(secretKey);
}

export async function getSolBalance(publicKey: string): Promise<number> {
  const lamports = await connection.getBalance(new PublicKey(publicKey));
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Raw (base-unit) SPL token balance for a given wallet + mint. Returns 0 if
 * the associated token account doesn't exist yet (i.e. the wallet has never
 * held that token) rather than throwing — a "you have 0 tokens" case is
 * routine, not exceptional.
 */
export async function getTokenBalanceRaw(walletPublicKey: string, mint: string): Promise<number> {
  const owner = new PublicKey(walletPublicKey);
  const mintPubkey = new PublicKey(mint);
  const ata = await getAssociatedTokenAddress(mintPubkey, owner);

  try {
    const account = await getAccount(connection, ata);
    return Number(account.amount);
  } catch (err) {
    if (err instanceof TokenAccountNotFoundError) return 0;
    throw err;
  }
}

/**
 * Exports the private key (base58) to the OWNER of that wallet only, so they
 * can withdraw/migrate at any time without depending on us. Gate this behind
 * an explicit confirmation step in the bot UI, and rate-limit it.
 */
export async function exportPrivateKeyForOwner(telegramUserId: string): Promise<string> {
  const keypair = await loadSigningKeypair(telegramUserId);
  return bs58.encode(keypair.secretKey);
}
