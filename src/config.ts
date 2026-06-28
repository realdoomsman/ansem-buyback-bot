// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Configuration
// =============================================================================
// All configuration is loaded from environment variables for security.
// This module validates that all required values are present at startup,
// failing fast with clear error messages if anything is missing.
//
// TRANSPARENCY NOTE: Every configurable parameter is documented here so the
// community can verify exactly how the bot behaves.
// =============================================================================

import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { logger } from './logger.js';

// Load .env file into process.env
dotenv.config();

// =============================================================================
// JITO TIP ACCOUNTS
// =============================================================================
// These are the official Jito tip accounts. When submitting a bundle, we pay
// a tip to one of these accounts to incentivize validators to include our
// bundle. We pick one at random to distribute load.
//
// Source: https://jito-labs.gitbook.io/mev/searcher-resources/tip-accounts
// =============================================================================
export const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey('96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5'),
  new PublicKey('HFqU5x63VTqvQss8hp11i4bPHijDRUoFAkfP3DAxXLas'),
  new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY'),
  new PublicKey('ADaUMid9yfUytqMBgopwjb2DTLSEGKLKneFiLrGF2GYJ'),
  new PublicKey('DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh'),
  new PublicKey('ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt'),
  new PublicKey('DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL'),
  new PublicKey('3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'),
];

// =============================================================================
// CONSTANTS
// =============================================================================
// Wrapped SOL mint — used as the input token for Jupiter swaps.
// When swapping SOL → Token, Jupiter needs the wrapped SOL mint address.
// =============================================================================
export const WRAPPED_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/** Jupiter V6 API base URL */
export const JUPITER_API_BASE = 'https://quote-api.jup.ag/v6';

/** Jito Block Engine bundle submission endpoint */
export const JITO_BLOCK_ENGINE_URL = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';

// =============================================================================
// CONFIGURATION INTERFACE
// =============================================================================

export interface BotConfig {
  // --- RPC ---
  rpcUrl: string;
  wssUrl: string;

  // --- Wallets ---
  walletKeypair: Keypair;
  feeWalletAddress: PublicKey;

  // --- Token ---
  tokenMintAddress: PublicKey;

  // --- Bot Parameters ---
  /** Minimum SOL (lamports) to trigger a buy-back */
  minSolThreshold: number;
  /** SOL (lamports) reserved for tx fees — never spent on swaps */
  reservedSolForFees: number;
  /** How often to poll balance (ms) — fallback for WebSocket */
  pollingIntervalMs: number;

  // --- Swap ---
  /** Max slippage in basis points (1 bps = 0.01%) */
  slippageBps: number;
  /** Max acceptable price impact (percent) */
  maxPriceImpactPercent: number;

  // --- Jito ---
  /** Tip amount in lamports to pay Jito validators */
  jitoTipLamports: number;

  // --- Airdrop ---
  /** Minimum token balance to qualify for airdrop */
  airdropDustThreshold: bigint;
  /** Recipients per airdrop transaction batch */
  airdropBatchSize: number;

  // --- Mode ---
  /** If true, logs everything but sends no transactions */
  dryRun: boolean;
}

// =============================================================================
// CONFIGURATION LOADER
// =============================================================================

/**
 * Load and validate all configuration from environment variables.
 * Throws immediately with a clear message if any required value is missing.
 *
 * This is called once at startup. If it succeeds, the returned config
 * object is guaranteed to have all values populated and valid.
 */
export function loadConfig(): BotConfig {
  logger.info('SYSTEM', 'Loading configuration from environment...');

  const errors: string[] = [];

  // --- Required values ---
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) errors.push('SOLANA_RPC_URL is required');

  const wssUrl = process.env.SOLANA_WSS_URL;
  if (!wssUrl) errors.push('SOLANA_WSS_URL is required');

  const privateKeyStr = process.env.WALLET_PRIVATE_KEY;
  if (!privateKeyStr) errors.push('WALLET_PRIVATE_KEY is required');

  const feeWalletStr = process.env.FEE_WALLET_ADDRESS;
  if (!feeWalletStr) errors.push('FEE_WALLET_ADDRESS is required');

  const tokenMintStr = process.env.TOKEN_MINT_ADDRESS || 'EPD8jj7bVhNh3o7Wx1XZ39aaacSki8p2ABaN61yhUnBh';

  // Fail fast if required values are missing
  if (errors.length > 0) {
    logger.error('SYSTEM', 'Configuration validation failed:', errors);
    throw new Error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`);
  }

  // --- Parse keypair ---
  let walletKeypair: Keypair;
  try {
    const privateKeyBytes = bs58.decode(privateKeyStr!);
    walletKeypair = Keypair.fromSecretKey(privateKeyBytes);
    logger.info('SYSTEM', `Bot wallet loaded: ${walletKeypair.publicKey.toBase58()}`);
  } catch (err) {
    throw new Error('WALLET_PRIVATE_KEY is not a valid base58-encoded Solana keypair');
  }

  // --- Parse public keys ---
  let feeWalletAddress: PublicKey;
  try {
    feeWalletAddress = new PublicKey(feeWalletStr!);
  } catch {
    throw new Error(`FEE_WALLET_ADDRESS is not a valid Solana public key: ${feeWalletStr}`);
  }

  let tokenMintAddress: PublicKey;
  try {
    tokenMintAddress = new PublicKey(tokenMintStr);
  } catch {
    throw new Error(`TOKEN_MINT_ADDRESS is not a valid Solana public key: ${tokenMintStr}`);
  }

  // --- Parse optional numeric values with defaults ---
  const config: BotConfig = {
    rpcUrl: rpcUrl!,
    wssUrl: wssUrl!,
    walletKeypair,
    feeWalletAddress,
    tokenMintAddress,
    minSolThreshold: parseInt(process.env.MIN_SOL_THRESHOLD || '50000000', 10),
    reservedSolForFees: parseInt(process.env.RESERVED_SOL_FOR_FEES || '10000000', 10),
    pollingIntervalMs: parseInt(process.env.POLLING_INTERVAL_MS || '30000', 10),
    slippageBps: parseInt(process.env.SLIPPAGE_BPS || '50', 10),
    maxPriceImpactPercent: parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT || '5'),
    jitoTipLamports: parseInt(process.env.JITO_TIP_LAMPORTS || '5000000', 10),
    airdropDustThreshold: BigInt(process.env.AIRDROP_DUST_THRESHOLD || '1000000'),
    airdropBatchSize: parseInt(process.env.AIRDROP_BATCH_SIZE || '20', 10),
    dryRun: process.env.DRY_RUN === 'true',
  };

  // --- Log the loaded configuration (redact sensitive values) ---
  logger.info('SYSTEM', 'Configuration loaded successfully:', {
    rpcUrl: config.rpcUrl.replace(/\/\/.*@/, '//***@'),  // Redact API keys in URL
    feeWallet: config.feeWalletAddress.toBase58(),
    tokenMint: config.tokenMintAddress.toBase58(),
    minSolThreshold: `${config.minSolThreshold / LAMPORTS_PER_SOL} SOL`,
    reservedForFees: `${config.reservedSolForFees / LAMPORTS_PER_SOL} SOL`,
    slippageBps: config.slippageBps,
    maxPriceImpact: `${config.maxPriceImpactPercent}%`,
    jitoTip: `${config.jitoTipLamports / LAMPORTS_PER_SOL} SOL`,
    airdropBatchSize: config.airdropBatchSize,
    dryRun: config.dryRun,
  });

  if (config.dryRun) {
    logger.warn('SYSTEM', '🏜️  DRY RUN MODE — no transactions will be sent');
  }

  return config;
}
