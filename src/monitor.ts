// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Fee Wallet Monitor
// =============================================================================
// This module watches the designated fee wallet for incoming SOL deposits.
// When Pump.fun creator fees arrive, it triggers the buy-back sequence.
//
// MONITORING STRATEGY:
//   Primary:  WebSocket subscription (instant notification on balance change)
//   Fallback: HTTP polling (checks balance every N seconds if WS drops)
//
// The WebSocket approach is preferred because it's real-time — we detect
// new deposits within seconds. The polling fallback ensures we don't miss
// deposits if the WebSocket connection is interrupted.
// =============================================================================

import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { BotConfig } from './config.js';
import { logger } from './logger.js';
import { lamportsToSol, sleep } from './utils.js';

// =============================================================================
// TYPES
// =============================================================================

/** Callback invoked when new SOL fees are detected */
export type OnFeesDetected = (newSolLamports: number) => Promise<void>;

// =============================================================================
// FEE WALLET MONITOR
// =============================================================================

/**
 * Start monitoring the fee wallet for incoming SOL deposits.
 *
 * This function sets up two monitoring mechanisms:
 *
 *   1. WEBSOCKET (Primary)
 *      Uses connection.onAccountChange() to subscribe to real-time balance
 *      changes on the fee wallet. Whenever the wallet's SOL balance changes,
 *      the callback fires instantly.
 *
 *   2. POLLING (Fallback)
 *      Periodically checks the fee wallet balance via HTTP RPC. This runs
 *      in parallel and catches any deposits that the WebSocket might miss
 *      (e.g., during reconnection).
 *
 * When a balance INCREASE is detected (new SOL deposited), the callback
 * is invoked with the amount of new SOL after reserving funds for tx fees.
 *
 * @param config     - Bot configuration
 * @param connection - Solana RPC connection
 * @param onFees     - Callback to execute when new fees are detected
 */
export async function startMonitoring(
  config: BotConfig,
  connection: Connection,
  onFees: OnFeesDetected,
): Promise<void> {
  logger.separator('MONITOR', 'STARTING FEE WALLET MONITOR');
  logger.info('MONITOR', `Watching wallet: ${config.feeWalletAddress.toBase58()}`);
  logger.info('MONITOR', `Minimum threshold: ${lamportsToSol(config.minSolThreshold)} SOL`);
  logger.info('MONITOR', `Reserved for fees: ${lamportsToSol(config.reservedSolForFees)} SOL`);

  // Track the last known balance to detect increases
  let lastKnownBalance = await connection.getBalance(config.feeWalletAddress);
  logger.info('MONITOR', `Current balance: ${lamportsToSol(lastKnownBalance)} SOL`);

  // Flag to prevent concurrent buy-back executions
  let isProcessing = false;

  /**
   * Core logic: Check if balance increased and trigger buy-back if threshold met.
   * This is shared between WebSocket and polling to avoid code duplication.
   */
  async function handleBalanceChange(newBalance: number): Promise<void> {
    // Skip if we're already processing a buy-back
    if (isProcessing) {
      logger.debug('MONITOR', 'Buy-back already in progress, skipping...');
      return;
    }

    // Calculate the delta (how much new SOL arrived)
    const delta = newBalance - lastKnownBalance;

    if (delta <= 0) {
      // Balance decreased or unchanged — not a new deposit
      // (Could be the bot spending SOL on swaps, or normal tx fees)
      logger.debug('MONITOR', `Balance unchanged or decreased: ${lamportsToSol(newBalance)} SOL (Δ${lamportsToSol(delta)} SOL)`);
      lastKnownBalance = newBalance;
      return;
    }

    logger.info('MONITOR', `💰 New SOL detected! +${lamportsToSol(delta)} SOL (new balance: ${lamportsToSol(newBalance)} SOL)`);

    // Calculate how much SOL is available for the buy-back
    // We reserve some SOL for future transaction fees
    const availableForSwap = newBalance - config.reservedSolForFees;

    if (availableForSwap < config.minSolThreshold) {
      logger.info('MONITOR',
        `Balance (${lamportsToSol(availableForSwap)} SOL available) below threshold ` +
        `(${lamportsToSol(config.minSolThreshold)} SOL). Waiting for more deposits...`,
      );
      lastKnownBalance = newBalance;
      return;
    }

    // THRESHOLD MET — trigger buy-back!
    logger.info('MONITOR', `🚀 Threshold met! Triggering buy-back with ${lamportsToSol(availableForSwap)} SOL`);

    isProcessing = true;
    lastKnownBalance = newBalance;

    try {
      await onFees(availableForSwap);
    } catch (err) {
      logger.error('MONITOR', 'Buy-back/airdrop cycle failed:', err instanceof Error ? err.message : err);
    } finally {
      isProcessing = false;
      // Refresh balance after processing (swap will have changed it)
      lastKnownBalance = await connection.getBalance(config.feeWalletAddress);
      logger.info('MONITOR', `Post-cycle balance: ${lamportsToSol(lastKnownBalance)} SOL`);
    }
  }

  // ===========================================================================
  // PRIMARY: WebSocket Subscription
  // ===========================================================================
  // connection.onAccountChange() opens a WebSocket to the Solana node.
  // Whenever the fee wallet's account data changes (including SOL balance),
  // the callback fires immediately — typically within 1-2 seconds.
  // ===========================================================================
  try {
    const subscriptionId = connection.onAccountChange(
      config.feeWalletAddress,
      async (accountInfo) => {
        const newBalance = accountInfo.lamports;
        logger.debug('MONITOR', `[WebSocket] Balance update: ${lamportsToSol(newBalance)} SOL`);
        await handleBalanceChange(newBalance);
      },
      'confirmed',
    );

    logger.info('MONITOR', `✅ WebSocket subscription active (ID: ${subscriptionId})`);
  } catch (err) {
    logger.warn('MONITOR', 'WebSocket subscription failed, relying on polling only:', err instanceof Error ? err.message : err);
  }

  // ===========================================================================
  // FALLBACK: HTTP Polling Loop
  // ===========================================================================
  // Even with WebSocket active, we poll as a safety net.
  // This catches deposits if:
  //   - WebSocket connection drops temporarily
  //   - WebSocket subscription is delayed
  //   - RPC node has WebSocket issues
  //
  // The handleBalanceChange function is idempotent — calling it with the
  // same balance twice has no effect, so the overlap is safe.
  // ===========================================================================
  logger.info('MONITOR', `Starting polling fallback (interval: ${config.pollingIntervalMs}ms)`);

  while (true) {
    try {
      await sleep(config.pollingIntervalMs);
      const currentBalance = await connection.getBalance(config.feeWalletAddress, 'confirmed');
      logger.debug('MONITOR', `[Polling] Balance: ${lamportsToSol(currentBalance)} SOL`);
      await handleBalanceChange(currentBalance);
    } catch (err) {
      logger.error('MONITOR', 'Polling error:', err instanceof Error ? err.message : err);
      // Don't crash — wait and retry
      await sleep(5000);
    }
  }
}
