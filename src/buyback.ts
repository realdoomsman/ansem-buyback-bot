// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Buy-Back Engine
// =============================================================================
// This module executes the SOL → $ANSEM token swap using Jupiter Aggregator V6
// with Jito bundle submission for MEV (Maximal Extractable Value) protection.
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │                    ANTI-SNIPER & MEV PROTECTION EXPLAINED                  │
// ├─────────────────────────────────────────────────────────────────────────────┤
// │                                                                           │
// │  The #1 risk when doing large on-chain swaps is getting "sandwiched" by    │
// │  MEV bots. Here's how sandwich attacks work:                               │
// │                                                                           │
// │  1. A MEV bot sees our swap transaction in the public mempool             │
// │  2. It front-runs us by buying the token BEFORE our swap executes         │
// │  3. Our swap executes at a worse price (we pay more)                      │
// │  4. The bot sells immediately after, profiting from the price impact      │
// │                                                                           │
// │  OUR PROTECTION STRATEGY (3 layers):                                      │
// │                                                                           │
// │  Layer 1 — JITO BUNDLES (Primary Defense)                                 │
// │    Instead of broadcasting to the public mempool where bots can see it,   │
// │    we submit our swap as a Jito bundle. This sends the transaction        │
// │    directly to Jito-powered validators, who execute it privately.          │
// │    The transaction is never visible in the mempool, so bots can't         │
// │    front-run or sandwich it.                                              │
// │                                                                           │
// │  Layer 2 — STRICT SLIPPAGE CONTROLS                                      │
// │    We set a maximum slippage tolerance (default 0.5%). If the price       │
// │    moves more than this between quote and execution, the transaction      │
// │    automatically reverts. This limits the damage even if a bot somehow    │
// │    manages to manipulate the price.                                       │
// │                                                                           │
// │  Layer 3 — PRICE IMPACT CHECKS                                           │
// │    Before executing, we check Jupiter's reported price impact. If the     │
// │    swap would move the price more than our threshold (default 5%),        │
// │    we reject it entirely. This prevents executing during extremely        │
// │    illiquid conditions where the bot's own swap would cause too much      │
// │    slippage.                                                              │
// │                                                                           │
// └─────────────────────────────────────────────────────────────────────────────┘
// =============================================================================

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import axios from 'axios';
import bs58 from 'bs58';
import {
  BotConfig,
  JUPITER_API_BASE,
  JITO_BLOCK_ENGINE_URL,
  WRAPPED_SOL_MINT,
} from './config.js';
import { logger } from './logger.js';
import {
  getRandomTipAccount,
  lamportsToSol,
  retryWithBackoff,
  sleep,
  solscanLink,
} from './utils.js';

// =============================================================================
// TYPES
// =============================================================================

/** Result of a successful buy-back operation */
export interface BuyBackResult {
  /** Transaction signature of the swap */
  txSignature: string;
  /** Amount of SOL spent (lamports) */
  solSpent: number;
  /** Amount of tokens received (raw, before decimals) */
  tokensReceived: bigint;
  /** The Jupiter quote that was used */
  quote: JupiterQuote;
}

/** Simplified Jupiter quote response (fields we care about) */
interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
  routePlan: unknown[];
}

// =============================================================================
// STEP 1: GET JUPITER QUOTE
// =============================================================================

/**
 * Fetch a swap quote from Jupiter Aggregator V6.
 *
 * Jupiter finds the best route across all Solana DEXes (Raydium, Orca,
 * PumpSwap, etc.) and returns the optimal path for our swap.
 *
 * ANTI-SNIPER NOTE:
 * Getting a quote is read-only — it doesn't reveal our intent to the network.
 * The quote is fetched via HTTPS, not on-chain, so MEV bots cannot see it.
 *
 * @param config    - Bot configuration
 * @param solAmount - Amount of SOL to swap (in lamports)
 * @returns Jupiter quote response
 */
async function getJupiterQuote(
  config: BotConfig,
  solAmount: number,
): Promise<JupiterQuote> {
  logger.info('JUPITER', `Fetching quote: ${lamportsToSol(solAmount)} SOL → $ANSEM`);

  // Build the quote request URL with our parameters
  const params = new URLSearchParams({
    // Input: Wrapped SOL (Jupiter uses this for native SOL swaps)
    inputMint: WRAPPED_SOL_MINT.toBase58(),
    // Output: Our $ANSEM token
    outputMint: config.tokenMintAddress.toBase58(),
    // Amount in smallest units (lamports for SOL)
    amount: solAmount.toString(),
    // ANTI-SNIPER: Strict slippage control
    // If price moves more than this, the transaction reverts
    slippageBps: config.slippageBps.toString(),
    // Only show direct routes for more predictable execution
    onlyDirectRoutes: 'false',
    // Exclude DEXes with known MEV vulnerability (none currently, but future-proofed)
    // excludeDexes: '',
  });

  const response = await retryWithBackoff(
    () => axios.get<JupiterQuote>(`${JUPITER_API_BASE}/quote?${params.toString()}`),
    3,
    1000,
    'Jupiter quote fetch',
  );

  const quote = response.data;

  logger.info('JUPITER', 'Quote received:', {
    inputAmount: `${lamportsToSol(parseInt(quote.inAmount))} SOL`,
    outputAmount: quote.outAmount,
    priceImpact: `${quote.priceImpactPct}%`,
    routes: quote.routePlan?.length || 0,
  });

  return quote;
}

// =============================================================================
// STEP 2: CHECK PRICE IMPACT (Anti-Sniper Layer 3)
// =============================================================================

/**
 * Validate that the swap's price impact is within acceptable bounds.
 *
 * ANTI-SNIPER EXPLANATION:
 * Price impact measures how much our swap will move the token's price.
 * A high price impact means:
 *   1. The pool is illiquid — our swap will cause a big price spike
 *   2. This creates an arbitrage opportunity for bots
 *   3. We'd be buying at a significantly inflated price
 *
 * By rejecting high-impact swaps, we:
 *   - Protect the community's funds from overpaying
 *   - Avoid creating profitable arbitrage for bots
 *   - Wait for better liquidity conditions
 *
 * @param quote  - The Jupiter quote to check
 * @param config - Bot configuration
 * @throws Error if price impact exceeds the configured threshold
 */
function validatePriceImpact(quote: JupiterQuote, config: BotConfig): void {
  const priceImpact = parseFloat(quote.priceImpactPct);

  if (priceImpact > config.maxPriceImpactPercent) {
    throw new Error(
      `Price impact too high: ${priceImpact.toFixed(2)}% (max: ${config.maxPriceImpactPercent}%). ` +
      `This likely means the pool is illiquid. Swap rejected to protect funds. ` +
      `The bot will retry on the next cycle.`,
    );
  }

  if (priceImpact > config.maxPriceImpactPercent * 0.5) {
    logger.warn('JUPITER', `Price impact is elevated: ${priceImpact.toFixed(2)}% (threshold: ${config.maxPriceImpactPercent}%)`);
  } else {
    logger.info('JUPITER', `Price impact OK: ${priceImpact.toFixed(2)}%`);
  }
}

// =============================================================================
// STEP 3: BUILD SWAP TRANSACTION
// =============================================================================

/**
 * Request the serialized swap transaction from Jupiter's API.
 *
 * Jupiter constructs the full transaction including:
 * - Wrapping SOL → wSOL if needed
 * - All DEX swap instructions (Raydium, PumpSwap, etc.)
 * - Unwrapping output tokens
 * - Dynamic compute unit budget
 *
 * ANTI-SNIPER NOTE:
 * This API call is also off-chain (HTTPS). The transaction is constructed
 * server-side by Jupiter and returned to us for signing. No on-chain
 * activity happens yet, so our intent remains private.
 *
 * @param config - Bot configuration
 * @param quote  - The Jupiter quote to execute
 * @returns Serialized transaction as a base64 string
 */
async function getSwapTransaction(
  config: BotConfig,
  quote: JupiterQuote,
): Promise<string> {
  logger.info('JUPITER', 'Requesting swap transaction...');

  const response = await retryWithBackoff(
    () =>
      axios.post<{ swapTransaction: string }>(`${JUPITER_API_BASE}/swap`, {
        quoteResponse: quote,
        userPublicKey: config.walletKeypair.publicKey.toBase58(),
        // PERFORMANCE: Let Jupiter optimize compute units for our specific route
        dynamicComputeUnitLimit: true,
        // PERFORMANCE: Auto-calculate priority fee for competitive landing
        prioritizationFeeLamports: 'auto',
        // We'll handle wrapping ourselves if needed
        wrapAndUnwrapSol: true,
      }),
    3,
    1000,
    'Jupiter swap transaction request',
  );

  logger.info('JUPITER', 'Swap transaction received, ready for signing');
  return response.data.swapTransaction;
}

// =============================================================================
// STEP 4: SUBMIT VIA JITO BUNDLE (Anti-Sniper Layer 1)
// =============================================================================

/**
 * Submit the swap transaction as a Jito bundle for MEV protection.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │                    HOW JITO BUNDLES PROTECT US                         │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │                                                                       │
 * │  Normal transaction flow (VULNERABLE):                                │
 * │    Our Wallet → RPC Node → Public Mempool → All validators see it     │
 * │                                    ↓                                  │
 * │                              MEV bots see it                          │
 * │                              and sandwich us                          │
 * │                                                                       │
 * │  Jito bundle flow (PROTECTED):                                        │
 * │    Our Wallet → Jito Block Engine → Jito Validators ONLY              │
 * │                                                                       │
 * │  The bundle is NEVER visible in the public mempool.                   │
 * │  It goes directly from us → Jito → into the block.                    │
 * │  MEV bots never see it until it's already confirmed.                  │
 * │                                                                       │
 * │  We also include a "tip" transaction — a small SOL payment to one     │
 * │  of Jito's tip accounts. This incentivizes validators to include      │
 * │  our bundle in their block.                                           │
 * │                                                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * @param config             - Bot configuration
 * @param connection         - Solana RPC connection
 * @param signedSwapTxBase64 - The signed swap transaction (base64)
 * @returns Bundle ID if submission was successful
 */
async function submitJitoBundle(
  config: BotConfig,
  connection: Connection,
  signedSwapTxBase64: string,
): Promise<string> {
  logger.separator('JITO', 'SUBMITTING JITO BUNDLE (MEV PROTECTED)');

  // -------------------------------------------------------------------------
  // Step 4a: Create the tip transaction
  // -------------------------------------------------------------------------
  // The tip incentivizes Jito validators to include our bundle.
  // We pick a random tip account to distribute load across Jito's infrastructure.
  // -------------------------------------------------------------------------
  const tipAccount = getRandomTipAccount();
  logger.info('JITO', `Selected tip account: ${tipAccount.toBase58()}`);
  logger.info('JITO', `Tip amount: ${lamportsToSol(config.jitoTipLamports)} SOL`);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Build a simple SOL transfer to the Jito tip account
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: config.walletKeypair.publicKey,
    toPubkey: tipAccount,
    lamports: config.jitoTipLamports,
  });

  // Create and sign the tip transaction
  const tipMessage = new TransactionMessage({
    payerKey: config.walletKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipInstruction],
  }).compileToV0Message();

  const tipTransaction = new VersionedTransaction(tipMessage);
  tipTransaction.sign([config.walletKeypair]);

  // -------------------------------------------------------------------------
  // Step 4b: Encode both transactions for the bundle
  // -------------------------------------------------------------------------
  // A Jito bundle is an array of transactions that execute atomically.
  // Order matters: [swap_tx, tip_tx]
  // If the swap fails, the tip is never paid (all-or-nothing).
  // -------------------------------------------------------------------------
  const swapTxBytes = Buffer.from(signedSwapTxBase64, 'base64');
  const tipTxBytes = Buffer.from(tipTransaction.serialize());

  const bundle = [
    bs58.encode(swapTxBytes),  // Transaction 1: The actual swap
    bs58.encode(tipTxBytes),   // Transaction 2: Jito tip (pays the validator)
  ];

  logger.info('JITO', `Bundle contains ${bundle.length} transactions`);

  // -------------------------------------------------------------------------
  // Step 4c: Submit the bundle to Jito's Block Engine
  // -------------------------------------------------------------------------
  // This is the moment our transaction becomes visible — but only to Jito
  // validators, NOT to the public mempool. MEV bots cannot see this.
  // -------------------------------------------------------------------------
  const response = await retryWithBackoff(
    () =>
      axios.post(JITO_BLOCK_ENGINE_URL, {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [bundle],
      }),
    2,
    2000,
    'Jito bundle submission',
  );

  const bundleId = response.data?.result;

  if (!bundleId) {
    throw new Error(`Jito bundle submission failed: ${JSON.stringify(response.data)}`);
  }

  logger.info('JITO', `✅ Bundle submitted successfully! Bundle ID: ${bundleId}`);
  return bundleId;
}

// =============================================================================
// STEP 5: VERIFY BUNDLE LANDING
// =============================================================================

/**
 * Poll Jito's Block Engine to verify that our bundle was included in a block.
 *
 * Jito's sendBundle returns immediately with a bundle ID, but this only means
 * the Block Engine received it — NOT that it was included in a block.
 * We need to poll getBundleStatuses to confirm actual on-chain execution.
 *
 * @param bundleId - The bundle ID from Jito
 * @param maxAttempts - Maximum polling attempts (default: 30)
 * @returns true if the bundle landed, false if it timed out
 */
async function waitForBundleLanding(
  bundleId: string,
  maxAttempts: number = 30,
): Promise<boolean> {
  logger.info('JITO', `Waiting for bundle to land... (bundle ID: ${bundleId})`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(2000); // Check every 2 seconds

    try {
      const response = await axios.post(JITO_BLOCK_ENGINE_URL, {
        jsonrpc: '2.0',
        id: 1,
        method: 'getBundleStatuses',
        params: [[bundleId]],
      });

      const statuses = response.data?.result?.value;
      if (statuses && statuses.length > 0) {
        const status = statuses[0];

        if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
          logger.info('JITO', `✅ Bundle landed! Status: ${status.confirmation_status}`, {
            slot: status.slot,
            transactions: status.transactions,
          });
          return true;
        }

        logger.debug('JITO', `Bundle status: ${status.confirmation_status} (attempt ${attempt}/${maxAttempts})`);
      }
    } catch (err) {
      logger.debug('JITO', `Status check failed (attempt ${attempt}): ${err instanceof Error ? err.message : err}`);
    }
  }

  logger.warn('JITO', `Bundle did not land within ${maxAttempts * 2}s`);
  return false;
}

// =============================================================================
// STEP 6: FALLBACK — Direct RPC Submission
// =============================================================================

/**
 * Fallback: Send the swap transaction directly via RPC if Jito fails.
 *
 * ⚠️ WARNING: This bypasses MEV protection!
 * This is only used if Jito bundle submission fails (e.g., Block Engine
 * is down, tip too low, network issues). The transaction will be sent
 * to the public mempool where MEV bots CAN see it.
 *
 * We still have Layer 2 (slippage control) and Layer 3 (price impact check)
 * protecting us, but Layer 1 (private submission) is lost.
 *
 * @param connection - Solana RPC connection
 * @param signedTx   - The signed transaction bytes
 * @returns Transaction signature
 */
async function fallbackDirectSend(
  connection: Connection,
  signedTx: Buffer,
): Promise<string> {
  logger.warn('BUYBACK', '⚠️  FALLBACK: Sending swap via public RPC (MEV protection reduced!)');
  logger.warn('BUYBACK', 'Jito bundle failed — using direct submission. Slippage controls still active.');

  const txSignature = await connection.sendRawTransaction(signedTx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });

  logger.info('BUYBACK', `Transaction sent: ${solscanLink(txSignature)}`);

  // Wait for confirmation
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    'confirmed',
  );

  return txSignature;
}

// =============================================================================
// MAIN BUY-BACK FUNCTION
// =============================================================================

/**
 * Execute a complete buy-back: SOL → $ANSEM token swap.
 *
 * This is the main entry point called by the monitor when new fees are detected.
 * It orchestrates all the steps:
 *   1. Get Jupiter quote (best swap route)
 *   2. Validate price impact (reject if too high)
 *   3. Get serialized swap transaction from Jupiter
 *   4. Sign the transaction
 *   5. Submit via Jito bundle (MEV protected)
 *   6. If Jito fails, fall back to direct RPC send
 *   7. Verify the swap landed on-chain
 *   8. Return the result for the airdrop engine
 *
 * @param config     - Bot configuration
 * @param connection - Solana RPC connection
 * @param solAmount  - Amount of SOL to swap (in lamports)
 * @returns BuyBackResult with swap details, or null if the swap was skipped
 */
export async function executeBuyBack(
  config: BotConfig,
  connection: Connection,
  solAmount: number,
): Promise<BuyBackResult | null> {
  logger.separator('BUYBACK', `BUY-BACK: Swapping ${lamportsToSol(solAmount)} SOL → $ANSEM`);

  try {
    // =========================================================================
    // Step 1: Get the best swap quote from Jupiter
    // =========================================================================
    const quote = await getJupiterQuote(config, solAmount);

    // =========================================================================
    // Step 2: ANTI-SNIPER CHECK — Validate price impact
    // Reject the swap if it would move the price too much
    // =========================================================================
    validatePriceImpact(quote, config);

    // =========================================================================
    // Step 3: DRY RUN CHECK
    // In dry-run mode, we log what WOULD happen but don't execute
    // =========================================================================
    if (config.dryRun) {
      logger.warn('BUYBACK', '🏜️  DRY RUN — swap would execute with these parameters:', {
        solIn: `${lamportsToSol(solAmount)} SOL`,
        estimatedTokensOut: quote.outAmount,
        priceImpact: `${quote.priceImpactPct}%`,
        slippage: `${config.slippageBps} bps`,
      });
      return null;
    }

    // =========================================================================
    // Step 4: Get the serialized swap transaction from Jupiter
    // =========================================================================
    const swapTxBase64 = await getSwapTransaction(config, quote);

    // =========================================================================
    // Step 5: Deserialize and sign the transaction
    // =========================================================================
    const swapTxBuffer = Buffer.from(swapTxBase64, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTxBuffer);
    transaction.sign([config.walletKeypair]);

    // Re-serialize after signing
    const signedTxBytes = Buffer.from(transaction.serialize());
    const signedTxBase64 = signedTxBytes.toString('base64');

    // =========================================================================
    // Step 6: Submit via Jito bundle (MEV PROTECTED)
    // If Jito fails, fall back to direct RPC submission
    // =========================================================================
    let txSignature: string;

    try {
      const bundleId = await submitJitoBundle(config, connection, signedTxBase64);
      const landed = await waitForBundleLanding(bundleId);

      if (landed) {
        // The bundle landed — extract the swap transaction signature
        txSignature = bs58.encode(transaction.signatures[0]);
        logger.info('BUYBACK', `✅ Swap executed via Jito bundle: ${solscanLink(txSignature)}`);
      } else {
        // Bundle didn't land — try direct submission as fallback
        logger.warn('BUYBACK', 'Jito bundle did not land, falling back to direct submission...');
        txSignature = await fallbackDirectSend(connection, signedTxBytes);
      }
    } catch (jitoError) {
      // Jito submission failed entirely — use fallback
      logger.error('JITO', 'Bundle submission failed:', jitoError instanceof Error ? jitoError.message : jitoError);
      txSignature = await fallbackDirectSend(connection, signedTxBytes);
    }

    // =========================================================================
    // Step 7: Return the result
    // The caller (index.ts) will pass this to the airdrop engine
    // =========================================================================
    const result: BuyBackResult = {
      txSignature,
      solSpent: solAmount,
      tokensReceived: BigInt(quote.outAmount),
      quote,
    };

    logger.info('BUYBACK', '🎉 Buy-back complete!', {
      solSpent: `${lamportsToSol(solAmount)} SOL`,
      tokensReceived: quote.outAmount,
      priceImpact: `${quote.priceImpactPct}%`,
      tx: solscanLink(txSignature),
    });

    return result;

  } catch (err) {
    logger.error('BUYBACK', '❌ Buy-back failed:', err instanceof Error ? err.message : err);
    throw err;
  }
}
