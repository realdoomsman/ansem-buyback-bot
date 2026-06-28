// =============================================================================
// $ANSEM Buy-Back & Airdrop Bot — Airdrop Engine
// =============================================================================
// This module handles two critical tasks:
//   1. Taking a SNAPSHOT of all current $ANSEM token holders
//   2. Distributing purchased tokens PRO-RATA to all eligible holders
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │                    HOW THE AIRDROP DISTRIBUTION WORKS                      │
// ├─────────────────────────────────────────────────────────────────────────────┤
// │                                                                           │
// │  1. SNAPSHOT: We query ALL token accounts for the $ANSEM mint on-chain    │
// │     using getProgramAccounts. This gives us every wallet that holds        │
// │     $ANSEM tokens and their exact balance.                                │
// │                                                                           │
// │  2. FILTERING: We exclude:                                                │
// │     - The bot's own wallet (we don't airdrop to ourselves)                │
// │     - The fee wallet (creator fee wallet)                                 │
// │     - Zero-balance accounts (empty token accounts)                        │
// │     - Dust accounts (below configurable minimum)                          │
// │     - Known system/program addresses                                      │
// │                                                                           │
// │  3. PRO-RATA CALCULATION: Each holder receives tokens proportional to     │
// │     their share of total holdings:                                        │
// │                                                                           │
// │     holder_share = (holder_balance / total_eligible_balance) * tokens      │
// │                                                                           │
// │     Example: If you hold 10% of all $ANSEM, you receive 10% of the       │
// │     airdrop. This is the fairest distribution method.                     │
// │                                                                           │
// │  4. BATCHING: Solana transactions have size limits, so we batch the       │
// │     airdrop into groups of ~20 recipients per transaction.                │
// │                                                                           │
// │  5. MEV PROTECTION: Airdrop batches are also submitted via Jito bundles   │
// │     to prevent front-running (though the risk is lower for airdrops       │
// │     than swaps).                                                          │
// │                                                                           │
// └─────────────────────────────────────────────────────────────────────────────┘
// =============================================================================

import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  AccountLayout,
  TOKEN_PROGRAM_ID,
  createTransferInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  TokenAccountNotFoundError,
} from '@solana/spl-token';
import axios from 'axios';
import bs58 from 'bs58';

import { BotConfig, JITO_BLOCK_ENGINE_URL } from './config.js';
import { logger } from './logger.js';
import {
  formatTokenAmount,
  getRandomTipAccount,
  lamportsToSol,
  retryWithBackoff,
  sleep,
} from './utils.js';

// =============================================================================
// TYPES
// =============================================================================

/** Represents a single token holder extracted from on-chain data */
export interface TokenHolder {
  /** The wallet address (owner) of the token account */
  walletAddress: PublicKey;
  /** The associated token account address */
  tokenAccount: PublicKey;
  /** Current token balance (raw, as BigInt) */
  balance: bigint;
}

/** Result of an airdrop distribution */
export interface AirdropResult {
  /** Total number of eligible holders */
  totalHolders: number;
  /** Total tokens distributed */
  totalDistributed: bigint;
  /** Number of successful transfer batches */
  successfulBatches: number;
  /** Number of failed transfer batches */
  failedBatches: number;
  /** Transaction signatures for successful batches */
  txSignatures: string[];
}

// =============================================================================
// STEP 1: SNAPSHOT — Get All Token Holders
// =============================================================================

/**
 * Query the Solana blockchain for ALL current $ANSEM token holders.
 *
 * HOW IT WORKS:
 * Every SPL token balance is stored in a "token account" — a separate account
 * on Solana that is owned by the Token Program. Each token account stores:
 *   - The MINT (which token it holds)      → offset 0, 32 bytes
 *   - The OWNER (which wallet controls it) → offset 32, 32 bytes
 *   - The AMOUNT (how many tokens)          → offset 64, 8 bytes
 *
 * We use getProgramAccounts to find ALL token accounts where:
 *   - The program owner is the SPL Token Program
 *   - The data size is exactly 165 bytes (standard token account)
 *   - The first 32 bytes (mint) match our $ANSEM token address
 *
 * This is equivalent to asking: "Give me every wallet that holds $ANSEM"
 *
 * ⚠️ NOTE: This is a heavy RPC call. Free/public RPCs will reject it.
 * A premium RPC provider (Helius, QuickNode) is REQUIRED.
 *
 * @param config     - Bot configuration
 * @param connection - Solana RPC connection
 * @returns Array of all token holders with their balances
 */
export async function getTokenHolders(
  config: BotConfig,
  connection: Connection,
): Promise<TokenHolder[]> {
  logger.separator('AIRDROP', 'TAKING HOLDER SNAPSHOT');
  logger.info('AIRDROP', `Querying all holders of mint: ${config.holderTokenMint.toBase58()}`);

  // ---------------------------------------------------------------------------
  // Query all SPL token accounts for our mint
  // ---------------------------------------------------------------------------
  // The filters work as follows:
  //   1. dataSize: 165 → only standard SPL token accounts (not Token-2022)
  //   2. memcmp offset 0 → the first 32 bytes must match our mint address
  //      This is where the token's mint address is stored in the account data
  // ---------------------------------------------------------------------------
  const accounts = await retryWithBackoff(
    () =>
      connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          {
            dataSize: 165, // Standard SPL token account size in bytes
          },
          {
            memcmp: {
              offset: 0,   // Mint address starts at byte 0
              bytes: config.holderTokenMint.toBase58(),
            },
          },
        ],
      }),
    3,
    2000,
    'getProgramAccounts (holder snapshot)',
  );

  logger.info('AIRDROP', `Found ${accounts.length} raw token accounts`);

  // ---------------------------------------------------------------------------
  // Parse each account's data to extract owner and balance
  // ---------------------------------------------------------------------------
  // AccountLayout.decode() parses the 165-byte buffer into structured fields:
  //   - mint:   PublicKey (bytes 0-31)
  //   - owner:  PublicKey (bytes 32-63) ← this is the WALLET that owns the tokens
  //   - amount: u64/BigInt (bytes 64-71) ← the token balance
  // ---------------------------------------------------------------------------
  const holders: TokenHolder[] = [];

  for (const account of accounts) {
    const data = AccountLayout.decode(account.account.data);
    const owner = new PublicKey(data.owner);
    const balance = data.amount; // This is a BigInt

    holders.push({
      walletAddress: owner,
      tokenAccount: account.pubkey,
      balance,
    });
  }

  logger.info('AIRDROP', `Parsed ${holders.length} holder accounts`);
  return holders;
}

// =============================================================================
// STEP 2: FILTER — Remove Ineligible Holders
// =============================================================================

/**
 * Filter the raw holder list to only include eligible airdrop recipients.
 *
 * We exclude several categories of accounts to ensure the airdrop only goes
 * to real community members:
 *
 *   1. BOT'S OWN WALLET — we don't airdrop tokens back to ourselves
 *   2. FEE WALLET — the creator fee wallet shouldn't receive airdrops
 *   3. ZERO BALANCES — empty token accounts (user sold everything)
 *   4. DUST ACCOUNTS — balances below the minimum threshold
 *      (configurable, default 1 token). This prevents wasting transaction
 *      fees on sending fractions of a token to inactive wallets.
 *   5. KNOWN SYSTEM ADDRESSES — burn addresses, program accounts, etc.
 *
 * @param holders       - Raw holder list from getTokenHolders
 * @param config        - Bot configuration
 * @returns Filtered array of eligible holders
 */
export function filterEligibleHolders(
  holders: TokenHolder[],
  config: BotConfig,
): TokenHolder[] {
  logger.info('AIRDROP', 'Filtering eligible holders...');

  // Known addresses to exclude from airdrops
  const excludedAddresses = new Set<string>([
    config.walletKeypair.publicKey.toBase58(),  // Bot wallet
    config.feeWalletAddress.toBase58(),          // Fee wallet
    '11111111111111111111111111111111',           // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
    '1nc1nerator11111111111111111111111111111111', // Common burn address
  ]);

  const eligible = holders.filter((holder) => {
    // Skip excluded addresses
    if (excludedAddresses.has(holder.walletAddress.toBase58())) {
      return false;
    }

    // Skip zero balances
    if (holder.balance === 0n) {
      return false;
    }

    // Skip dust accounts (below minimum threshold)
    if (holder.balance < config.airdropDustThreshold) {
      return false;
    }

    return true;
  });

  const excluded = holders.length - eligible.length;
  logger.info('AIRDROP', `Eligible holders: ${eligible.length} (excluded ${excluded} accounts)`, {
    total: holders.length,
    eligible: eligible.length,
    excluded,
    dustThreshold: config.airdropDustThreshold.toString(),
  });

  return eligible;
}

// =============================================================================
// STEP 3: CALCULATE PRO-RATA DISTRIBUTION
// =============================================================================

/**
 * Calculate how many tokens each holder should receive.
 *
 * PRO-RATA FORMULA:
 *   holder_share = (holder_balance / total_eligible_balance) * tokens_to_distribute
 *
 * This means:
 *   - If you hold 10% of all $ANSEM tokens, you get 10% of the airdrop
 *   - If you hold 1% of all $ANSEM tokens, you get 1% of the airdrop
 *   - The more $ANSEM you hold, the more you receive — rewarding loyal holders
 *
 * PRECISION NOTE:
 * We use BigInt arithmetic throughout to avoid floating-point precision issues.
 * The formula is: (holderBalance * tokensToDistribute) / totalBalance
 * This ensures no rounding errors that could cause us to distribute more
 * tokens than we have.
 *
 * DUST HANDLING:
 * Due to integer division, some tokens may be left undistributed (remainder).
 * These stay in the bot's wallet and will be included in the next airdrop.
 *
 * @param holders            - Eligible holders list
 * @param tokensToDistribute - Total tokens available for this airdrop (raw BigInt)
 * @returns Map of wallet address → amount to receive
 */
export function calculateDistribution(
  holders: TokenHolder[],
  tokensToDistribute: bigint,
): Map<string, { holder: TokenHolder; amount: bigint }> {
  logger.info('AIRDROP', `Calculating pro-rata distribution for ${tokensToDistribute.toString()} tokens`);

  // Calculate total balance across all eligible holders
  const totalBalance = holders.reduce(
    (sum, holder) => sum + holder.balance,
    0n,
  );

  if (totalBalance === 0n) {
    logger.warn('AIRDROP', 'Total eligible balance is zero — no distribution possible');
    return new Map();
  }

  logger.info('AIRDROP', `Total eligible holder balance: ${totalBalance.toString()}`);

  const distribution = new Map<string, { holder: TokenHolder; amount: bigint }>();
  let totalAllocated = 0n;

  for (const holder of holders) {
    // PRO-RATA FORMULA (BigInt arithmetic):
    // amount = (holderBalance * tokensToDistribute) / totalBalance
    //
    // We multiply BEFORE dividing to maintain precision.
    // Integer division truncates (rounds down), so we never over-allocate.
    const amount = (holder.balance * tokensToDistribute) / totalBalance;

    if (amount > 0n) {
      distribution.set(holder.walletAddress.toBase58(), {
        holder,
        amount,
      });
      totalAllocated += amount;
    }
  }

  // Log the distribution summary
  const remainder = tokensToDistribute - totalAllocated;
  logger.info('AIRDROP', 'Distribution calculated:', {
    recipients: distribution.size,
    totalAllocated: totalAllocated.toString(),
    remainder: remainder.toString(),
    note: remainder > 0n ? 'Remainder stays in bot wallet for next cycle' : 'No remainder',
  });

  return distribution;
}

// =============================================================================
// STEP 4: EXECUTE AIRDROP — Batch Token Transfers
// =============================================================================

/**
 * Execute the airdrop by sending tokens to all eligible holders in batches.
 *
 * WHY BATCHING?
 * Solana transactions have a maximum size of 1232 bytes. Each SPL token
 * transfer instruction takes ~100 bytes. If we tried to send to all holders
 * in one transaction, it would exceed the limit. By batching into groups
 * of ~20, we stay well within the transaction size limit.
 *
 * Each batch is submitted as a Jito bundle for consistency with our
 * MEV protection approach (though airdrop transactions are less susceptible
 * to MEV than swaps).
 *
 * @param config             - Bot configuration
 * @param connection         - Solana RPC connection
 * @param tokensToDistribute - Total tokens purchased in the buy-back
 * @returns AirdropResult with distribution statistics
 */
export async function executeAirdrop(
  config: BotConfig,
  connection: Connection,
  tokensToDistribute: bigint,
): Promise<AirdropResult> {
  logger.separator('AIRDROP', 'EXECUTING AIRDROP DISTRIBUTION');

  // =========================================================================
  // Step 4a: Take a snapshot of all current holders
  // =========================================================================
  const allHolders = await getTokenHolders(config, connection);

  // =========================================================================
  // Step 4b: Filter to eligible recipients only
  // =========================================================================
  const eligibleHolders = filterEligibleHolders(allHolders, config);

  if (eligibleHolders.length === 0) {
    logger.warn('AIRDROP', 'No eligible holders found — skipping airdrop');
    return {
      totalHolders: 0,
      totalDistributed: 0n,
      successfulBatches: 0,
      failedBatches: 0,
      txSignatures: [],
    };
  }

  // =========================================================================
  // Step 4c: Calculate pro-rata distribution amounts
  // =========================================================================
  const distribution = calculateDistribution(eligibleHolders, tokensToDistribute);
  const recipients = Array.from(distribution.values());

  if (recipients.length === 0) {
    logger.warn('AIRDROP', 'All calculated amounts are zero — skipping airdrop');
    return {
      totalHolders: 0,
      totalDistributed: 0n,
      successfulBatches: 0,
      failedBatches: 0,
      txSignatures: [],
    };
  }

  // DRY RUN CHECK
  if (config.dryRun) {
    logger.warn('AIRDROP', '🏜️  DRY RUN — would distribute to these holders:', {
      recipients: recipients.length,
      topHolders: recipients
        .sort((a, b) => (b.amount > a.amount ? 1 : -1))
        .slice(0, 10)
        .map((r) => ({
          wallet: r.holder.walletAddress.toBase58().slice(0, 8) + '...',
          amount: r.amount.toString(),
        })),
    });
    return {
      totalHolders: recipients.length,
      totalDistributed: 0n,
      successfulBatches: 0,
      failedBatches: 0,
      txSignatures: [],
    };
  }

  // =========================================================================
  // Step 4d: Get the bot's token account (source of airdrop tokens)
  // =========================================================================
  const botTokenAccount = await getAssociatedTokenAddress(
    config.tokenMintAddress,
    config.walletKeypair.publicKey,
  );

  logger.info('AIRDROP', `Bot token account: ${botTokenAccount.toBase58()}`);

  // =========================================================================
  // Step 4e: Split recipients into batches and execute
  // =========================================================================
  const batches: typeof recipients[] = [];
  for (let i = 0; i < recipients.length; i += config.airdropBatchSize) {
    batches.push(recipients.slice(i, i + config.airdropBatchSize));
  }

  logger.info('AIRDROP', `Distributing to ${recipients.length} holders in ${batches.length} batches`);

  let successfulBatches = 0;
  let failedBatches = 0;
  let totalDistributed = 0n;
  const txSignatures: string[] = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    logger.info('AIRDROP', `Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} recipients)`);

    try {
      const signature = await sendAirdropBatch(
        config,
        connection,
        botTokenAccount,
        batch,
      );

      successfulBatches++;
      txSignatures.push(signature);

      // Track total distributed
      for (const recipient of batch) {
        totalDistributed += recipient.amount;
      }

      logger.info('AIRDROP', `✅ Batch ${batchIndex + 1} complete: https://solscan.io/tx/${signature}`);

      // Small delay between batches to avoid rate limiting
      if (batchIndex < batches.length - 1) {
        await sleep(2000);
      }
    } catch (err) {
      failedBatches++;
      logger.error('AIRDROP', `❌ Batch ${batchIndex + 1} failed:`, err instanceof Error ? err.message : err);
      // Continue with remaining batches — don't let one failure stop everything
    }
  }

  // =========================================================================
  // Step 4f: Log final results
  // =========================================================================
  const result: AirdropResult = {
    totalHolders: recipients.length,
    totalDistributed,
    successfulBatches,
    failedBatches,
    txSignatures,
  };

  logger.separator('AIRDROP', 'AIRDROP COMPLETE');
  logger.info('AIRDROP', '📊 Distribution Summary:', {
    totalHolders: result.totalHolders,
    totalDistributed: result.totalDistributed.toString(),
    successfulBatches: result.successfulBatches,
    failedBatches: result.failedBatches,
    transactions: result.txSignatures.length,
  });

  return result;
}

// =============================================================================
// HELPER: Send a Single Airdrop Batch
// =============================================================================

/**
 * Send tokens to a batch of recipients in a single transaction.
 *
 * For each recipient, we:
 *   1. Derive their Associated Token Account (ATA) address
 *   2. Check if the ATA exists; if not, add a create instruction
 *   3. Add a transfer instruction for their pro-rata amount
 *
 * The transaction is then submitted via Jito bundle for consistency.
 *
 * @param config          - Bot configuration
 * @param connection      - Solana RPC connection
 * @param sourceAccount   - Bot's token account (source of tokens)
 * @param recipients      - Array of recipients with amounts
 * @returns Transaction signature
 */
async function sendAirdropBatch(
  config: BotConfig,
  connection: Connection,
  sourceAccount: PublicKey,
  recipients: { holder: TokenHolder; amount: bigint }[],
): Promise<string> {
  const instructions = [];

  for (const { holder, amount } of recipients) {
    // Derive the recipient's Associated Token Account (ATA)
    // This is the standard token account address for their wallet + our mint
    const recipientAta = await getAssociatedTokenAddress(
      config.tokenMintAddress,
      holder.walletAddress,
    );

    // Check if the ATA already exists
    // If not, we need to create it (and pay the rent ~0.002 SOL)
    try {
      await getAccount(connection, recipientAta);
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) {
        // ATA doesn't exist — add instruction to create it
        // The bot pays the rent for new accounts
        instructions.push(
          createAssociatedTokenAccountInstruction(
            config.walletKeypair.publicKey,  // Payer (bot)
            recipientAta,                      // ATA to create
            holder.walletAddress,              // Owner of the ATA
            config.tokenMintAddress,           // Token mint
          ),
        );
        logger.debug('AIRDROP', `Creating ATA for ${holder.walletAddress.toBase58().slice(0, 8)}...`);
      } else {
        // Unexpected error — skip this recipient
        logger.warn('AIRDROP', `Skipping ${holder.walletAddress.toBase58()}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }

    // Add the transfer instruction
    instructions.push(
      createTransferInstruction(
        sourceAccount,                       // From: bot's token account
        recipientAta,                        // To: recipient's token account
        config.walletKeypair.publicKey,       // Authority: bot wallet
        amount,                              // Amount to transfer
      ),
    );
  }

  if (instructions.length === 0) {
    throw new Error('No valid transfer instructions in batch');
  }

  // Build and sign the transaction
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const message = new TransactionMessage({
    payerKey: config.walletKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([config.walletKeypair]);

  // Submit via Jito bundle (with tip)
  const tipAccount = getRandomTipAccount();
  const tipInstruction = SystemProgram.transfer({
    fromPubkey: config.walletKeypair.publicKey,
    toPubkey: tipAccount,
    lamports: config.jitoTipLamports,
  });

  const tipMessage = new TransactionMessage({
    payerKey: config.walletKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [tipInstruction],
  }).compileToV0Message();

  const tipTransaction = new VersionedTransaction(tipMessage);
  tipTransaction.sign([config.walletKeypair]);

  // Build and submit the Jito bundle
  const bundle = [
    bs58.encode(Buffer.from(transaction.serialize())),
    bs58.encode(Buffer.from(tipTransaction.serialize())),
  ];

  try {
    const response = await axios.post(JITO_BLOCK_ENGINE_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [bundle],
    });

    const bundleId = response.data?.result;
    if (bundleId) {
      logger.info('JITO', `Airdrop batch bundle submitted: ${bundleId}`);

      // Wait for landing (shorter timeout for airdrops)
      for (let i = 0; i < 15; i++) {
        await sleep(2000);
        try {
          const statusResponse = await axios.post(JITO_BLOCK_ENGINE_URL, {
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          });
          const statuses = statusResponse.data?.result?.value;
          if (statuses?.[0]?.confirmation_status === 'confirmed' ||
              statuses?.[0]?.confirmation_status === 'finalized') {
            return bs58.encode(transaction.signatures[0]);
          }
        } catch {
          // Continue polling
        }
      }
    }
  } catch (jitoErr) {
    logger.warn('AIRDROP', 'Jito bundle failed for airdrop batch, using direct send...');
  }

  // Fallback: direct RPC submission
  const signature = await connection.sendRawTransaction(
    Buffer.from(transaction.serialize()),
    { skipPreflight: false, maxRetries: 3 },
  );

  const { blockhash: confirmBlockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction(
    { signature, blockhash: confirmBlockhash, lastValidBlockHeight },
    'confirmed',
  );

  return signature;
}
