# Multi-stage build: pre-download nezha agent at build time
# This is critical for platforms with ephemeral filesystems (Sakura AppRun,
# Hanamii, etc.) where runtime downloads are unreliable.

# ============ Builder stage ============
FROM node:18-slim AS builder

# Install build-time deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Download nezha agent binary at build time.
# Try multiple mirrors in order - Japanese networks (Hanamii/Sakura) may have
# better luck with ghproxy mirrors than direct GitHub.
ARG NEZHA_ARCH=amd64
RUN set -e && \
    MIRRORS=" \
      https://gh-proxy.com/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip \
      https://mirror.ghproxy.com/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip \
      https://ghproxy.net/https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip \
      https://github.com/nezhahq/agent/releases/latest/download/nezha-agent_linux_${NEZHA_ARCH}.zip \
    " && \
    DOWNLOADED=0 && \
    for URL in $MIRRORS; do \
      echo "Trying: $URL"; \
      if curl -fsSL --max-time 180 -o /tmp/agent.zip "$URL"; then \
        SIZE=$(stat -c%s /tmp/agent.zip 2>/dev/null || wc -c < /tmp/agent.zip); \
        echo "Downloaded $SIZE bytes from $URL"; \
        if [ "$SIZE" -gt 1000000 ]; then \
          DOWNLOADED=1; \
          break; \
        fi; \
      fi; \
    done && \
    if [ "$DOWNLOADED" = "0" ]; then \
      echo "ERROR: All mirrors failed"; \
      exit 1; \
    fi && \
    unzip -o /tmp/agent.zip -d /build/ && \
    ls -la /build/ && \
    test -f /build/nezha-agent && \
    chmod 755 /build/nezha-agent && \
    rm -f /tmp/agent.zip

# ============ Runtime stage ============
FROM node:18-slim

# Install runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package.json and install deps
COPY package.json /app/package.json
RUN npm install --omit=dev

# Copy main program (obfuscated) and disguise page
COPY index.js /app/index.js
COPY index.html /app/index.html

# Copy pre-downloaded nezha agent binary from builder stage.
# Placed at /app/agent_cache/stfp - the exact path index.js looks for
# (AGENT_BIN = path.join(CACHE_DIR, 'stfp'), CACHE_DIR = /app/agent_cache).
# This means index.js will skip the runtime download step entirely.
COPY --from=builder /build/nezha-agent /app/agent_cache/stfp
RUN chmod 755 /app/agent_cache/stfp && \
    ls -la /app/agent_cache/stfp

# Create writable cache dirs (for dknz.png, config.yml, logs at runtime)
RUN mkdir -p /app/.npm_logs /app/.tmp_dl && \
    chmod -R 777 /app/.npm_logs /app/.tmp_dl /app/agent_cache

# Expose port (will be overridden by PORT env var on most platforms)
EXPOSE 4567

# Start command
CMD ["node", "index.js"]
