// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Utilities
// =============================================================================
// Shared helper functions used across all modules. These are intentionally
// simple and well-documented so the community can verify their behavior.
// =============================================================================

import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionSignature,
} from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS } from './config.js';
import { logger } from './logger.js';

// =============================================================================
// SLEEP
// =============================================================================

/**
 * Async sleep helper.
 * Used for polling intervals, retry delays, and rate limiting.
 *
 * @param ms - Duration to sleep in milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// JITO TIP ACCOUNT SELECTION
// =============================================================================

/**
 * Select a random Jito tip account from the official list.
 *
 * WHY RANDOM?
 * Jito recommends distributing tips across their accounts to avoid
 * overloading any single account and to improve bundle landing rates.
 * Each call picks one at random from the 8 official accounts.
 *
 * @returns A random Jito tip account PublicKey
 */
export function getRandomTipAccount(): PublicKey {
  const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[index];
}

// =============================================================================
// SOL CONVERSION HELPERS
// =============================================================================

/**
 * Convert lamports (smallest SOL unit) to SOL.
 * 1 SOL = 1,000,000,000 lamports (1e9)
 *
 * @param lamports - Amount in lamports
 * @returns Amount in SOL as a number
 */
export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Convert SOL to lamports.
 *
 * @param sol - Amount in SOL
 * @returns Amount in lamports as a number
 */
export function solToLamports(sol: number): number {
  return Math.floor(sol * LAMPORTS_PER_SOL);
}

// =============================================================================
// TOKEN AMOUNT FORMATTING
// =============================================================================

/**
 * Format a raw token amount (BigInt) to a human-readable string with decimals.
 *
 * SPL tokens store amounts as integers with an implicit decimal point.
 * For example, with 6 decimals:
 *   raw amount 1_000_000n → display "1.0"
 *   raw amount 1_500_000n → display "1.5"
 *
 * @param rawAmount - Raw token amount as BigInt
 * @param decimals  - Number of decimal places for the token (usually 6 or 9)
 * @returns Human-readable string representation
 */
export function formatTokenAmount(rawAmount: bigint, decimals: number): string {
  const divisor = BigInt(10 ** decimals);
  const wholePart = rawAmount / divisor;
  const fractionalPart = rawAmount % divisor;

  // Pad fractional part with leading zeros
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0');

  // Trim trailing zeros for cleaner display
  const trimmed = fractionalStr.replace(/0+$/, '') || '0';

  return `${wholePart}.${trimmed}`;
}

// =============================================================================
// RETRY WITH EXPONENTIAL BACKOFF
// =============================================================================

/**
 * Execute an async function with exponential backoff retry logic.
 *
 * WHY THIS IS NEEDED:
 * Solana RPC calls and API requests can fail transiently due to rate limits,
 * network congestion, or temporary outages. Rather than failing immediately,
 * we retry with increasing delays to give the service time to recover.
 *
 * Backoff schedule (with default 1000ms base):
 *   Attempt 1: immediate
 *   Attempt 2: wait 1s
 *   Attempt 3: wait 2s
 *   Attempt 4: wait 4s
 *   Attempt 5: wait 8s
 *
 * @param fn          - The async function to execute
 * @param maxRetries  - Maximum number of retry attempts (default: 3)
 * @param baseDelayMs - Base delay in milliseconds (default: 1000)
 * @param context     - Description for logging (e.g., "Jupiter quote fetch")
 * @returns The result of the function if successful
 * @throws The last error if all retries are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  context: string = 'operation',
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt > maxRetries) {
        logger.error('SYSTEM', `${context} failed after ${maxRetries + 1} attempts`, {
          error: lastError.message,
        });
        throw lastError;
      }

      // Exponential backoff: baseDelay * 2^(attempt-1)
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn('SYSTEM', `${context} failed (attempt ${attempt}/${maxRetries + 1}), retrying in ${delay}ms...`, {
        error: lastError.message,
      });
      await sleep(delay);
    }
  }

  // TypeScript requires this but it's unreachable
  throw lastError!;
}

// =============================================================================
// TRANSACTION CONFIRMATION
// =============================================================================

/**
 * Wait for a Solana transaction to be confirmed with a timeout.
 *
 * This wraps the standard confirmTransaction with additional logging
 * and a configurable timeout. If the transaction fails or times out,
 * it throws with a descriptive error.
 *
 * @param connection - Solana RPC connection
 * @param signature  - Transaction signature to confirm
 * @param timeoutMs  - Maximum time to wait (default: 60 seconds)
 * @returns The confirmed transaction signature
 */
export async function confirmTransaction(
  connection: Connection,
  signature: TransactionSignature,
  timeoutMs: number = 60_000,
): Promise<TransactionSignature> {
  logger.debug('SYSTEM', `Confirming transaction: ${signature}`);

  const startTime = Date.now();

  // Use getLatestBlockhash for blockhash-based confirmation strategy
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const confirmation = await Promise.race([
    connection.confirmTransaction(
      {
        signature,
        blockhash,
        lastValidBlockHeight,
      },
      'confirmed',
    ),
    // Timeout fallback
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Transaction confirmation timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  if (confirmation.value.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  const elapsed = Date.now() - startTime;
  logger.debug('SYSTEM', `Transaction confirmed in ${elapsed}ms: ${signature}`);

  return signature;
}

// =============================================================================
// SOLSCAN LINK HELPER
// =============================================================================

/**
 * Generate a Solscan explorer link for a transaction.
 * Useful for logging — operators can click to verify transactions.
 *
 * @param signature - Transaction signature
 * @returns Solscan URL string
 */
export function solscanLink(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}
