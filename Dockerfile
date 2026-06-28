# =============================================================================
# $ANSEM Buy-Back & Airdrop Bot — Docker Configuration
# =============================================================================
# Multi-stage build for a minimal, secure production image.
# =============================================================================

# --- Stage 1: Build ---
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (better layer caching)
COPY package.json package-lock.json* ./

# Install all dependencies (including devDependencies for TypeScript)
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript → JavaScript
RUN npm run build

# --- Stage 2: Production ---
FROM node:20-alpine AS production

# Security: run as non-root user
RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

WORKDIR /app

# Copy package files and install production dependencies only
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript from builder
COPY --from=builder /app/dist ./dist

# Switch to non-root user
USER botuser

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Start the bot
CMD ["node", "dist/index.js"]
