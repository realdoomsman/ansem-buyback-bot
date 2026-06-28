# $ANSEM Buy-Back & Airdrop Bot

> **Fully transparent, open-source automated buy-back and airdrop system for the $ANSEM community CTO on Pump.fun.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🎯 What This Bot Does

This bot automates the **buy-back and redistribution** of Pump.fun creator fees to $ANSEM token holders:

1. **Monitors** a designated Solana wallet for incoming SOL (Pump.fun creator fees)
2. **Buys back** $ANSEM tokens using the accumulated SOL via Jupiter Aggregator
3. **Airdrops** the purchased tokens to all current $ANSEM holders, proportional to their holdings

Every operation is logged, every parameter is configurable, and the entire codebase is open-source for community verification.

## 🔒 Anti-Sniper & MEV Protection

The buy-back swap is protected by **three layers of defense** against MEV (Maximal Extractable Value) extraction:

### Layer 1: Jito Bundle Submission
Instead of broadcasting to the public mempool (where bots can see and front-run our swap), transactions are submitted as **Jito bundles** directly to Jito-powered validators. The swap is never visible to MEV bots until it's already confirmed on-chain.

### Layer 2: Strict Slippage Controls
Every swap has a maximum slippage tolerance (default 0.5%). If the price moves more than this between the quote and execution, the transaction automatically reverts — limiting potential damage from any price manipulation.

### Layer 3: Price Impact Validation
Before executing, the bot checks Jupiter's reported price impact. If the swap would move the price more than the configured threshold (default 5%), it's rejected entirely. This prevents buying during extremely illiquid conditions.

## 📊 Airdrop Distribution

Tokens are distributed using a **pro-rata** (proportional) model:

```
your_share = (your_balance / total_eligible_balance) × tokens_purchased
```

- Hold 10% of $ANSEM → receive 10% of the airdrop
- Hold 1% of $ANSEM → receive 1% of the airdrop
- The more you hold, the more you receive — **rewarding loyal holders**

### Eligibility
- Must hold at least 1 $ANSEM token (configurable)
- Bot and fee wallets are excluded
- Zero-balance and dust accounts are excluded

## 🏗️ Architecture

```
src/
├── index.ts      # Entry point — orchestrates the full pipeline
├── config.ts     # Configuration loading & validation
├── monitor.ts    # Fee wallet monitoring (WebSocket + polling)
├── buyback.ts    # Jupiter swap + Jito MEV protection
├── airdrop.ts    # Holder snapshot + token distribution
├── utils.ts      # Shared utilities
└── logger.ts     # Structured logging
```

### Flow

```
Fee Wallet receives SOL (Pump.fun creator fees)
        ↓
Monitor detects balance increase
        ↓
Buy-Back Engine:
  1. Fetch Jupiter quote (best route)
  2. Validate price impact
  3. Build & sign swap transaction
  4. Submit via Jito bundle (MEV protected)
        ↓
Airdrop Engine:
  1. Snapshot all $ANSEM holders
  2. Filter eligible recipients
  3. Calculate pro-rata amounts
  4. Batch transfer tokens
        ↓
Cycle complete — resume monitoring
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ (recommended: 20+)
- A Solana wallet with SOL for transaction fees
- A **premium RPC endpoint** (Helius, QuickNode, or Triton) — required for holder snapshots

### Setup

```bash
# Clone the repository
git clone https://github.com/your-org/ansem-buyback-bot.git
cd ansem-buyback-bot

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env with your values (see Configuration section below)
```

### Configuration

Edit your `.env` file with the following values:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SOLANA_RPC_URL` | ✅ | — | Premium RPC endpoint (Helius, QuickNode) |
| `SOLANA_WSS_URL` | ✅ | — | WebSocket RPC endpoint |
| `WALLET_PRIVATE_KEY` | ✅ | — | Bot wallet private key (base58) |
| `FEE_WALLET_ADDRESS` | ✅ | — | Pump.fun creator fee wallet to monitor |
| `TOKEN_MINT_ADDRESS` | ❌ | `EPD8jj7...` | $ANSEM token mint address |
| `MIN_SOL_THRESHOLD` | ❌ | `50000000` | Min SOL (lamports) to trigger buy-back |
| `SLIPPAGE_BPS` | ❌ | `50` | Max slippage in basis points |
| `JITO_TIP_LAMPORTS` | ❌ | `5000000` | Jito tip amount (lamports) |
| `AIRDROP_BATCH_SIZE` | ❌ | `20` | Recipients per airdrop transaction |
| `DRY_RUN` | ❌ | `false` | Set `true` to simulate without sending txs |

### Run

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start

# Dry run (no real transactions)
DRY_RUN=true npm run dev
```

## ☁️ Deployment

### Railway (Recommended)

1. Fork this repo to your GitHub account
2. Go to [Railway](https://railway.app) and create a new project
3. Select "Deploy from GitHub repo" and choose your fork
4. Add all environment variables from `.env.example` in the Railway dashboard
5. Railway will automatically build and deploy

The included `railway.toml` configures the build and start commands.

### Docker

```bash
# Build the image
docker build -t ansem-bot .

# Run with environment variables
docker run --env-file .env ansem-bot
```

### Vercel (Cron Function)

For Vercel deployment as a cron job (runs periodically instead of continuously):

1. Create `api/cron.ts` with the monitoring logic
2. Configure `vercel.json` with a cron schedule
3. Deploy via `vercel deploy`

> **Note**: Vercel's serverless functions have a 10-second timeout on the free tier. For continuous monitoring, Railway or a VPS is recommended.

## 🔍 Verifying the Bot

As this bot handles community funds, here's how to verify it's working correctly:

1. **Read the code**: Every file is extensively commented. Start with `src/index.ts` and follow the flow.
2. **Check the logs**: The bot logs every action with timestamps. Look for the buy-back and airdrop summaries.
3. **Verify on Solscan**: Every transaction signature is logged. Look them up on [solscan.io](https://solscan.io) to verify.
4. **Dry run first**: Set `DRY_RUN=true` to see what the bot *would* do without sending real transactions.
5. **Check the math**: The pro-rata distribution in `src/airdrop.ts` is heavily documented. Verify the formula.

## 📜 Token Details

- **Token**: $ANSEM
- **Mint Address**: `EPD8jj7bVhNh3o7Wx1XZ39aaacSki8p2ABaN61yhUnBh`
- **Platform**: Pump.fun CTO

## 🤝 Contributing

This is a community project. Contributions, audits, and suggestions are welcome!

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a Pull Request

## ⚠️ Disclaimer

This software is provided as-is. Use at your own risk. Always verify the code before deploying with real funds. The bot requires a private key — keep it secure and never share it.

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
