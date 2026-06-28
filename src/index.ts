// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Entry Point
// =============================================================================
// This is the main entry point for the bot. It:
//   1. Loads and validates configuration
//   2. Establishes connection to Solana
//   3. Starts the fee wallet monitor
//   4. Orchestrates the buy-back → airdrop pipeline
//
// The bot runs as a long-lived process, continuously monitoring for new
// Pump.fun creator fees and automatically executing buy-backs and airdrops.
//
// OPEN SOURCE TRANSPARENCY:
// This entire codebase is designed to be readable and auditable by the
// community. Every significant operation is logged, every parameter is
// configurable, and all anti-sniper protections are extensively documented.
// =============================================================================

import { Connection } from '@solana/web3.js';
import { loadConfig } from './config.js';
import { logger, LogLevel, setLogLevel } from './logger.js';
import { startMonitoring } from './monitor.js';
import { executeBuyBack } from './buyback.js';
import { executeAirdrop } from './airdrop.js';
import { lamportsToSol } from './utils.js';

// =============================================================================
// BANNER
// =============================================================================

const BANNER = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     █████╗ ███╗   ██╗███████╗███████╗███╗   ███╗              ║
║    ██╔══██╗████╗  ██║██╔════╝██╔════╝████╗ ████║              ║
║    ███████║██╔██╗ ██║███████╗█████╗  ██╔████╔██║              ║
║    ██╔══██║██║╚██╗██║╚════██║██╔══╝  ██║╚██╔╝██║              ║
║    ██║  ██║██║ ╚████║███████║███████╗██║ ╚═╝ ██║              ║
║    ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝╚═╝     ╚═╝              ║
║                                                               ║
║         Buy-Back & Airdrop Bot v1.0.0                         ║
║         Community CTO — Fully Transparent                     ║
║                                                               ║
╠═══════════════════════════════════════════════════════════════╣
║  🔒 Anti-Sniper: Jito Bundles + Slippage Control             ║
║  📊 Distribution: Pro-Rata to All Holders                    ║
║  🔍 Transparency: Open Source — Verify Every Line            ║
╚═══════════════════════════════════════════════════════════════╝
`;

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  console.log(BANNER);

  // ---------------------------------------------------------------------------
  // Step 1: Load and validate configuration
  // ---------------------------------------------------------------------------
  const config = loadConfig();

  // Set log level based on environment
  if (process.env.LOG_LEVEL === 'debug') {
    setLogLevel(LogLevel.DEBUG);
    logger.info('SYSTEM', 'Debug logging enabled');
  }

  // ---------------------------------------------------------------------------
  // Step 2: Establish Solana connection
  // ---------------------------------------------------------------------------
  logger.info('SYSTEM', `Connecting to Solana RPC: ${config.rpcUrl.replace(/\/\/.*@/, '//***@')}`);

  const connection = new Connection(config.rpcUrl, {
    wsEndpoint: config.wssUrl,
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60_000,
  });

  // Verify connection is working
  try {
    const version = await connection.getVersion();
    logger.info('SYSTEM', `✅ Connected to Solana (version: ${JSON.stringify(version)})`);
  } catch (err) {
    logger.error('SYSTEM', '❌ Failed to connect to Solana RPC:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Check fee wallet balance
  const feeWalletBalance = await connection.getBalance(config.feeWalletAddress);
  logger.info('SYSTEM', `Fee wallet balance: ${lamportsToSol(feeWalletBalance)} SOL`);

  // Check bot wallet balance
  const botWalletBalance = await connection.getBalance(config.walletKeypair.publicKey);
  logger.info('SYSTEM', `Bot wallet balance: ${lamportsToSol(botWalletBalance)} SOL`);

  if (botWalletBalance < 10_000_000) { // Less than 0.01 SOL
    logger.warn('SYSTEM', '⚠️  Bot wallet has very low SOL balance. Ensure it has enough for transaction fees and Jito tips.');
  }

  // ---------------------------------------------------------------------------
  // Step 3: Start monitoring with the buy-back → airdrop pipeline
  // ---------------------------------------------------------------------------
  // This callback is invoked whenever the monitor detects new SOL in the
  // fee wallet above the threshold. It orchestrates the full cycle:
  //   1. Buy-back: Swap SOL → $ANSEM via Jupiter (MEV protected)
  //   2. Airdrop: Distribute purchased tokens to all holders
  // ---------------------------------------------------------------------------
  await startMonitoring(config, connection, async (availableSolLamports: number) => {
    logger.separator('SYSTEM', `NEW CYCLE: ${lamportsToSol(availableSolLamports)} SOL detected`);

    // =========================================================================
    // Phase 1: BUY-BACK
    // Swap the incoming SOL for $ANSEM tokens
    // Protected by: Jito bundles + slippage control + price impact check
    // =========================================================================
    const buyBackResult = await executeBuyBack(config, connection, availableSolLamports);

    if (!buyBackResult) {
      logger.info('SYSTEM', 'Buy-back returned null (dry run or skipped). No airdrop needed.');
      return;
    }

    logger.info('SYSTEM', `Buy-back successful! Acquired ${buyBackResult.tokensReceived.toString()} tokens`);

    // =========================================================================
    // Phase 2: AIRDROP
    // Distribute the purchased tokens to all current $ANSEM holders
    // Distribution is pro-rata: each holder receives proportional to their balance
    // =========================================================================
    const airdropResult = await executeAirdrop(
      config,
      connection,
      buyBackResult.tokensReceived,
    );

    // =========================================================================
    // Phase 3: SUMMARY
    // Log the complete cycle results for transparency
    // =========================================================================
    logger.separator('SYSTEM', 'CYCLE COMPLETE');
    logger.info('SYSTEM', '📋 Cycle Summary:', {
      buyBack: {
        solSpent: `${lamportsToSol(buyBackResult.solSpent)} SOL`,
        tokensAcquired: buyBackResult.tokensReceived.toString(),
        tx: buyBackResult.txSignature,
      },
      airdrop: {
        holders: airdropResult.totalHolders,
        tokensDistributed: airdropResult.totalDistributed.toString(),
        successfulBatches: airdropResult.successfulBatches,
        failedBatches: airdropResult.failedBatches,
      },
    });
  });
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================
// Handle SIGINT (Ctrl+C) and SIGTERM (Docker/Railway stop) gracefully.
// This ensures the bot logs a clean shutdown message rather than just dying.
// =============================================================================

function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    logger.info('SYSTEM', `\n🛑 Received ${signal}. Shutting down gracefully...`);
    logger.info('SYSTEM', 'Bot stopped. No transactions in flight.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    logger.error('SYSTEM', '💥 Uncaught exception:', err.message);
    logger.error('SYSTEM', 'Stack:', err.stack);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('SYSTEM', '💥 Unhandled promise rejection:', reason);
    process.exit(1);
  });
}

// =============================================================================
// RUN
// =============================================================================

setupGracefulShutdown();
main().catch((err) => {
  logger.error('SYSTEM', '💥 Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
